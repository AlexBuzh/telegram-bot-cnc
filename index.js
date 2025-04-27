import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import dotenv from 'dotenv';
import express from 'express';

// Загружаем переменные окружения
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Express сервер для поддержания работы Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Бот работает!');
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

// Авторизация в Google Sheets
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
await doc.useServiceAccountAuth({
  client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
});
await doc.loadInfo();
const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];

// Состояние для каждого пользователя
const userStates = new Map();

// Сброс вебхука перед стартом (главное исправление!)
async function resetWebhook() {
  try {
    await bot.deleteWebHook();
    console.log('Webhook удален. Переходим на polling...');
  } catch (error) {
    console.error('Ошибка при удалении webhook:', error);
  }
}
await resetWebhook();

// Команды бота
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, {});

  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates.get(chatId);

  if (!state) return;

  // Если имя еще не сохранено
  if (!state.name && msg.text !== '/start') {
    state.name = msg.text;
    userStates.set(chatId, state);

    // Загружаем таблицу
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const uniqueOrders = [...new Set(rows.map(row => row['Заказ']))];

    const orderButtons = uniqueOrders.map(order => [{ text: `${order}`, callback_data: `order_${order}` }]);

    await bot.sendMessage(chatId, 'Выберите заказ:', {
      reply_markup: { inline_keyboard: orderButtons },
    });
    return;
  }
});

// Ответы на кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const state = userStates.get(chatId);

  const data = query.data;

  if (data.startsWith('order_')) {
    // Выбор заказа
    const selectedOrder = data.replace('order_', '');
    state.selectedOrder = selectedOrder;
    userStates.set(chatId, state);

    const rows = await sheet.getRows();
    const formsAndSizes = rows
      .filter(row => row['Заказ'] == selectedOrder)
      .map(row => ({
        form: row['Форма'],
        size: row['Размер'],
        требуетсяЕще: row['Требуется еще'],
      }));

    const buttons = formsAndSizes.map((item, index) => [{
      text: `${item.form} (${item.size})`,
      callback_data: `formsize_${index}`,
    }]);

    state.formsAndSizes = formsAndSizes;
    userStates.set(chatId, state);

    await bot.sendMessage(chatId, 'Выберите форму и размер:', {
      reply_markup: { inline_keyboard: buttons },
    });
  } else if (data.startsWith('formsize_')) {
    // Выбор формы и размера
    const index = parseInt(data.replace('formsize_', ''), 10);
    const selectedItem = state.formsAndSizes[index];
    state.selectedForm = selectedItem.form;
    state.selectedSize = selectedItem.size;
    state.maxAmount = Number(selectedItem.требуетсяЕще) || 1;
    userStates.set(chatId, state);

    // Генерируем кнопки от 1 до Требуется еще
    const amountButtons = [];
    for (let i = 1; i <= state.maxAmount; i++) {
      amountButtons.push([{ text: `${i}`, callback_data: `amount_${i}` }]);
    }

    await bot.sendMessage(chatId, 'Сколько изделий сделали?', {
      reply_markup: { inline_keyboard: amountButtons },
    });
  } else if (data.startsWith('amount_')) {
    // Пользователь указал сколько сделал
    const amount = Number(data.replace('amount_', ''));
    state.amountDone = amount;
    userStates.set(chatId, state);

    // Теперь записываем в таблицу
    const rows = await sheet.getRows();
    const targetRow = rows.find(row =>
      row['Заказ'] == state.selectedOrder &&
      row['Форма'] == state.selectedForm &&
      row['Размер'] == state.selectedSize
    );

    if (targetRow) {
      const oldValue = Number(targetRow['Сделано']) || 0;
      const newValue = oldValue + amount;
      targetRow['Сделано'] = newValue;

      const требуется = Number(targetRow['Требуется']) || 0;
      const требуетсяЕще = Math.max(0, требуется - newValue);
      targetRow['Требуется еще'] = требуетсяЕще;

      await targetRow.save();

      await bot.sendMessage(chatId, `✅ Ваши данные сохранены!\n\nЗаказ: ${state.selectedOrder}\nФорма: ${state.selectedForm}\nРазмер: ${state.selectedSize}\nСделано: ${newValue}`);
    } else {
      await bot.sendMessage(chatId, '⚠️ Ошибка: не удалось найти запись в таблице.');
    }

    userStates.delete(chatId);
  }
});

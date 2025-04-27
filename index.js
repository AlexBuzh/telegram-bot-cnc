// index.js
import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
const port = process.env.PORT || 10000;

// Настройка Google Sheets
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
await doc.useServiceAccountAuth({
  client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
});
await doc.loadInfo();
const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];

const users = {}; // Сессии пользователей

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  users[chatId] = { step: 'awaiting_name' };
  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!users[chatId] || msg.text.startsWith('/start')) return;

  const session = users[chatId];

  if (session.step === 'awaiting_name') {
    session.name = text;
    session.step = 'awaiting_order';

    const rows = await sheet.getRows();
    const orders = [...new Set(rows.map(row => row['Заказ']))];

    const buttons = orders.map((order) => ([{ text: `${order}`, callback_data: `order_${order}` }]));

    await bot.sendMessage(chatId, 'Выберите заказ:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = users[chatId];

  if (!session) return;

  if (data.startsWith('order_') && session.step === 'awaiting_order') {
    const selectedOrder = data.split('order_')[1];
    session.order = selectedOrder;
    session.step = 'awaiting_form';

    const rows = await sheet.getRows();
    const formRows = rows.filter(row => row['Заказ'] == selectedOrder);
    session.availableForms = formRows;

    const buttons = formRows.map((row, index) => ([{
      text: `${row['Форма']} (${row['Размер']})`,
      callback_data: `form_${index}`
    }]));

    await bot.sendMessage(chatId, 'Выберите форму и размер:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith('form_') && session.step === 'awaiting_form') {
    const formIndex = parseInt(data.split('form_')[1]);
    const formRow = session.availableForms[formIndex];
    session.formRow = formRow;
    session.step = 'awaiting_quantity';

    const maxQuantity = parseInt(formRow['Требуется еще']);
    const buttons = [];
    for (let i = 1; i <= maxQuantity; i++) {
      buttons.push([{ text: `${i}`, callback_data: `qty_${i}` }]);
    }

    await bot.sendMessage(chatId, 'Сколько изделий сделано?', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith('qty_') && session.step === 'awaiting_quantity') {
    const quantity = parseInt(data.split('qty_')[1]);
    session.quantity = quantity;

    // Обновление Google Sheets
    const formRow = session.formRow;
    formRow['Сделано'] = quantity;
    formRow['Исполнитель'] = session.name;
    formRow['дата'] = new Date().toLocaleDateString('ru-RU');
    await formRow.save();

    await bot.sendMessage(chatId, `✅ Ваш результат:
Заказ: ${formRow['Заказ']}
Форма: ${formRow['Форма']}
Размер: ${formRow['Размер']}
Сделано: ${quantity}`);

    delete users[chatId];
  }

  await bot.answerCallbackQuery(query.id);
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

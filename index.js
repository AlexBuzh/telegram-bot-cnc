const { GoogleSpreadsheet } = require('google-spreadsheet');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// === Конфигурация ===
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Авторизация в Google Sheets
async function accessSpreadsheet() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  return doc.sheetsByIndex[0]; // Берем первый лист
}

// Получить доступные заказы
async function getAvailableOrders(sheet) {
  const rows = await sheet.getRows();
  const availableOrders = [];

  for (const row of rows) {
    const required = parseInt(row['Требуется']) || 0;
    const done = parseInt(row['Сделано']) || 0;
    const requiredMore = parseInt(row['Требуется еще']) || 0;

    const isAvailable = (done === 0) || (requiredMore > 0);

    if (isAvailable) {
      availableOrders.push({
        order: row['Заказ'],
        form: row['Форма'],
        size: row['Размер'],
        required: required,
        done: done,
        requiredMore: requiredMore
      });
    }
  }

  return availableOrders;
}

// Формирование текста для отправки
function formatOrdersMessage(orders) {
  if (orders.length === 0) {
    return 'Нет доступных заказов.';
  }

  let message = 'Доступные заказы:\n\n';
  orders.forEach((order, index) => {
    message += `#${index + 1}\n`;
    message += `Заказ: ${order.order}\n`;
    message += `Форма: ${order.form}\n`;
    message += `Размер: ${order.size}\n`;
    message += `Требуется: ${order.required}\n`;
    if (order.done > 0) {
      message += `Сделано: ${order.done}\n`;
    }
    if (order.requiredMore > 0) {
      message += `Осталось сделать: ${order.requiredMore}\n`;
    }
    message += `\n`;
  });

  return message;
}

// === Слушатель событий Telegram ===
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const sheet = await accessSpreadsheet();
    const availableOrders = await getAvailableOrders(sheet);
    const replyMessage = formatOrdersMessage(availableOrders);

    await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
    // здесь можно дополнительно обработать ввод имени пользователя
  } catch (error) {
    console.error('Ошибка:', error);
    await bot.sendMessage(chatId, 'Произошла ошибка при получении заказов.');
  }
});

// Обработка ввода имени
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.startsWith('/')) {
    // Это команда, пропускаем (например, /start уже обработан)
    return;
  }

  try {
    const sheet = await accessSpreadsheet();
    const availableOrders = await getAvailableOrders(sheet);
    const replyMessage = formatOrdersMessage(availableOrders);

    await bot.sendMessage(chatId, `Привет, ${text}!\n\n${replyMessage}`);
  } catch (error) {
    console.error('Ошибка:', error);
    await bot.sendMessage(chatId, 'Произошла ошибка при получении заказов.');
  }
});

// Запуск сервера (если нужен для Render.com или других платформ)
const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Бот работает');
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

// index.js

import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import 'dotenv/config';

const app = express();
app.use(bodyParser.json());

const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const serverUrl = process.env.SERVER_URL;
const spreadsheetId = process.env.SPREADSHEET_ID;
const sheetName = process.env.SHEET_NAME;
const googleClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`;
const WEBHOOK_URL = `${serverUrl}/webhook`;

let userStates = {}; // Храним состояния пользователей

async function setWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log('Webhook установлен');
  } catch (error) {
    console.error('Ошибка при установке webhook:', error.response?.data || error.message);
  }
}

async function getAvailableOrders() {
  const doc = new GoogleSpreadsheet(spreadsheetId);
  await doc.useServiceAccountAuth({
    client_email: googleClientEmail,
    private_key: googlePrivateKey,
  });

  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetName];
  const rows = await sheet.getRows();

  let availableOrders = [];

  rows.forEach(row => {
    const required = parseInt(row['Требуется'] || '0');
    const done = parseInt(row['Сделано'] || '0');

    if ((isNaN(done) || done === 0) && required > 0) {
      availableOrders.push({
        order: row['Заказ'],
        shape: row['Форма'],
        size: row['Размер'],
        required: required,
      });
    }
  });

  return availableOrders;
}

async function sendMessage(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
    });
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error.response?.data || error.message);
  }
}

app.post('/webhook', async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!userStates[chatId]) {
    userStates[chatId] = { step: 'start' };
  }

  const userState = userStates[chatId];

  if (text === '/start') {
    await sendMessage(chatId, 'Привет! Как тебя зовут?');
    userState.step = 'awaiting_name';
  } else if (userState.step === 'awaiting_name') {
    userState.name = text;
    userState.step = 'choosing_order';

    const orders = await getAvailableOrders();

    if (orders.length === 0) {
      await sendMessage(chatId, `Привет, ${userState.name}!
Нет доступных заказов.`);
      userState.step = 'start';
    } else {
      let messageText = `Привет, ${userState.name}!
Доступные заказы:\n`;

      orders.forEach((order, index) => {
        messageText += `\n#${index + 1}\nЗаказ: ${order.order}\nФорма: ${order.shape}\nРазмер: ${order.size}\nТребуется: ${order.required}\n`;
      });

      await sendMessage(chatId, messageText);
      await sendMessage(chatId, 'Введите номер заказа, который хотите выбрать:');

      userState.orders = orders;
      userState.step = 'awaiting_order_selection';
    }
  } else if (userState.step === 'awaiting_order_selection') {
    const selectedIndex = parseInt(text) - 1;

    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= userState.orders.length) {
      await sendMessage(chatId, 'Некорректный номер заказа. Попробуйте еще раз.');
    } else {
      const selectedOrder = userState.orders[selectedIndex];
      await sendMessage(chatId, `Вы выбрали:\nЗаказ: ${selectedOrder.order}\nФорма: ${selectedOrder.shape}\nРазмер: ${selectedOrder.size}`);
      userState.step = 'completed';
      // Здесь можно добавить дальнейшую логику: например, запись исполнителя, обновление таблицы и т.д.
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  await setWebhook();
});

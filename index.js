const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL; // твой адрес на Render, например: https://telegram-bot-cnc.onrender.com

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

let userState = {};

// Установка webhook при запуске сервера
async function setWebhook() {
  try {
    const url = `${TELEGRAM_API}/setWebhook?url=${SERVER_URL}`;
    const res = await axios.get(url);
    console.log('Webhook set result:', res.data);
  } catch (error) {
    console.error('Error setting webhook:', error.response ? error.response.data : error.message);
  }
}

app.post('/', async (req, res) => {
  const { message } = req.body;

  if (message && message.text) {
    const chatId = message.chat.id;
    const text = message.text.trim();

    await handleUserInput(chatId, text);
  }

  res.sendStatus(200);
});

async function handleUserInput(chatId, text) {
  if (text === '/start') {
    userState[chatId] = { step: 'askName' };
    await sendMessage(chatId, "Привет! Как тебя зовут?");
    return;
  }

  const user = userState[chatId];
  if (!user) {
    await sendMessage(chatId, "Напишите /start чтобы начать.");
    return;
  }

  if (user.step === 'askName') {
    user.name = text;
    user.step = 'chooseOrder';
    const orders = await getAvailableOrders();
    if (orders.length === 0) {
      await sendMessage(chatId, "Нет доступных заказов.");
      delete userState[chatId];
      return;
    }
    const buttons = orders.map(order => [{ text: order, callback_data: order }]);
    await sendMessage(chatId, "Выберите номер заказа:", buttons);
  }
}

async function sendMessage(chatId, text, buttons = null) {
  const payload = { chat_id: chatId, text: text };
  if (buttons) {
    payload.reply_markup = { inline_keyboard: buttons };
  }
  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

async function getAvailableOrders() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  const headers = rows[0];
  const data = rows.slice(1);

  const orderIndex = headers.indexOf('Заказ');
  const requiredIndex = headers.indexOf('Требуется еще');

  const activeOrders = new Set();
  data.forEach(row => {
    const order = row[orderIndex];
    const required = Number(row[requiredIndex] || 0);
    if (required > 0) {
      activeOrders.add(order);
    }
  });

  return [...activeOrders];
}

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await setWebhook(); // установим webhook при запуске
});

// Новый исправленный код index.js для твоего Telegram-бота

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = '7949948004:AAGmO4r9jJZNlhZwq8qrv8CX3sVq7-ZMDjg';
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

let userState = {}; // Состояние пользователей

app.post('/', async (req, res) => {
  const { message, callback_query } = req.body;

  try {
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const text = callback_query.data;
      await handleUserInput(chatId, text);
      return res.sendStatus(200);
    }

    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.trim();
      await handleUserInput(chatId, text);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка в обработке запроса:', err);
    res.sendStatus(500);
  }
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
    const orders = await getUniqueOrders();
    const buttons = orders.map(order => [{ text: order, callback_data: order }]);
    await sendMessage(chatId, "Выберите номер заказа:", buttons);

  } else if (user.step === 'chooseOrder') {
    user.order = text;
    user.step = 'chooseFormSize';
    const formsAndSizes = await getFormsAndSizes(user.order);
    if (formsAndSizes.length === 0) {
      await sendMessage(chatId, "Формы и размеры не найдены для этого заказа.");
      delete userState[chatId];
      return;
    }
    const buttons = formsAndSizes.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    await sendMessage(chatId, "Выберите форму и размер:", buttons);

  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'chooseQuantity';

    const quantities = await getAvailableQuantities(user.order, user.form, user.size);
    if (quantities.length === 0) {
      await sendMessage(chatId, "Нет доступного количества для выполнения этого изделия.");
      delete userState[chatId];
      return;
    }
    const buttons = quantities.map(q => [{ text: q.toString(), callback_data: q.toString() }]);
    await sendMessage(chatId, "Выберите количество:", buttons);

  } else if (user.step === 'chooseQuantity') {
    user.quantity = parseInt(text);
    await writeToSheet(user);
    await sendMessage(chatId, "✅ Данные успешно записаны! Спасибо!");
    delete userState[chatId];
  }
}

async function sendMessage(chatId, text, buttons = null) {
  const payload = { chat_id: chatId, text: text };
  if (buttons) {
    payload.reply_markup = { inline_keyboard: buttons };
  }
  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

async function getUniqueOrders() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];
  const orders = [...new Set(rows.slice(1).map(r => r[0]))];
  return orders.filter(Boolean);
}

async function getFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];

  return rows.slice(1)
    .filter(r => r[0] === order && (!r[4] || parseInt(r[4]) > 0))
    .map(r => ({ form: r[1], size: r[2] }));
}

async function getAvailableQuantities(order, form, size) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];

  const row = rows.find(r => r[0] === order && r[1] === form && r[2] === size);
  if (!row) return [];

  const required = parseInt(row[3]) || 0;
  const done = parseInt(row[5]) || 0;

  const remaining = required - done;

  return remaining > 0 ? Array.from({ length: remaining }, (_, i) => i + 1) : [];
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === user.order && row[1] === user.form && row[2] === user.size) {
      const currentDone = parseInt(row[5]) || 0;
      const updatedDone = currentDone + user.quantity;

      const date = new Date();
      const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!F${i + 1}:H${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[updatedDone, formattedDate, user.name]]
        }
      });
      break;
    }
  }
}

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

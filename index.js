// index.js

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});

const sheets = google.sheets({ version: 'v4', auth });

let userState = {};

app.post('/', async (req, res) => {
  const { message, callback_query } = req.body;

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
});

async function handleUserInput(chatId, text) {
  if (text === '/start') {
    userState[chatId] = { step: 'askName' };
    await sendMessage(chatId, 'Привет! Как тебя зовут?');
    return;
  }

  const user = userState[chatId];
  if (!user) {
    await sendMessage(chatId, 'Напишите /start чтобы начать.');
    return;
  }

  if (user.step === 'askName') {
    user.name = text;
    user.step = 'chooseOrder';
    await chooseOrder(chatId);
  } else if (user.step === 'chooseOrder') {
    user.order = text;
    user.step = 'chooseFormSize';
    await chooseFormSize(chatId, user.order);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'chooseQuantity';
    await chooseQuantity(chatId, user.order, user.form, user.size);
  } else if (user.step === 'chooseQuantity') {
    user.quantity = parseInt(text);
    await writeToSheet(user);

    await sendMessage(chatId, `✅ Данные записаны!\n\n👤 Исполнитель: ${user.name}\n📦 Заказ: ${user.order}\n🪴 Форма: ${user.form}\n📏 Размер: ${user.size}\n➕ Количество: ${user.quantity}`);

    user.step = 'awaitingContinueConfirmation';
    await sendButtons(chatId, 'Хотите продолжить?', [
      { text: '✅ Да', callback_data: 'continue' },
      { text: '❌ Нет', callback_data: 'exit' }
    ]);
  } else if (user.step === 'awaitingContinueConfirmation') {
    if (text === 'continue') {
      user.step = 'chooseOrder';
      await chooseOrder(chatId);
    } else if (text === 'exit') {
      await sendMessage(chatId, 'Спасибо за работу!');
      delete userState[chatId];
    } else {
      await sendMessage(chatId, 'Пожалуйста, выберите ✅ Да или ❌ Нет.');
    }
  }
}

async function chooseOrder(chatId) {
  const orders = await getAvailableOrders();
  if (orders.length === 0) {
    await sendMessage(chatId, 'Нет доступных заказов.');
    delete userState[chatId];
    return;
  }
  const buttons = orders.map(order => [{ text: order, callback_data: order }]);
  await sendButtons(chatId, 'Выберите номер заказа:', buttons);
}

async function chooseFormSize(chatId, order) {
  const formsAndSizes = await getAvailableFormsAndSizes(order);
  if (formsAndSizes.length === 0) {
    await sendMessage(chatId, 'Нет доступных форм и размеров для этого заказа.');
    userState[chatId].step = 'chooseOrder';
    await chooseOrder(chatId);
    return;
  }
  const buttons = formsAndSizes.map(item => [{ text: `${item.form}|${item.size}`, callback_data: `${item.form}|${item.size}` }]);
  await sendButtons(chatId, 'Выберите форму и размер:', buttons);
}

async function chooseQuantity(chatId, order, form, size) {
  const quantities = await getAvailableQuantities(order, form, size);
  const buttons = quantities.map(q => [{ text: `${q}`, callback_data: `${q}` }]);
  await sendButtons(chatId, 'Выберите количество:', buttons);
}

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: text });
}

async function sendButtons(chatId, text, buttons) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function getAvailableOrders() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  const orders = [...new Set(rows.slice(1)
    .filter(r => parseInt(r[4]) > 0)
    .map(r => r[0]))];
  return orders;
}

async function getAvailableFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  return rows.slice(1)
    .filter(r => r[0] === order && parseInt(r[4]) > 0)
    .map(r => ({ form: r[1], size: r[2] }));
}

async function getAvailableQuantities(order, form, size) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  const foundRow = rows.find(r => r[0] === order && r[1] === form && r[2] === size);
  if (foundRow) {
    const remaining = parseInt(foundRow[4]);
    return Array.from({ length: remaining }, (_, i) => i + 1);
  }
  return [];
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === user.order && rows[i][1] === user.form && rows[i][2] === user.size) {
      const required = parseInt(rows[i][3]) || 0;
      const done = (parseInt(rows[i][5]) || 0) + user.quantity;
      const remaining = Math.max(required - done, 0);

      const today = new Date();
      const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      const range = `${SHEET_NAME}!D${i + 1}:H${i + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[required, remaining, done, formattedDate, user.name]]
        }
      });

      return;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

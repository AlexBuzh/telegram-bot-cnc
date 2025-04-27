const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = process.env.TELEGRAM_TOKEN;
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
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
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
    const orders = await getAvailableOrders();
    const buttons = orders.map(order => [{ text: order, callback_data: order }]);
    if (buttons.length === 0) {
      await sendMessage(chatId, 'Нет доступных заказов.');
      delete userState[chatId];
      return;
    }
    await sendMessage(chatId, 'Выберите номер заказа:', buttons);
  } else if (user.step === 'chooseOrder') {
    user.order = text;
    user.step = 'chooseFormSize';
    const formsAndSizes = await getAvailableFormsAndSizes(user.order);
    const buttons = formsAndSizes.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    if (buttons.length === 0) {
      await sendMessage(chatId, 'Нет доступных форм и размеров для этого заказа.');
      delete userState[chatId];
      return;
    }
    await sendMessage(chatId, 'Выберите форму и размер:', buttons);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'chooseQuantity';

    const availableQuantity = await getAvailableQuantity(user);
    const quantityOptions = [];
    for (let i = 1; i <= availableQuantity; i++) {
      quantityOptions.push([{ text: `${i}`, callback_data: `${i}` }]);
    }
    await sendMessage(chatId, 'Выберите количество:', quantityOptions);
  } else if (user.step === 'chooseQuantity') {
    user.quantity = parseInt(text);
    await writeToSheet(user);
    await sendSummary(chatId, user);
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

async function sendSummary(chatId, user) {
  const summary = `✅ Готово!\n\nИсполнитель: ${user.name}\nЗаказ: ${user.order}\nФорма: ${user.form}\nРазмер: ${user.size}\nСделано: ${user.quantity}`;
  await sendMessage(chatId, summary);
}

async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  return res.data.values || [];
}

async function getAvailableOrders() {
  const rows = await getSheetRows();
  const header = rows[0];
  const orders = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const order = row[0];
    const required = parseInt(row[3] || 0);
    const done = parseInt(row[4] || 0);
    if (required > done) {
      orders[order] = true;
    }
  }

  return Object.keys(orders);
}

async function getAvailableFormsAndSizes(order) {
  const rows = await getSheetRows();
  const results = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === order) {
      const required = parseInt(row[3] || 0);
      const done = parseInt(row[4] || 0);
      if (required > done) {
        results.push({ form: row[1], size: row[2] });
      }
    }
  }

  return results;
}

async function getAvailableQuantity(user) {
  const rows = await getSheetRows();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === user.order && row[1] === user.form && row[2] === user.size) {
      const required = parseInt(row[3] || 0);
      const done = parseInt(row[4] || 0);
      return required - done;
    }
  }
  return 0;
}

async function writeToSheet(user) {
  const rows = await getSheetRows();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === user.order && row[1] === user.form && row[2] === user.size) {
      const required = parseInt(row[3] || 0);
      const done = parseInt(row[4] || 0);
      const newDone = done + user.quantity;
      const requiredStill = Math.max(required - newDone, 0);
      const today = new Date();
      const dateFormatted = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      const range = `${SHEET_NAME}!D${i + 1}:H${i + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[row[3], newDone, dateFormatted, user.name]]
        }
      });
      return;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = 'ТВОЙ_ТОКЕН_БОТА';
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
    await recalculateRemaining();
    user.step = 'chooseOrder';
    const orders = await getAvailableOrders();
    if (orders.length === 0) {
      await sendMessage(chatId, "Нет доступных заказов.");
      delete userState[chatId];
      return;
    }
    const buttons = orders.map(order => [{ text: order, callback_data: order }]);
    await sendMessage(chatId, "Выберите номер заказа:", buttons);
  } else if (user.step === 'chooseOrder') {
    user.order = text;
    user.step = 'chooseFormSize';
    const formsAndSizes = await getAvailableFormsAndSizes(user.order);
    if (formsAndSizes.length === 0) {
      await sendMessage(chatId, "Нет доступных изделий для этого заказа. Попробуйте снова.");
      user.step = 'chooseOrder';
      return;
    }
    const buttons = formsAndSizes.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    await sendMessage(chatId, "Выберите форму и размер:", buttons);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'chooseQuantity';
    const quantity = await getRemainingQuantity(user.order, user.form, user.size);
    const buttons = [[{ text: quantity.toString(), callback_data: quantity.toString() }]];
    await sendMessage(chatId, "Выберите количество:", buttons);
  } else if (user.step === 'chooseQuantity') {
    user.quantity = parseInt(text);
    await updateSheet(user);
    await sendMessage(chatId, `✅ Данные записаны!\n\nИмя: ${user.name}\nЗаказ: ${user.order}\nФорма: ${user.form}\nРазмер: ${user.size}\nСделано: ${user.quantity}`);
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

async function recalculateRemaining() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  const updates = rows.map((row, index) => {
    if (index === 0) return []; // Пропустить шапку
    const required = parseInt(row[3]) || 0; // Столбец D
    const done = parseInt(row[5]) || 0; // Столбец F
    const remaining = Math.max(required - done, 0);
    return [remaining];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!E3:E`,
    valueInputOption: 'RAW',
    requestBody: {
      values: updates.slice(2) // Пропустить шапку
    }
  });
}

async function getAvailableOrders() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  const available = rows.slice(2).filter(r => parseInt(r[4]) > 0);
  const uniqueOrders = [...new Set(available.map(r => r[0]))];
  return uniqueOrders;
}

async function getAvailableFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  return rows.slice(2)
    .filter(r => r[0] === order && parseInt(r[4]) > 0)
    .map(r => ({ form: r[1], size: r[2] }));
}

async function getRemainingQuantity(order, form, size) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  const item = rows.find(r => r[0] === order && r[1] === form && r[2] === size);
  return item ? parseInt(item[4]) : 1;
}

async function updateSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === user.order && row[1] === user.form && row[2] === user.size) {
      const made = (parseInt(row[5]) || 0) + user.quantity;
      const required = parseInt(row[3]) || 0;
      const remaining = Math.max(required - made, 0);
      const date = new Date();
      const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!E${i + 1}:H${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[remaining, made, formattedDate, user.name]]
        }
      });
      return;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

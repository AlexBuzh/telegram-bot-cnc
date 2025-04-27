// Новый index.js под обновлённую логику

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
      await sendMessage(chatId, "Все позиции по этому заказу уже выполнены! \u{1F389} Выберите другой заказ.");
      user.step = 'chooseOrder';
      const orders = await getUniqueOrders();
      const buttons = orders.map(order => [{ text: order, callback_data: order }]);
      await sendMessage(chatId, "Выберите номер заказа:", buttons);
      return;
    }
    const buttons = formsAndSizes.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    user.availableForms = formsAndSizes;
    await sendMessage(chatId, "Выберите форму и размер:", buttons);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    const selected = user.availableForms.find(f => f.form === form && f.size === size);
    if (!selected) {
      await sendMessage(chatId, "Неверный выбор. Пожалуйста, выберите форму и размер из списка.");
      return;
    }
    user.form = form;
    user.size = size;
    user.requiredAmount = selected.required;

    user.step = 'chooseQuantity';
    const quantityOptions = Array.from({ length: selected.required }, (_, i) => [{ text: `${i + 1}`, callback_data: `qty_${i + 1}` }]);
    await sendMessage(chatId, "Выберите количество для выполнения:", quantityOptions);
  } else if (user.step === 'chooseQuantity') {
    if (text.startsWith('qty_')) {
      const quantity = parseInt(text.replace('qty_', ''), 10);
      user.quantity = quantity;
      await writeToSheet(user);
      await sendMessage(chatId, "\u2705 Данные записаны! Спасибо!");
      delete userState[chatId];
    } else {
      await sendMessage(chatId, "Пожалуйста, выберите количество из предложенных вариантов.");
    }
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
  const rows = res.data.values;
  const orders = [...new Set(rows.slice(1).map(r => r[0]))];
  return orders.filter(Boolean);
}

async function getFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  return rows.slice(1)
    .filter(r => r[0] === order)
    .filter(r => {
      const required = parseInt(r[4], 10) || 0; // Требуется еще (новый столбец E)
      return required > 0;
    })
    .map(r => ({ form: r[1], size: r[2], required: parseInt(r[4], 10) }));
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === user.order && rows[i][1] === user.form && rows[i][2] === user.size) {
      const doneSoFar = parseInt(rows[i][5], 10) || 0;
      const newDone = doneSoFar + user.quantity;
      const requiredTotal = parseInt(rows[i][3], 10) || 0;
      const requiredLeft = Math.max(requiredTotal - newDone, 0);
      const date = new Date();
      const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

      const range = `${SHEET_NAME}!E${i + 1}:H${i + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[requiredLeft, newDone, formattedDate, user.name]]
        }
      });
      return;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

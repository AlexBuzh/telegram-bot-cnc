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
      await sendMessage(chatId, "Нет доступных форм и размеров для этого заказа.");
      delete userState[chatId];
      return;
    }
    const buttons = formsAndSizes.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    await sendMessage(chatId, "Выберите форму и размер:", buttons);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'askQuantity';
    user.availableQuantity = await getAvailableQuantity(user.order, form, size);
    const quantityOptions = [];
    for (let i = 1; i <= user.availableQuantity; i++) {
      quantityOptions.push([{ text: String(i), callback_data: String(i) }]);
    }
    await sendMessage(chatId, "Выберите количество:", quantityOptions);
  } else if (user.step === 'askQuantity') {
    user.quantity = parseInt(text);
    await writeToSheet(user);
    await sendMessage(chatId, `✅ Данные записаны!\n\nИсполнитель: ${user.name}\nЗаказ: ${user.order}\nФорма: ${user.form}\nРазмер: ${user.size}\nКоличество: ${user.quantity}`);
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

async function getAvailableOrders() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  const availableOrders = [];
  const orderMap = {};

  for (let i = 1; i < rows.length; i++) {
    const [order, , , required, needed, done] = rows[i];
    let need = parseInt(needed);
    if (isNaN(need)) {
      const requiredNum = parseInt(required) || 0;
      const doneNum = parseInt(done) || 0;
      need = requiredNum - doneNum;
    }
    if (need > 0) {
      orderMap[order] = true;
    }
  }

  return Object.keys(orderMap);
}

async function getAvailableFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  const formsAndSizes = [];

  for (let i = 1; i < rows.length; i++) {
    const [orderNum, form, size, required, needed, done] = rows[i];
    if (orderNum !== order) continue;
    let need = parseInt(needed);
    if (isNaN(need)) {
      const requiredNum = parseInt(required) || 0;
      const doneNum = parseInt(done) || 0;
      need = requiredNum - doneNum;
    }
    if (need > 0) {
      formsAndSizes.push({ form, size });
    }
  }
  return formsAndSizes;
}

async function getAvailableQuantity(order, form, size) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 1; i < rows.length; i++) {
    const [orderNum, formVal, sizeVal, required, needed, done] = rows[i];
    if (orderNum === order && formVal === form && sizeVal === size) {
      let need = parseInt(needed);
      if (isNaN(need)) {
        const requiredNum = parseInt(required) || 0;
        const doneNum = parseInt(done) || 0;
        need = requiredNum - doneNum;
      }
      return need;
    }
  }
  return 0;
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 1; i < rows.length; i++) {
    const [orderNum, formVal, sizeVal, required, needed, done] = rows[i];
    if (orderNum === user.order && formVal === user.form && sizeVal === user.size) {
      let requiredNum = parseInt(required) || 0;
      let doneNum = parseInt(done) || 0;

      doneNum += user.quantity;
      const leftToDo = Math.max(0, requiredNum - doneNum);

      const range = `${SHEET_NAME}!D${i + 1}:H${i + 1}`;
      const today = new Date();
      const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[requiredNum, leftToDo, doneNum, formattedDate, user.name]]
        }
      });

      break;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

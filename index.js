const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = '7949948004:AAGmO4r9jJZNlhZwq8qrv8CX3sVq7-ZMDjg'; // <-- Замени токен если нужен другой
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
    const data = callback_query.data;
    await handleUserInput(chatId, data);
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
    await sendMessage(chatId, "Напиши /start чтобы начать.");
    return;
  }

  if (user.step === 'askName') {
    user.name = text;
    user.step = 'chooseOrder';
    const orders = await getAvailableOrders();
    if (orders.length === 0) {
      await sendMessage(chatId, "Нет доступных заказов.");
      return;
    }
    const buttons = orders.map(order => [{ text: order, callback_data: order }]);
    await sendMessage(chatId, "Выберите номер заказа:", buttons);
  } else if (user.step === 'chooseOrder') {
    user.order = text;
    user.step = 'chooseFormSize';
    const formSizeOptions = await getAvailableFormsAndSizes(user.order);
    if (formSizeOptions.length === 0) {
      await sendMessage(chatId, "Нет доступных позиций для выбранного заказа. Попробуйте выбрать другой заказ.");
      user.step = 'chooseOrder';
      return;
    }
    const buttons = formSizeOptions.map(item => [{ text: `${item.form} - ${item.size}`, callback_data: `${item.form}|${item.size}` }]);
    await sendMessage(chatId, "Выберите форму и размер:", buttons);
  } else if (user.step === 'chooseFormSize') {
    const [form, size] = text.split('|');
    user.form = form;
    user.size = size;
    user.step = 'confirmQuantity';
    await sendMessage(chatId, "Подтвердите количество, которое сделано:");
  } else if (user.step === 'confirmQuantity') {
    user.quantity = parseInt(text.trim(), 10);
    if (isNaN(user.quantity) || user.quantity <= 0) {
      await sendMessage(chatId, "Введите корректное число!");
      return;
    }
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

async function getSheetData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
  });
  return res.data.values || [];
}

async function getAvailableOrders() {
  const rows = await getSheetData();
  const orders = rows.slice(1)
    .filter(r => (parseInt(r[4]) || 0) > 0) // Только там, где требуется еще > 0
    .map(r => r[0]);

  return [...new Set(orders)];
}

async function getAvailableFormsAndSizes(order) {
  const rows = await getSheetData();
  return rows.slice(1)
    .filter(r => r[0] === order && (parseInt(r[4]) || 0) > 0)
    .map(r => ({ form: r[1], size: r[2] }));
}

async function writeToSheet(user) {
  const rows = await getSheetData();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === user.order && rows[i][1] === user.form && rows[i][2] === user.size) {
      let currentDone = parseInt(rows[i][5]) || 0;
      let currentRequired = parseInt(rows[i][3]) || 0;
      let newDone = currentDone + user.quantity;
      let requiredLeft = Math.max(0, currentRequired - newDone);

      const range = `${SHEET_NAME}!D${i+1}:H${i+1}`;
      const dateNow = new Date();
      const formattedDate = `${String(dateNow.getDate()).padStart(2, '0')}/${String(dateNow.getMonth() + 1).padStart(2, '0')}/${dateNow.getFullYear()}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            [
              currentRequired,
              requiredLeft,
              newDone,
              formattedDate,
              user.name
            ]
          ]
        }
      });
      break;
    }
  }
}

async function sendSummary(chatId, user) {
  const text = `✅ Записано:
- Исполнитель: ${user.name}
- Заказ: ${user.order}
- Форма: ${user.form}
- Размер: ${user.size}
- Сделано: ${user.quantity}`;
  await sendMessage(chatId, text);
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

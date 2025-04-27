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

app.get('/ping', (req, res) => {
  res.send('pong');
});

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
      await sendMessage(chatId, "Формы и размеры не найдены для этого заказа. Попробуйте снова.");
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
    await sendMessage(chatId, "Укажите количество:");
  } else if (user.step === 'askQuantity') {
    user.quantity = parseInt(text);
    if (isNaN(user.quantity) || user.quantity <= 0) {
      await sendMessage(chatId, "Пожалуйста, укажите корректное число.");
      return;
    }
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
  const rows = res.data.values || [];
  const orders = [...new Set(rows.slice(1)
    .filter(r => (parseInt(r[4]) || 0) > 0)
    .map(r => r[0]))];
  return orders;
}

async function getAvailableFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];
  return rows.slice(1)
    .filter(r => r[0] === order && (parseInt(r[4]) || 0) > 0)
    .map(r => ({ form: r[1], size: r[2] }));
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === user.order && rows[i][1] === user.form && rows[i][2] === user.size) {
      const done = parseInt(rows[i][5] || '0') + user.quantity;
      const required = parseInt(rows[i][3] || '0');
      const remaining = Math.max(required - done, 0);
      const date = new Date();
      const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!E${i + 1}:H${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[remaining, done, formattedDate, user.name]]
        }
      });
      return;
    }
  }
}

// === Авто-пинг каждые 4 минуты ===
setInterval(() => {
  axios.get('https://telegram-bot-cnc.onrender.com/ping')
    .then(() => console.log('Pinged self to stay awake'))
    .catch((err) => console.error('Error pinging self:', err.message));
}, 240000); // 4 минуты

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

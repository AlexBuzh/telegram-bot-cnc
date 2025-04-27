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

// ➡️ Новый маршрут /ping для проверки живости бота
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
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
    const formsAndSizes = await getFormsAndSizes(user.order);
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
    const quantityOptions = await getQuantityOptions(user.order, user.form, user.size);
    if (quantityOptions.length === 0) {
      await sendMessage(chatId, "Нет доступных количеств для выбранной формы и размера.");
      delete userState[chatId];
      return;
    }
    const buttons = quantityOptions.map(q => [{ text: q.toString(), callback_data: q.toString() }]);
    await sendMessage(chatId, "Выберите количество:", buttons);
  } else if (user.step === 'askQuantity') {
    user.quantity = parseInt(text, 10);
    await writeToSheet(user);
    await sendMessage(chatId, `✅ Записано:\n- Исполнитель: ${user.name}\n- Заказ: ${user.order}\n- Форма: ${user.form}\n- Размер: ${user.size}\n- Количество: ${user.quantity}`);
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
  const orders = new Set();
  for (let i = 1; i < rows.length; i++) {
    const requiredMore = parseInt(rows[i][4] || '0', 10);
    if (requiredMore > 0) {
      orders.add(rows[i][0]);
    }
  }
  return [...orders];
}

async function getFormsAndSizes(order) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  return rows.slice(1)
    .filter(r => r[0] === order && parseInt(r[4] || '0', 10) > 0)
    .map(r => ({ form: r[1], size: r[2] }));
}

async function getQuantityOptions(order, form, size) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === order && rows[i][1] === form && rows[i][2] === size) {
      const requiredMore = parseInt(rows[i][4] || '0', 10);
      return Array.from({ length: requiredMore }, (_, idx) => idx + 1);
    }
  }
  return [];
}

async function writeToSheet(user) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === user.order && rows[i][1] === user.form && rows[i][2] === user.size) {
      let required = parseInt(rows[i][3] || '0', 10);
      let done = parseInt(rows[i][5] || '0', 10);
      let requiredMore = required - done;

      done += user.quantity;
      requiredMore = Math.max(0, required - done);

      const range = `${SHEET_NAME}!E${i + 1}:H${i + 1}`;
      const date = new Date();
      const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            [requiredMore, done, formattedDate, user.name]
          ]
        }
      });

      return;
    }
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');

const TOKEN = '7949948004:AAGmO4r9jJZNlhZwq8qrv8CX3sVq7-ZMDjg';
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const DATA_FILE = 'user_data.json';

let userState = {};
if (fs.existsSync(DATA_FILE)) {
  userState = JSON.parse(fs.readFileSync(DATA_FILE));
}

app.post('/', async (req, res) => {
  const { message, callback_query } = req.body;

  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const text = callback_query.data;

    await handleMessage(chatId, text);
    return res.sendStatus(200);
  }

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  await handleMessage(chatId, text);

  res.sendStatus(200);
});

async function handleMessage(chatId, text) {
  if (text === '/start') {
    userState[chatId] = { step: 'askName' };
    saveUserState();
    await sendMessage(chatId, "Привет! Как тебя зовут?");
  } else {
    const user = userState[chatId];

    if (!user) {
      await sendMessage(chatId, "Напиши /start, чтобы начать.");
    } else if (user.step === 'askName') {
      user.name = text;
      user.step = 'askOrder';
      saveUserState();
      await sendMessage(chatId, "Выбери номер заказа:", [
        [{ text: "Заказ 1", callback_data: "Заказ 1" }, { text: "Заказ 2", callback_data: "Заказ 2" }]
      ]);
    } else if (user.step === 'askOrder') {
      user.order = text;
      user.step = 'askForm';
      saveUserState();
      await sendMessage(chatId, "Выбери форму:", [
        [{ text: "Круглая", callback_data: "Круглая" }, { text: "Квадратная", callback_data: "Квадратная" }]
      ]);
    } else if (user.step === 'askForm') {
      user.form = text;
      user.step = 'askSize';
      saveUserState();
      await sendMessage(chatId, "Выбери размер:");
    } else if (user.step === 'askSize') {
      user.size = text;
      user.step = 'askQuantity';
      saveUserState();
      await sendMessage(chatId, "Укажи количество:");
    } else if (user.step === 'askQuantity') {
      user.quantity = text;
      await sendMessage(chatId, `✅ Готово! Данные собраны:  
- Имя: ${user.name}
- Заказ: ${user.order}
- Форма: ${user.form}
- Размер: ${user.size}
- Количество: ${user.quantity}`);
      delete userState[chatId];
      saveUserState();
    }
  }
}

async function sendMessage(chatId, text, buttons = null) {
  const payload = {
    chat_id: chatId,
    text: text,
  };
  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: buttons,
    };
  }
  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

function saveUserState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(userState));
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const TOKEN = '7949948004:AAGmO4r9jJZNlhZwq8qrv8CX3sVq7-ZMDjg';
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

let userState = {};

app.post('/', async (req, res) => {
  const { message } = req.body;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/start') {
    userState[chatId] = { step: 'askName' };
    await sendMessage(chatId, "Привет! Как тебя зовут?");
  } else {
    const user = userState[chatId];

    if (!user) {
      await sendMessage(chatId, "Напиши /start, чтобы начать.");
    } else if (user.step === 'askName') {
      user.name = text;
      user.step = 'askOrder';
      await sendMessage(chatId, "Выбери номер заказа:");
    } else if (user.step === 'askOrder') {
      user.order = text;
      user.step = 'askForm';
      await sendMessage(chatId, "Выбери форму:");
    } else if (user.step === 'askForm') {
      user.form = text;
      user.step = 'askSize';
      await sendMessage(chatId, "Выбери размер:");
    } else if (user.step === 'askSize') {
      user.size = text;
      user.step = 'askQuantity';
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
    }
  }

  res.sendStatus(200);
});

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text,
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
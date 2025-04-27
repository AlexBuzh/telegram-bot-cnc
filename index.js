// index.js

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import express from 'express';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Подключение к Google таблице
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
await doc.useServiceAccountAuth({
  client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
});
await doc.loadInfo();
const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];

console.log('Таблица успешно загружена.');

// Хранилище сессий
const sessions = new Map();

// Время ожидания ответа
const TIMEOUT_MS = 30000;

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  sessions.set(chatId, { step: 'waiting_for_name' });

  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');

  setTimeout(() => {
    const session = sessions.get(chatId);
    if (session && session.step === 'waiting_for_name') {
      bot.sendMessage(chatId, `${session.name || 'Пользователь'}, вы не ответили. Сеанс завершен. Нажмите /start для нового начала.`);
      sessions.delete(chatId);
    }
  }, TIMEOUT_MS);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (!session) return;

  if (session.step === 'waiting_for_name' && msg.text !== '/start') {
    session.name = msg.text;
    session.step = 'waiting_for_order';

    const rows = await sheet.getRows();
    const availableOrders = rows
      .map((row, index) => ({
        index: index + 1,
        order: row['Заказ'],
        shape: row['Форма'],
        size: row['Размер'],
        required: row['Требуется'],
        done: row['Сделано'],
      }))
      .filter((row) => !row.done || row.done === '0');

    if (availableOrders.length === 0) {
      await bot.sendMessage(chatId, 'Нет доступных заказов.');
      sessions.delete(chatId);
      return;
    }

    const buttons = availableOrders.map((order) => ([{
      text: `#${order.index} ${order.shape} (${order.size})`,
      callback_data: String(order.index),
    }]));

    session.availableOrders = availableOrders;

    await bot.sendMessage(chatId, 'Выбери заказ:', {
      reply_markup: {
        inline_keyboard: buttons,
      },
    });

    setTimeout(() => {
      const session = sessions.get(chatId);
      if (session && session.step === 'waiting_for_order') {
        bot.sendMessage(chatId, `${session.name}, вы не выбрали заказ. Сеанс завершен. Нажмите /start для нового начала.`);
        sessions.delete(chatId);
      }
    }, TIMEOUT_MS);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const session = sessions.get(chatId);

  if (!session) return;

  if (session.step === 'waiting_for_order') {
    const selectedOrder = session.availableOrders.find((o) => String(o.index) === query.data);

    if (!selectedOrder) {
      await bot.sendMessage(chatId, 'Выбранный заказ не найден.');
      return;
    }

    await bot.sendMessage(chatId, `Вы выбрали заказ ${selectedOrder.order}:\nФорма: ${selectedOrder.shape}\nРазмер: ${selectedOrder.size}\nТребуется: ${selectedOrder.required}`);
    sessions.delete(chatId);
  }

  await bot.answerCallbackQuery(query.id);
});

app.get('/', (req, res) => {
  res.send('Бот запущен');
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

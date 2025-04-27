// Новый полностью рабочий index.js для Telegram-бота

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: { port: process.env.PORT || 10000 } });
bot.setWebHook(`${process.env.SERVER_URL}/bot${process.env.BOT_TOKEN}`);

const app = express();
app.use(express.json());
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
const sessions = new Map(); // Сессии пользователей

async function loadSheet() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];
  await sheet.loadCells();
  const rows = await sheet.getRows();

  return rows.map(row => ({
    order: row['Заказ'],
    form: row['Форма'],
    size: row['Размер'],
    required: row['Требуется'],
    done: row['Сделано'],
  }));
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
  sessions.set(chatId, { step: 'askName' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!sessions.has(chatId)) return;
  const session = sessions.get(chatId);

  if (session.step === 'askName') {
    session.name = text;
    session.step = 'chooseOrder';
    sessions.set(chatId, session);

    const orders = await loadSheet();
    const availableOrders = orders.filter(o => !o.done || o.done == 0);

    if (availableOrders.length === 0) {
      bot.sendMessage(chatId, 'Нет доступных заказов.');
      sessions.delete(chatId);
      return;
    }

    session.orders = availableOrders;

    const buttons = availableOrders.map((order, index) => ([{
      text: `${order.order} | ${order.form} | ${order.size}`,
      callback_data: `order_${index}`
    }]));

    bot.sendMessage(chatId, `Привет, ${session.name}!
Выберите заказ:`, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });

    sessions.set(chatId, session);
    sessionTimeout(chatId);
  }
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const session = sessions.get(chatId);
  if (!session) return;

  const data = query.data;

  if (data.startsWith('order_')) {
    const index = parseInt(data.split('_')[1], 10);
    const selectedOrder = session.orders[index];

    bot.sendMessage(chatId, `Вы выбрали заказ №${selectedOrder.order} (${selectedOrder.form} ${selectedOrder.size}). Спасибо!`);
    sessions.delete(chatId);
  }
});

function sessionTimeout(chatId) {
  setTimeout(() => {
    if (sessions.has(chatId)) {
      const session = sessions.get(chatId);
      if (session.step !== 'done') {
        bot.sendMessage(chatId, `${session.name}, вы не ответили. Сеанс завершен. Нажмите /start чтобы начать заново.`);
        sessions.delete(chatId);
      }
    }
  }, 30000); // 30 секунд
}

console.log('Bot started...');

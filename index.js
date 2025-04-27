// index.js

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import fetch from 'node-fetch';

// Подгружаем переменные из .env
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;
const SERVER_URL = process.env.SERVER_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();

app.use(bodyParser.json());

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${SERVER_URL}/bot${BOT_TOKEN}` }),
    });
    console.log('Webhook has been set successfully.');
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
  bot.once('message', async (nameMsg) => {
    const userName = nameMsg.text;
    bot.sendMessage(chatId, `Привет, ${userName}!
\nДоступные заказы:`);

    try {
      const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
      await doc.useServiceAccountAuth({
        client_email: GOOGLE_CLIENT_EMAIL,
        private_key: GOOGLE_PRIVATE_KEY,
      });
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[SHEET_NAME];
      const rows = await sheet.getRows();

      const availableOrders = rows.filter(row => {
        const done = parseInt(row['Сделано'] || '0', 10);
        const required = parseInt(row['Требуется'] || '0', 10);
        return done < required;
      });

      if (availableOrders.length === 0) {
        bot.sendMessage(chatId, 'Нет доступных заказов.');
        return;
      }

      let messageText = '';
      availableOrders.forEach((order, index) => {
        messageText += `\n#${index + 1}\nЗаказ: ${order['Заказ']}\nФорма: ${order['Форма']}\nРазмер: ${order['Размер']}\nТребуется: ${order['Требуется']}\n\n`;
      });

      bot.sendMessage(chatId, messageText);
    } catch (err) {
      console.error('Ошибка при получении данных из Google Sheets:', err);
      bot.sendMessage(chatId, 'Ошибка при получении данных.');
    }
  });
});

// index.js

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const app = express();
const port = process.env.PORT || 3000;

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

async function accessSpreadsheet() {
  try {
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();
    console.log('Таблица успешно загружена.');
  } catch (error) {
    console.error('Ошибка при доступе к таблице:', error);
  }
}

accessSpreadsheet();

const userStates = {};

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'askName' };

  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userState = userStates[chatId];

  if (!userState) return;

  if (userState.step === 'askName' && msg.text !== '/start') {
    userState.name = msg.text;
    userState.step = 'selectOrder';

    try {
      const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];
      if (!sheet) {
        await bot.sendMessage(chatId, 'Ошибка: лист с заказами не найден.');
        return;
      }

      const rows = await sheet.getRows();
      const availableOrders = rows.filter(row => {
        const required = parseInt(row['Требуется']);
        const done = parseInt(row['Сделано'] || '0');
        return required > done;
      });

      if (availableOrders.length === 0) {
        await bot.sendMessage(chatId, 'Нет доступных заказов.');
        return;
      }

      let ordersText = 'Доступные заказы:\n';
      availableOrders.forEach((order, index) => {
        ordersText += `\n#${index + 1}\nЗаказ: ${order['Заказ']}\nФорма: ${order['Форма']}\nРазмер: ${order['Размер']}\nТребуется: ${order['Требуется']}\n`;
      });

      await bot.sendMessage(chatId, ordersText);
      await bot.sendMessage(chatId, 'Пожалуйста, выбери номер заказа.');

      userState.orders = availableOrders;
      userState.step = 'chooseOrder';

      // Таймер на 30 секунд
      userState.timeout = setTimeout(() => {
        if (userStates[chatId]?.step === 'chooseOrder') {
          bot.sendMessage(chatId, `${userState.name}, вы не ответили. Сеанс завершен. Нажмите /start чтобы начать снова.`);
          delete userStates[chatId];
        }
      }, 30000);

    } catch (error) {
      console.error('Ошибка при получении заказов:', error);
      await bot.sendMessage(chatId, 'Ошибка при получении заказов. Попробуйте позже.');
    }
  } else if (userState.step === 'chooseOrder') {
    clearTimeout(userState.timeout);

    const choice = parseInt(msg.text);
    if (!choice || choice < 1 || choice > userState.orders.length) {
      await bot.sendMessage(chatId, 'Пожалуйста, выбери правильный номер заказа.');
      return;
    }

    const selectedOrder = userState.orders[choice - 1];

    await bot.sendMessage(chatId, `Вы выбрали заказ:\nЗаказ: ${selectedOrder['Заказ']}\nФорма: ${selectedOrder['Форма']}\nРазмер: ${selectedOrder['Размер']}\n`);

    delete userStates[chatId];
  }
});

app.get('/', (req, res) => {
  res.send('Бот работает.');
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

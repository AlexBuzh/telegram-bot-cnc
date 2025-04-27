// index.js

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
const port = process.env.PORT || 3000;

const sheetId = process.env.GOOGLE_SHEET_ID;
const sheetName = process.env.SHEET_NAME;
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

const userState = {};

async function loadSheet() {
  const doc = new GoogleSpreadsheet(sheetId);
  await doc.useServiceAccountAuth({
    client_email: serviceAccountEmail,
    private_key: privateKey,
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetName];
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  return { sheet, rows };
}

function startTimeout(chatId) {
  if (userState[chatId]?.timeout) clearTimeout(userState[chatId].timeout);
  userState[chatId].timeout = setTimeout(() => {
    bot.sendMessage(chatId, `${userState[chatId]?.name || 'Пользователь'}, вы не ответили. Сеанс завершён. Нажмите /start для нового сеанса.`);
    delete userState[chatId];
  }, 30000);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = {};
  bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
  startTimeout(chatId);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userState[chatId] || text.startsWith('/start')) return;

  if (!userState[chatId].name) {
    userState[chatId].name = text;
    const { rows } = await loadSheet();
    const uniqueOrders = [...new Set(rows.map(r => r['Заказ']))];

    const keyboard = uniqueOrders.map(order => ([{ text: `${order}` }]));
    bot.sendMessage(chatId, 'Выберите номер заказа:', {
      reply_markup: { keyboard, one_time_keyboard: true, resize_keyboard: true },
    });
    startTimeout(chatId);
    return;
  }

  if (!userState[chatId].order) {
    userState[chatId].order = text;
    const { rows } = await loadSheet();
    const variants = rows.filter(r => r['Заказ'] == text && (!r['Сделано'] || parseInt(r['Сделано']) < parseInt(r['Требуется'])));

    if (variants.length === 0) {
      bot.sendMessage(chatId, 'Нет доступных форм и размеров для этого заказа. Нажмите /start.');
      delete userState[chatId];
      return;
    }

    const keyboard = variants.map(r => ([{ text: `${r['Форма']} (${r['Размер']})` }]));
    userState[chatId].variants = variants;

    bot.sendMessage(chatId, 'Выберите форму и размер:', {
      reply_markup: { keyboard, one_time_keyboard: true, resize_keyboard: true },
    });
    startTimeout(chatId);
    return;
  }

  if (!userState[chatId].shapeSize) {
    userState[chatId].shapeSize = text;
    const variant = userState[chatId].variants.find(v => `${v['Форма']} (${v['Размер']})` === text);

    if (!variant) {
      bot.sendMessage(chatId, 'Ошибка выбора формы и размера. Нажмите /start.');
      delete userState[chatId];
      return;
    }

    const max = parseInt(variant['Требуется еще'] || variant['Требуется']);
    const keyboard = [];
    for (let i = 1; i <= max; i++) {
      keyboard.push([{ text: `${i}` }]);
    }

    userState[chatId].selectedVariant = variant;

    bot.sendMessage(chatId, 'Сколько изделий сделано?', {
      reply_markup: { keyboard, one_time_keyboard: true, resize_keyboard: true },
    });
    startTimeout(chatId);
    return;
  }

  if (!userState[chatId].done) {
    const done = parseInt(text);
    if (isNaN(done)) {
      bot.sendMessage(chatId, 'Пожалуйста, выберите количество из списка.');
      startTimeout(chatId);
      return;
    }

    const { sheet } = await loadSheet();
    const rows = await sheet.getRows();

    const row = rows.find(r => r['Заказ'] == userState[chatId].order && `${r['Форма']} (${r['Размер']})` === userState[chatId].shapeSize);

    if (row) {
      row['Исполнитель'] = userState[chatId].name;
      row['Сделано'] = done;
      row['Требуется еще'] = parseInt(row['Требуется']) - done;
      await row.save();

      bot.sendMessage(chatId, `✅ Данные сохранены:\nЗаказ: ${row['Заказ']}\nФорма: ${row['Форма']}\nРазмер: ${row['Размер']}\nСделано: ${done}`);
    } else {
      bot.sendMessage(chatId, 'Ошибка сохранения данных. Попробуйте снова.');
    }

    delete userState[chatId];
  }
});

app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

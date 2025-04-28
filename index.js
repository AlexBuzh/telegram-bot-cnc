// index.js

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import dotenv from 'dotenv';
import express from 'express';
dotenv.config();

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN);

// Webhook путь
const WEBHOOK_PATH = '/webhook';

// Устанавливаем webhook
const DOMAIN = 'https://telegram-bot-cnc.onrender.com'; // твой домен Render
bot.setWebHook(`${DOMAIN}${WEBHOOK_PATH}`);

app.use(express.json());
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Подключение к Google Sheets
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
const sessions = new Map();

async function accessSheet() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[process.env.SHEET_NAME];
  await sheet.loadHeaderRow();
  return sheet;
}

// Логика бота — БЕЗ изменений
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  sessions.set(chatId, {});
  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (!session) return;

  if (!session.name && msg.text && msg.text !== '/start') {
    session.name = msg.text;
    const sheet = await accessSheet();
    const rows = await sheet.getRows();

    const uniqueOrders = [...new Set(rows.map(row => row['Заказ']))].filter(Boolean);

    session.allOrders = uniqueOrders;
    await bot.sendMessage(chatId, 'Выберите заказ:', {
      reply_markup: {
        keyboard: uniqueOrders.map(order => [{ text: order }]),
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
  else if (session.name && !session.order && msg.text) {
    session.order = msg.text;
    const sheet = await accessSheet();
    const rows = await sheet.getRows();

    const shapesAndSizes = rows
      .filter(row => row['Заказ'] == session.order && parseInt(row['Требуется еще']) > 0)
      .map(row => `${row['Форма']} (${row['Размер']})`);

    if (shapesAndSizes.length === 0) {
      await bot.sendMessage(chatId, 'Все изделия по этому заказу уже сделаны. Попробуйте другой заказ.');
      sessions.delete(chatId);
      return;
    }

    session.shapesAndSizes = shapesAndSizes;

    await bot.sendMessage(chatId, 'Выберите форму и размер:', {
      reply_markup: {
        keyboard: shapesAndSizes.map(shape => [{ text: shape }]),
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
  else if (session.order && !session.shapeAndSize && msg.text) {
    session.shapeAndSize = msg.text;

    const sheet = await accessSheet();
    const rows = await sheet.getRows();

    const [shape, size] = session.shapeAndSize.split(' (');
    const sizeClean = size?.replace(')', '');

    const targetRow = rows.find(row => 
      row['Заказ'] == session.order && 
      row['Форма'] == shape && 
      row['Размер'] == sizeClean
    );

    if (!targetRow) {
      await bot.sendMessage(chatId, 'Не найдено сочетание заказа, формы и размера. Попробуйте сначала.');
      sessions.delete(chatId);
      return;
    }

    const requiredLeft = parseInt(targetRow['Требуется еще']);

    if (!requiredLeft || requiredLeft <= 0) {
      await bot.sendMessage(chatId, 'По этому изделию все уже сделано! Выберите другое.');
      sessions.delete(chatId);
      return;
    }

    session.targetRow = targetRow;
    session.requiredLeft = requiredLeft;

    const quantityOptions = Array.from({ length: requiredLeft }, (_, i) => (i + 1).toString());

    await bot.sendMessage(chatId, 'Сколько изделий сделано?', {
      reply_markup: {
        keyboard: quantityOptions.map(q => [{ text: q }]),
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
  else if (session.shapeAndSize && !session.quantity && msg.text) {
    const quantity = parseInt(msg.text);

    if (isNaN(quantity) || quantity <= 0 || quantity > session.requiredLeft) {
      await bot.sendMessage(chatId, `Введите число от 1 до ${session.requiredLeft}`);
      return;
    }

    session.quantity = quantity;

    const previousDone = parseInt(session.targetRow['Сделано']) || 0;
    session.targetRow['Сделано'] = previousDone + quantity;

    await session.targetRow.save();

    await bot.sendMessage(chatId, `✅ Ваш результат:\nЗаказ: ${session.order}\nФорма: ${session.targetRow['Форма']}\nРазмер: ${session.targetRow['Размер']}\nСделано: ${session.targetRow['Сделано']}`);

    sessions.delete(chatId);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

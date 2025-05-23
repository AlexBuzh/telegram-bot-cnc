// index.js

import TelegramBot from 'node-telegram-bot-api';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import dotenv from 'dotenv';
import express from 'express';
dotenv.config();

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN);

const WEBHOOK_PATH = '/webhook';
const DOMAIN = 'https://telegram-bot-cnc.onrender.com';
bot.setWebHook(`${DOMAIN}${WEBHOOK_PATH}`);

app.use(express.json());
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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

// Старт бота
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  sessions.set(chatId, { step: 'waiting_name' });
  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

// Принимаем только имя
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (!session) return;

  if (session.step === 'waiting_name' && msg.text && msg.text !== '/start') {
    session.name = msg.text;
    await sendAvailableOrders(chatId, session);
  }
});

// Работаем только с кнопками
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const session = sessions.get(chatId);

  if (!session) return;

  if (data.startsWith('order_')) {
    session.order = data.replace('order_', '');
    const sheet = await accessSheet();
    const rows = await sheet.getRows();

    const shapesAndSizes = rows
      .filter(row => row['Заказ'] == session.order && parseInt(row['Требуется еще']) > 0)
      .map(row => `${row['Форма']} (${row['Размер']})`);

    if (shapesAndSizes.length === 0) {
      await bot.sendMessage(chatId, 'Все изделия по этому заказу уже сделаны. Пожалуйста, выберите другой заказ.');
      await sendAvailableOrders(chatId, session);
      return;
    }

    session.shapesAndSizes = shapesAndSizes;
    session.step = 'waiting_shape_size';

    await bot.sendMessage(chatId, 'Выберите форму и размер:', {
      reply_markup: {
        inline_keyboard: shapesAndSizes.map(shape => [{ text: shape, callback_data: `shape_${shape}` }]),
      },
    });
  }
  else if (data.startsWith('shape_')) {
    session.shapeAndSize = data.replace('shape_', '');

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
      await sendAvailableOrders(chatId, session);
      return;
    }

    const requiredLeft = parseInt(targetRow['Требуется еще']);

    if (!requiredLeft || requiredLeft <= 0) {
      await bot.sendMessage(chatId, 'По этому изделию все уже сделано! Выберите другое.');
      await sendAvailableOrders(chatId, session);
      return;
    }

    session.targetRow = targetRow;
    session.requiredLeft = requiredLeft;
    session.step = 'waiting_quantity';

    const quantityOptions = Array.from({ length: requiredLeft }, (_, i) => (i + 1).toString());

    await bot.sendMessage(chatId, 'Сколько изделий сделано?', {
      reply_markup: {
        inline_keyboard: quantityOptions.map(q => [{ text: q, callback_data: `qty_${q}` }]),
      },
    });
  }
  else if (data.startsWith('qty_')) {
    const quantity = parseInt(data.replace('qty_', ''));

    if (isNaN(quantity) || quantity <= 0 || quantity > session.requiredLeft) {
      await bot.sendMessage(chatId, `Введите число от 1 до ${session.requiredLeft}`);
      return;
    }

    session.quantity = quantity;

    const previousDone = parseInt(session.targetRow['Сделано']) || 0;
    session.targetRow['Сделано'] = previousDone + quantity;

    const today = new Date();
    const formattedDate = today.toLocaleDateString('ru-RU');

    session.targetRow['дата'] = formattedDate;
    session.targetRow['Исполнитель'] = session.name;

    // Пересчет "Требуется еще"
    const required = parseInt(session.targetRow['Требуется']) || 0;
    const done = parseInt(session.targetRow['Сделано']) || 0;
    session.targetRow['Требуется еще'] = required - done > 0 ? required - done : 0;

    await session.targetRow.save();

    await bot.sendMessage(chatId, `✅ Ваш результат:\nИмя: ${session.name}\nЗаказ: ${session.order}\nФорма: ${session.targetRow['Форма']}\nРазмер: ${session.targetRow['Размер']}\nСделано: ${session.targetRow['Сделано']}\nДата: ${formattedDate}`);

    session.step = 'waiting_new_order';

    await bot.sendMessage(chatId, 'Хотите внести ещё один заказ?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Да', callback_data: 'new_yes' }],
          [{ text: 'Нет', callback_data: 'new_no' }],
        ],
      },
    });
  }
  else if (data === 'new_yes') {
    await sendAvailableOrders(chatId, session);
  }
  else if (data === 'new_no') {
    await bot.sendMessage(chatId, 'Спасибо за работу! Чтобы начать заново, отправьте /start.');
    sessions.delete(chatId);
  }

  await bot.answerCallbackQuery(callbackQuery.id);
});

// Функция отправки доступных заказов
async function sendAvailableOrders(chatId, session) {
  const sheet = await accessSheet();
  const rows = await sheet.getRows();

  const uniqueOrders = [...new Set(
    rows
      .filter(row => parseInt(row['Требуется еще']) > 0)
      .map(row => row['Заказ'])
  )].filter(Boolean);

  if (uniqueOrders.length === 0) {
    await bot.sendMessage(chatId, 'Нет доступных заказов. Все изделия уже сделаны!');
    sessions.delete(chatId);
    return;
  }

  session.allOrders = uniqueOrders;
  session.step = 'waiting_order';

  await bot.sendMessage(chatId, 'Выберите заказ:', {
    reply_markup: {
      inline_keyboard: uniqueOrders.map(order => [{ text: order, callback_data: `order_${order}` }]),
    },
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

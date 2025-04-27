import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import 'dotenv/config';

// Конфигурация
const token = process.env.BOT_TOKEN;
const serverUrl = process.env.SERVER_URL;
const port = process.env.PORT || 3000;
const sheetId = process.env.GOOGLE_SHEET_ID;
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

// Настройка сервера Express
const app = express();

// Создаем бота через webhook
const bot = new TelegramBot(token, { webHook: { port: port } });
bot.setWebHook(`${serverUrl}/bot${token}`);

// Подключение к Google таблице
const doc = new GoogleSpreadsheet(sheetId);
await doc.useServiceAccountAuth({
  client_email: serviceAccountEmail,
  private_key: privateKey,
});
await doc.loadInfo();
const sheet = doc.sheetsByTitle['импорт'];

console.log('Бот запущен и ждет команды!');

// Обработчик команд
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, 'Привет! Как тебя зовут?');
});

// Здесь будет дополнительная логика взаимодействия с пользователем
// (вопросы про заказы, выбор формы, сколько сделано и т.д.)

// Запускаем сервер для приема Webhook запросов
app.use(express.json());
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Express сервер запущен на порту ${port}`);
});

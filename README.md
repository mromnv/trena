# TRENA

Тренерский кабинет для циклических видов спорта.

- Вход через Telegram-бота (`@Trenatrena_bot` или свой бот)
- Роли: **тренер** / **ученик** (и опционально админ)
- Ученик находит тренера по Telegram `@username` или через поиск
- Тренер добавляет и удаляет учеников, принимает заявки
- Планы, профиль, VDOT, статистика, отчёты
- PWA: установка на телефон и компьютер
- Один кодбоз для **локали** и **облака** (`MODE=local|cloud`)

## Локальный запуск (Windows)

1. Скопируйте `.env.example` → `.env`, вставьте `BOT_TOKEN` от [@BotFather](https://t.me/BotFather)
2. Дважды щёлкните `ЗАПУСК.bat`
3. Откройте http://127.0.0.1:8765/

Остановка: `ОСТАНОВИТЬ.bat` или закрытие окна консоли.  
Туннель для друга: `ТУННЕЛЬ.bat` (нужен запущенный сервер).

Портативный Node лежит в `tools/node` — отдельная установка Node не обязательна.

## Вход

1. «Войти через Telegram» → Start в боте (**один раз** на устройстве)
2. Дальше на том же браузере достаточно «Войти»
3. Выбрать роль: тренер / ученик (тренерскую роль выдаёт админ, либо она уже есть)

**Ученик:** поиск тренера или `@username` → заявка → тренер принимает.  
**Тренер:** добавить ученика по `@username` или принять заявку; планы и статистика по выбранному ученику.

## Админ

В `.env`: `ADMIN_TELEGRAM_IDS=ваш_telegram_id`  
В кабинете «Администрирование»: выдать роль тренера, назначить связки.

## Интернет (Docker)

```bash
export BOT_TOKEN=...
export BOT_USERNAME=Trenatrena_bot
export PUBLIC_URL=https://your.domain
export MODE=cloud
export SESSION_SECRET=long-random-string

docker build -t trena .
docker run -d -p 8765:8765 --env-file .env -v trena-data:/app/data trena
```

При `MODE=cloud` и `PUBLIC_URL` сервер ставит Telegram **webhook** на  
`https://your.domain/api/telegram/webhook`.  
Локально используется **long polling**.

После деплоя: сайт с телефона → «На экран Домой» / Install app.

## Структура

```
apps/server   # Express API + Telegram bot
apps/web      # PWA (manifest + service worker)
data/         # trena.json — хранилище (том в Docker)
ЗАПУСК.bat    # локальный старт
Dockerfile
```

Хранилище — JSON-файл (`data/trena.json`): удобно для портативного Windows без native-модулей; схема соответствует плану (users, profiles, links, workouts, dossiers, sessions).

## Скрипты

```bash
npm run start   # из корня → apps/server
# или
cd apps/server && npm start
```

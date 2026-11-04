# Как залить TRENA на GitHub и Railway

Готовый архив без секретов: **`TRENA-github.zip`** в папке проекта  
(нет `.env`, нет `node_modules`, нет базы учеников).

## 1. GitHub (без установки Git)

1. [github.com/new](https://github.com/new) → создайте репозиторий `trena` (пустое, без README).
2. Откройте репозиторий → **Add file → Upload files**.
3. Перетащите **содержимое** из `TRENA-github.zip` (распакуйте и залейте папки `apps`, `Dockerfile`, `README.md` и т.д.).
4. **Commit changes**.

## 1b. Через Git (если установлен)

```bash
git init
git add .
git commit -m "Initial TRENA: Telegram auth, PWA, Docker"
git remote add origin https://github.com/ВАШ_ЛОГИН/trena.git
git branch -M main
git push -u origin main
```

**Не заливайте** файл `.env` — там токен бота. В репо только `.env.example`.

## 2. Railway (сайт 24/7 без своего сервера)

1. [railway.app](https://railway.app) → Login with GitHub  
2. **New Project** → **Deploy from GitHub repo** → `trena`  
3. Variables:

| Variable | Значение |
|----------|----------|
| `BOT_TOKEN` | токен от BotFather |
| `BOT_USERNAME` | `Trenatrena_bot` |
| `MODE` | `cloud` |
| `SESSION_SECRET` | любая длинная строка |
| `ADMIN_TELEGRAM_IDS` | ваш telegram id |
| `PUBLIC_URL` | после генерации домена, см. ниже |

4. **Settings → Networking → Generate Domain**  
5. Скопируйте URL → в Variables: `PUBLIC_URL=https://….up.railway.app` (без `/` в конце)  
6. **Volumes** → Add volume → Mount path: `/app/data`  
7. Redeploy  

Откройте `PUBLIC_URL` в браузере и войдите через Telegram.

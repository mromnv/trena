import {
  upsertUserFromTelegram,
  consumeLoginToken,
  markBotVerified,
  ensureProfile,
  findUserById,
  listAthletesForCoach,
} from './db.js';

const API = (token) => `https://api.telegram.org/bot${token}`;

export async function tg(token, method, body) {
  const res = await fetch(`${API(token)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || 'Telegram API error');
    err.payload = data;
    throw err;
  }
  return data.result;
}

export async function sendMessage(token, chatId, text, extra = {}) {
  return tg(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

export async function setupWebhook({ token, publicUrl, secret }) {
  const url = `${String(publicUrl).replace(/\/$/, '')}/api/telegram/webhook`;
  const body = {
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  };
  if (secret) body.secret_token = secret;
  await tg(token, 'setWebhook', body);
  console.log(`[bot] webhook set → ${url}`);
}

export function startPolling({ token, botUsername, onLogin }) {
  let offset = 0;
  let stopped = false;

  async function loop() {
    // сброс webhook, иначе polling не получает апдейты
    try {
      await tg(token, 'deleteWebhook', { drop_pending_updates: false });
      console.log('[bot] webhook cleared, polling…');
    } catch (e) {
      console.warn('[bot] deleteWebhook:', e.message);
    }

    while (!stopped) {
      try {
        const updates = await tg(token, 'getUpdates', {
          timeout: 25,
          offset,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u, { token, botUsername, onLogin });
        }
      } catch (e) {
        console.error('[bot]', e.message);
        if (String(e.message).includes('Conflict')) {
          console.error('[bot] Другой процесс уже слушает этого бота. Закройте лишние окна TRENA / node.');
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  }

  loop();
  return () => {
    stopped = true;
  };
}

export async function handleUpdate(u, ctx) {
  const { token, onLogin } = ctx;
  if (u.message?.text) {
    const msg = u.message;
    const text = msg.text.trim();
    const from = msg.from;

    if (text.startsWith('/start')) {
      const user = upsertUserFromTelegram(from);
      // /start login_xxx  OR  /start@Bot login_xxx  OR  /startlogin_xxx
      const m = text.match(/login_([a-f0-9]+)/i);
      let loginToken = m ? m[1] : '';

      // локальный fallback: один свежий токен без payload (если открыли бота без параметра)
      if (!loginToken) {
        const { getDb } = await import('./db.js');
        const pending = getDb().loginTokens
          .filter((t) => !t.used && Date.now() - t.created_at < 10 * 60 * 1000)
          .sort((a, b) => b.created_at - a.created_at);
        if (pending.length === 1) loginToken = pending[0].token;
      }

      markBotVerified(user.id);
      ensureProfile(user.id, 'athlete');

      if (loginToken) {
        const ok = consumeLoginToken(loginToken, user.id);
        console.log(`[bot] /start login from ${user.username || user.telegram_id} token=${loginToken} ok=${ok}`);
        if (ok) {
          onLogin?.(user, loginToken);
          await sendMessage(
            token,
            msg.chat.id,
            `✅ Вход в <b>TRENA</b> подтверждён (один раз на этом устройстве).\n\nВернитесь во вкладку приложения — дальше бот для входа не нужен, пока не смените браузер/телефон.\n\nВы: <b>${escapeHtml(user.first_name || user.username || 'пользователь')}</b>${user.username ? ` (@${escapeHtml(user.username)})` : ''}\n\nТренера назначает администратор.`
          );
        } else {
          await sendMessage(
            token,
            msg.chat.id,
            'Ссылка для входа устарела. Откройте TRENA → «Войти через Telegram» ещё раз, затем нажмите Start здесь.'
          );
        }
        return;
      }

      await sendMessage(
        token,
        msg.chat.id,
        `Привет! Это бот <b>TRENA</b>.\n\nАккаунт привязан. Для первого входа в браузере:\n1) Откройте TRENA\n2) «Войти через Telegram»\n3) Start по ссылке из приложения\n\nДальше на том же устройстве бот не понадобится.\nUsername: <code>${escapeHtml(user.username || 'не задан')}</code>`
      );
      return;
    }
  }

  if (u.callback_query) {
    const cq = u.callback_query;
    try {
      await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function notifyUser(token, telegramId, text) {
  if (!telegramId) return;
  try {
    await sendMessage(token, telegramId, text);
  } catch (e) {
    console.warn('[notify]', e.message);
  }
}

export function coachPendingSummary(coachUserId) {
  const list = listAthletesForCoach(coachUserId).filter((l) => l.status === 'pending');
  return list;
}

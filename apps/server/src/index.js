import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import {
  createLoginToken,
  peekLoginToken,
  claimLoginToken,
  latestUnclaimedLogin,
  createSession,
  getSession,
  setSessionRole,
  destroySession,
  findUserById,
  findUserByUsername,
  publicUser,
  userProfiles,
  ensureProfile,
  revokeProfile,
  requestLink,
  listAthletesForCoach,
  listCoachesForAthlete,
  listCoachDirectory,
  setLinkStatus,
  removeLink,
  getWorkouts,
  saveWorkout,
  deleteWorkout,
  listDayNotes,
  saveDayNote,
  moveWorkout,
  copyWorkoutsWeek,
  copyForwardWarning,
  loadWarning,
  shareWorkout,
  copyWeekToAthletes,
  applyWeekToAthletes,
  listBusy,
  setBusy,
  workoutsOnDate,
  claimReminderDay,
  getChat,
  addChatMessage,
  getDossier,
  saveDossier,
  getCoachProfile,
  saveCoachProfile,
  normalizeCoachPhoto,
  canCoachAccessAthlete,
  normUser,
  markBotVerified,
  listAllUsers,
  listAllLinks,
  adminAssignLink,
  adminRemoveLink,
  createDeviceToken,
  consumeDeviceToken,
} from './db.js';
import { startPolling, setupWebhook, handleUpdate, notifyUser } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const PORT = Number(process.env.PORT || 8765);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const BOT_USERNAME = (process.env.BOT_USERNAME || 'Trenatrena_bot').replace(/^@/, '');
const MODE = process.env.MODE || 'local';
function resolvePublicUrl() {
  const explicit = String(process.env.PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  // Railway сам даёт домен сервиса — webhook заработает без ручного PUBLIC_URL
  const domain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (domain) return `https://${domain}`;
  const staticUrl = String(process.env.RAILWAY_STATIC_URL || '').trim().replace(/\/$/, '');
  if (staticUrl) return staticUrl;
  return '';
}
const PUBLIC_URL = resolvePublicUrl();
const COOKIE = 'trena_sid';
const DEVICE_COOKIE = 'trena_device';
const ADMIN_TELEGRAM_IDS = String(process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  // Не гасим процесс на Railway (иначе 502). Бот/вход не заработают, пока не зададите BOT_TOKEN в Variables.
  console.error('[FATAL] BOT_TOKEN is missing — задайте переменную в Railway → Variables');
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

function sid(req) {
  return req.cookies?.[COOKIE] || req.headers['x-session-id'] || null;
}

function requireAuth(req, res, next) {
  const session = getSession(sid(req));
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const user = findUserById(session.user_id);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.session = session;
  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session?.role) return res.status(403).json({ ok: false, error: 'role_required' });
    if (req.session.role !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  };
}

function isAdminUser(user) {
  return !!(user && ADMIN_TELEGRAM_IDS.includes(String(user.telegram_id)));
}

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ ok: false, error: 'admin_only', message: 'Только администратор' });
  }
  next();
}

function setAuthCookies(res, sessionId, deviceToken) {
  res.cookie(COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000,
  });
  if (deviceToken) {
    res.cookie(DEVICE_COOKIE, deviceToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 3600 * 1000,
    });
  }
}

function authPayload(user, session) {
  return {
    ok: true,
    status: 'ok',
    sessionId: session.id,
    user: publicUser(user),
    roles: userProfiles(user.id),
    isAdmin: isAdminUser(user),
    botVerified: !!user.bot_verified_at,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: !!BOT_TOKEN,
    mode: MODE,
    bot: BOT_USERNAME,
    publicUrl: PUBLIC_URL || null,
    port: PORT,
    botTokenConfigured: !!BOT_TOKEN,
  });
});

app.post('/api/auth/telegram/start', (_req, res) => {
  const loginToken = createLoginToken();
  const deepLink = `https://t.me/${BOT_USERNAME}?start=login_${loginToken}`;
  res.json({ ok: true, loginToken, deepLink, bot: BOT_USERNAME });
});

function finishLogin(res, loginToken, t) {
  const user = findUserById(t.user_id);
  if (!user) return res.json({ ok: true, status: 'pending' });
  claimLoginToken(loginToken || t.token);
  markBotVerified(user.id);
  ensureProfile(user.id, 'athlete');
  const session = createSession(user.id, null);
  const deviceToken = createDeviceToken(user.id);
  setAuthCookies(res, session.id, deviceToken);
  return res.json(authPayload(user, session));
}

app.get('/api/auth/telegram/poll', (req, res) => {
  const loginToken = String(req.query.token || '');
  const t = peekLoginToken(loginToken);
  if (!t) return res.json({ ok: true, status: 'pending' });
  return finishLogin(res, loginToken, t);
});

/** Если бот уже подтвердил вход, а вкладка потеряла токен — забрать последний unclaimed */
app.post('/api/auth/telegram/recover', (_req, res) => {
  const t = latestUnclaimedLogin();
  if (!t) return res.json({ ok: true, status: 'pending' });
  return finishLogin(res, t.token, t);
});

/** Повторный вход без бота (устройство уже подтверждено один раз) */
app.post('/api/auth/resume', (req, res) => {
  const device = req.cookies?.[DEVICE_COOKIE];
  if (!device) return res.json({ ok: true, status: 'need_bot' });
  const user = consumeDeviceToken(device);
  if (!user || !user.bot_verified_at) {
    res.clearCookie(DEVICE_COOKIE);
    return res.json({ ok: true, status: 'need_bot' });
  }
  ensureProfile(user.id, 'athlete');
  const session = createSession(user.id, null);
  setAuthCookies(res, session.id, device);
  return res.json(authPayload(user, session));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: publicUser(req.user),
    role: req.session.role,
    roles: userProfiles(req.user.id),
    isAdmin: isAdminUser(req.user),
    botVerified: !!req.user.bot_verified_at,
  });
});

app.post('/api/auth/role', requireAuth, (req, res) => {
  const role = req.body?.role;
  if (role !== 'coach' && role !== 'athlete' && role !== 'admin') {
    return res.status(400).json({ ok: false, error: 'invalid_role' });
  }
  if (role === 'admin') {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ ok: false, error: 'admin_only', message: 'Нет прав администратора' });
    }
    setSessionRole(req.session.id, 'admin');
    return res.json({
      ok: true,
      role: 'admin',
      user: publicUser(req.user),
      roles: userProfiles(req.user.id),
      isAdmin: true,
    });
  }
  if (role === 'coach') {
    const roles = userProfiles(req.user.id);
    if (!roles.includes('coach') && !isAdminUser(req.user)) {
      return res.status(403).json({
        ok: false,
        error: 'coach_not_granted',
        message: 'Роль тренера выдаёт только администратор',
      });
    }
    if (!roles.includes('coach') && isAdminUser(req.user)) {
      ensureProfile(req.user.id, 'coach');
    }
  }
  if (role === 'athlete') ensureProfile(req.user.id, 'athlete');
  setSessionRole(req.session.id, role);
  res.json({
    ok: true,
    role,
    user: publicUser(req.user),
    roles: userProfiles(req.user.id),
    isAdmin: isAdminUser(req.user),
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(req.session.id);
  res.clearCookie(COOKIE);
  // устройство оставляем — повторный вход без бота
  res.json({ ok: true });
});

/** Coach: athletes */
app.get('/api/coach/athletes', requireAuth, requireRole('coach'), (req, res) => {
  res.json({ ok: true, athletes: listAthletesForCoach(req.user.id) });
});

app.post('/api/coach/athletes', requireAuth, requireRole('coach'), async (req, res) => {
  const username = normUser(req.body?.username);
  if (!username) return res.status(400).json({ ok: false, error: 'username_required' });
  const athlete = findUserByUsername(username);
  if (!athlete) {
    return res.status(404).json({
      ok: false,
      error: 'athlete_not_found',
      message: 'Ученик ещё не входил в TRENA через Telegram. Попросите открыть приложение и войти.',
    });
  }
  if (athlete.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'cannot_add_self' });
  }
  ensureProfile(athlete.id, 'athlete');
  let link = requestLink({
    coachId: req.user.id,
    athleteId: athlete.id,
    initiatedBy: 'coach',
  });
  link = setLinkStatus(link.id, req.user.id, 'active') || link;
  await notifyUser(
    BOT_TOKEN,
    athlete.telegram_id,
    `Тренер <b>${escapeHtml(req.user.first_name || req.user.username)}</b>${req.user.username ? ` (@${escapeHtml(req.user.username)})` : ''} добавил вас в TRENA.`
  );
  res.json({ ok: true, link: { ...link, athlete: publicUser(athlete) } });
});

app.post('/api/coach/athletes/:linkId/accept', requireAuth, requireRole('coach'), async (req, res) => {
  const link = setLinkStatus(Number(req.params.linkId), req.user.id, 'active');
  if (!link) return res.status(404).json({ ok: false, error: 'not_found' });
  const athlete = findUserById(link.athlete_user_id);
  await notifyUser(BOT_TOKEN, athlete?.telegram_id, 'Тренер принял вашу заявку в TRENA.');
  res.json({ ok: true, link: { ...link, athlete: publicUser(athlete) } });
});

app.post('/api/coach/athletes/:linkId/reject', requireAuth, requireRole('coach'), (req, res) => {
  const link = removeLink(Number(req.params.linkId), req.user.id);
  if (!link) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/coach/profile', requireAuth, requireRole('coach'), (req, res) => {
  res.json({ ok: true, profile: getCoachProfile(req.user.id) });
});

app.put('/api/coach/profile', requireAuth, requireRole('coach'), (req, res) => {
  const body = req.body || {};
  let photo;
  if (body.photo !== undefined) {
    try {
      photo = normalizeCoachPhoto(body.photo);
    } catch (e) {
      const tooBig = e.code === 'photo_too_large';
      return res.status(400).json({
        ok: false,
        error: e.code || 'bad_photo',
        message: tooBig ? 'Фото слишком большое. Выберите снимок поменьше.' : 'Нужно изображение JPEG, PNG или WebP.',
      });
    }
  }
  const profile = saveCoachProfile(req.user.id, {
    headline: body.headline,
    bio: body.bio,
    city: body.city,
    experience: body.experience,
    focus: body.focus,
    photo,
  });
  res.json({ ok: true, profile });
});

app.delete('/api/coach/athletes/:linkId', requireAuth, requireRole('coach'), (req, res) => {
  const link = removeLink(Number(req.params.linkId), req.user.id);
  if (!link) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

/** Athlete: my coaches + directory for search */
app.get('/api/athlete/coaches', requireAuth, requireRole('athlete'), (req, res) => {
  const q = normUser(req.query.q || '');
  let directory = listCoachDirectory().filter((c) => c.id !== req.user.id);
  if (q) {
    directory = directory.filter((c) => {
      const hay = `${c.username} ${c.first_name} ${c.last_name} ${c.headline || ''} ${c.bio || ''} ${c.city || ''} ${c.experience || ''} ${(c.focus || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }
  res.json({
    ok: true,
    coaches: listCoachesForAthlete(req.user.id),
    directory,
  });
});

app.post('/api/athlete/coaches', requireAuth, requireRole('athlete'), async (req, res) => {
  const username = normUser(req.body?.username);
  const coachId = Number(req.body?.coachId || 0);
  const coach = coachId ? findUserById(coachId) : findUserByUsername(username);
  if (!coach) {
    return res.status(404).json({
      ok: false,
      error: 'coach_not_found',
      message: 'Тренер не найден. Проверьте @username или выберите из списка.',
    });
  }
  const roles = userProfiles(coach.id);
  if (!roles.includes('coach')) {
    return res.status(404).json({
      ok: false,
      error: 'not_a_coach',
      message: 'У этого пользователя нет роли тренера.',
    });
  }
  if (coach.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'cannot_add_self' });
  }
  const link = requestLink({
    coachId: coach.id,
    athleteId: req.user.id,
    initiatedBy: 'athlete',
  });
  await notifyUser(
    BOT_TOKEN,
    coach.telegram_id,
    `Ученик <b>${escapeHtml(req.user.first_name || req.user.username)}</b>${req.user.username ? ` (@${escapeHtml(req.user.username)})` : ''} хочет присоединиться к вам в TRENA.`
  );
  res.json({ ok: true, link: { ...link, coach: publicUser(coach) } });
});

/** Admin */
app.get('/api/admin/overview', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    users: listAllUsers(),
    links: listAllLinks(),
    coaches: listAllUsers().filter((u) => u.roles.includes('coach')),
  });
});

app.post('/api/admin/grant-coach', requireAuth, requireAdmin, async (req, res) => {
  const username = normUser(req.body?.username);
  const userId = Number(req.body?.userId || 0);
  const user = userId ? findUserById(userId) : findUserByUsername(username);
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'not_found',
      message: 'Пользователь не найден. Он должен один раз войти через Telegram-бота.',
    });
  }
  ensureProfile(user.id, 'coach');
  ensureProfile(user.id, 'athlete');
  await notifyUser(
    BOT_TOKEN,
    user.telegram_id,
    'Вам выдана роль <b>тренера</b> в TRENA. Войдите в приложение и выберите «Я тренер».'
  );
  res.json({ ok: true, user: { ...publicUser(user), roles: userProfiles(user.id) } });
});

app.post('/api/admin/revoke-coach', requireAuth, requireAdmin, (req, res) => {
  const username = normUser(req.body?.username);
  const userId = Number(req.body?.userId || 0);
  const user = userId ? findUserById(userId) : findUserByUsername(username);
  if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
  if (isAdminUser(user) && String(user.telegram_id) === String(req.user.telegram_id)) {
    // админ может снять с себя coach, это ок
  }
  revokeProfile(user.id, 'coach');
  res.json({ ok: true, user: { ...publicUser(user), roles: userProfiles(user.id) } });
});

app.post('/api/admin/assign', requireAuth, requireAdmin, async (req, res) => {
  const coachName = normUser(req.body?.coachUsername || req.body?.coach);
  const athleteName = normUser(req.body?.athleteUsername || req.body?.athlete);
  const coach = findUserByUsername(coachName) || findUserById(Number(req.body?.coachId || 0));
  const athlete = findUserByUsername(athleteName) || findUserById(Number(req.body?.athleteId || 0));
  if (!coach || !athlete) {
    return res.status(404).json({
      ok: false,
      error: 'not_found',
      message: 'Укажите @username тренера и ученика (оба должны один раз войти через бота).',
    });
  }
  if (coach.id === athlete.id) {
    return res.status(400).json({ ok: false, error: 'cannot_link_self' });
  }
  const link = adminAssignLink(coach.id, athlete.id);
  await notifyUser(
    BOT_TOKEN,
    athlete.telegram_id,
    `Администратор назначил вам тренера <b>${escapeHtml(coach.first_name || coach.username)}</b>${coach.username ? ` (@${escapeHtml(coach.username)})` : ''} в TRENA.`
  );
  await notifyUser(
    BOT_TOKEN,
    coach.telegram_id,
    `Администратор назначил ученика <b>${escapeHtml(athlete.first_name || athlete.username)}</b>${athlete.username ? ` (@${escapeHtml(athlete.username)})` : ''} в TRENA.`
  );
  res.json({
    ok: true,
    link: {
      ...link,
      coach: publicUser(coach),
      athlete: publicUser(athlete),
    },
  });
});

app.delete('/api/admin/links/:id', requireAuth, requireAdmin, (req, res) => {
  const link = adminRemoveLink(Number(req.params.id));
  if (!link) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

/** Athlete dossier (профиль, цели, VDOT) */
app.get('/api/athletes/:id/dossier', requireAuth, (req, res) => {
  const athleteId = Number(req.params.id);
  if (req.session.role === 'coach') {
    if (!canCoachAccessAthlete(req.user.id, athleteId)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  } else if (req.session.role === 'athlete') {
    if (req.user.id !== athleteId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  } else {
    return res.status(403).json({ ok: false, error: 'role_required' });
  }
  res.json({ ok: true, dossier: getDossier(athleteId), athlete: publicUser(findUserById(athleteId)) });
});

app.put('/api/athletes/:id/dossier', requireAuth, (req, res) => {
  const athleteId = Number(req.params.id);
  if (req.session.role === 'coach') {
    if (!canCoachAccessAthlete(req.user.id, athleteId)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  } else if (req.session.role === 'athlete') {
    if (req.user.id !== athleteId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  } else {
    return res.status(403).json({ ok: false, error: 'role_required' });
  }
  const dossier = saveDossier(athleteId, req.body || {});
  res.json({ ok: true, dossier });
});

/** Workouts */
app.get('/api/workouts', requireAuth, (req, res) => {
  const athleteId = Number(req.query.athleteId || (req.session.role === 'athlete' ? req.user.id : 0));
  if (!athleteId) return res.status(400).json({ ok: false, error: 'athleteId_required' });
  if (req.session.role === 'coach') {
    const ok = listAthletesForCoach(req.user.id).some(
      (l) => l.athlete_user_id === athleteId && l.status === 'active'
    );
    if (!ok) return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.json({ ok: true, workouts: getWorkouts(athleteId, req.user.id) });
  }
  if (req.user.id !== athleteId) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.json({ ok: true, workouts: getWorkouts(athleteId) });
});

app.post('/api/workouts', requireAuth, requireRole('coach'), (req, res) => {
  const body = req.body || {};
  const athleteId = Number(body.athlete_user_id);
  const ok = listAthletesForCoach(req.user.id).some(
    (l) => l.athlete_user_id === athleteId && l.status === 'active'
  );
  if (!ok) return res.status(403).json({ ok: false, error: 'forbidden' });
  const workoutId = body.id ? Number(body.id) : null;
  if (workoutId) {
    const existing = getWorkouts(athleteId, req.user.id).find((w) => w.id === workoutId);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const types = new Set(['running', 'swimming', 'cycling', 'strength', 'recovery', 'rest', 'sbu', 'hurdles', 'custom']);
  const type = types.has(body.type) ? body.type : 'custom';
  const cleanExercises = (list) => {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 40).map((e) => ({
      name: String(e?.name || '').trim().slice(0, 80),
      sets: String(e?.sets ?? '').trim().slice(0, 12),
      reps: String(e?.reps ?? '').trim().slice(0, 24),
      rest: String(e?.rest || '').trim().slice(0, 24),
    })).filter((e) => e.name || e.sets || e.reps || e.rest);
  };
  const patch = {
    id: workoutId,
    coach_user_id: req.user.id,
    athlete_user_id: athleteId,
    date: body.date,
    type,
    typeLabel: type === 'custom' ? String(body.typeLabel || '').trim().slice(0, 40) : '',
    title: body.title || 'Тренировка',
    desc: body.desc || '',
    km: body.km ?? null,
    pace: body.pace ?? null,
    zone: body.zone ?? null,
    dur: body.dur ?? null,
    exercises: type === 'strength' ? cleanExercises(body.exercises) : [],
  };
  // result только если явно передали (иначе при правке плана отчёт сохраняется)
  if (body.result !== undefined) patch.result = body.result;
  if (!workoutId) {
    patch.sent = !!body.sent;
    patch.result = body.result ?? null;
  } else if (body.sent !== undefined) {
    patch.sent = !!body.sent;
  }
  const addKm = ['running', 'cycling', 'swimming', 'sbu', 'hurdles'].includes(type) ? Number(patch.km) || 0 : 0;
  const also = [...new Set((Array.isArray(body.alsoAthleteIds) ? body.alsoAthleteIds : []).map(Number))]
    .filter((id) => id && id !== athleteId && coachOwnsAthlete(req, id));
  const warnings = [];
  const own = loadWarning({
    coachId: req.user.id,
    athleteId,
    date: String(patch.date || ''),
    addKm,
    skipId: workoutId,
  });
  if (own) warnings.push(own);
  for (const id of also) {
    const warn = loadWarning({ coachId: req.user.id, athleteId: id, date: String(patch.date || ''), addKm });
    if (warn) warnings.push(warn);
  }
  if (warnings.length && !body.force) {
    return res.json({ ok: true, needConfirm: true, warnings });
  }
  const row = saveWorkout(patch);
  const shared = shareWorkout(req.user.id, row, also);
  res.json({ ok: true, workout: row, shared: shared.length });
});

app.get('/api/notes', requireAuth, (req, res) => {
  const athleteId = Number(req.query.athleteId || (req.session.role === 'athlete' ? req.user.id : 0));
  if (!athleteId) return res.status(400).json({ ok: false, error: 'athleteId_required' });
  if (req.session.role === 'coach') {
    const ok = listAthletesForCoach(req.user.id).some(
      (l) => l.athlete_user_id === athleteId && l.status === 'active'
    );
    if (!ok) return res.status(403).json({ ok: false, error: 'forbidden' });
  } else if (req.user.id !== athleteId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  res.json({ ok: true, notes: listDayNotes(athleteId) });
});

app.put('/api/notes', requireAuth, (req, res) => {
  const athleteId = Number(req.body?.athleteId || (req.session.role === 'athlete' ? req.user.id : 0));
  const date = String(req.body?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad_date' });
  if (req.session.role === 'coach') {
    const ok = listAthletesForCoach(req.user.id).some(
      (l) => l.athlete_user_id === athleteId && l.status === 'active'
    );
    if (!ok) return res.status(403).json({ ok: false, error: 'forbidden' });
  } else if (req.session.role !== 'athlete' || req.user.id !== athleteId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const note = saveDayNote({
    athleteId,
    date,
    role: req.session.role === 'coach' ? 'coach' : 'athlete',
    text: req.body?.text || '',
  });
  res.json({ ok: true, note });
});

function coachOwnsAthlete(req, athleteId) {
  return listAthletesForCoach(req.user.id).some(
    (l) => l.athlete_user_id === athleteId && l.status === 'active'
  );
}

app.post('/api/workouts/:id/move', requireAuth, requireRole('coach'), (req, res) => {
  const date = String(req.body?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad_date' });
  const row = moveWorkout(Number(req.params.id), req.user.id, date);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, workout: row });
});

app.post('/api/workouts/copy-week', requireAuth, requireRole('coach'), (req, res) => {
  const athleteId = Number(req.body?.athleteId);
  const from = String(req.body?.from || '');
  if (!athleteId || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
  if (!coachOwnsAthlete(req, athleteId)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const jump = copyForwardWarning({ coachId: req.user.id, athleteId, from });
  if (jump && !req.body?.force) {
    return res.json({ ok: true, needConfirm: true, warnings: [jump] });
  }
  const { created, to } = copyWorkoutsWeek({ coachId: req.user.id, athleteId, from });
  res.json({ ok: true, count: created.length, to });
});

app.post('/api/workouts/copy-week-group', requireAuth, requireRole('coach'), (req, res) => {
  const athleteId = Number(req.body?.athleteId);
  const from = String(req.body?.from || '');
  const athleteIds = [...new Set((Array.isArray(req.body?.athleteIds) ? req.body.athleteIds : []).map(Number))]
    .filter((id) => id && id !== athleteId && coachOwnsAthlete(req, id));
  if (!athleteId || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
  if (!coachOwnsAthlete(req, athleteId)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!athleteIds.length) return res.status(400).json({ ok: false, error: 'no_athletes', message: 'Отметьте учеников' });
  const plan = copyWeekToAthletes({ coachId: req.user.id, fromAthleteId: athleteId, from, athleteIds });
  if (!plan.list.length) return res.json({ ok: true, count: 0, athletes: 0 });
  if (plan.warnings.length && !req.body?.force) {
    return res.json({ ok: true, needConfirm: true, warnings: plan.warnings });
  }
  const created = applyWeekToAthletes({ coachId: req.user.id, list: plan.list, targets: plan.targets });
  res.json({ ok: true, count: created.length, athletes: plan.targets.length });
});

app.get('/api/busy', requireAuth, (req, res) => {
  const athleteId = Number(req.query.athleteId || (req.session.role === 'athlete' ? req.user.id : 0));
  if (!athleteId) return res.status(400).json({ ok: false, error: 'athleteId_required' });
  if (req.session.role === 'coach') {
    if (!coachOwnsAthlete(req, athleteId)) return res.status(403).json({ ok: false, error: 'forbidden' });
  } else if (req.user.id !== athleteId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  res.json({ ok: true, days: listBusy(athleteId) });
});

app.put('/api/busy', requireAuth, requireRole('athlete'), (req, res) => {
  const date = String(req.body?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad_date' });
  const row = setBusy({
    athleteId: req.user.id,
    date,
    busy: !!req.body?.busy,
    note: req.body?.note || '',
  });
  res.json({ ok: true, day: row });
});

app.delete('/api/workouts/:id', requireAuth, requireRole('coach'), (req, res) => {
  const ok = deleteWorkout(Number(req.params.id), req.user.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/workouts/:id/report', requireAuth, requireRole('athlete'), (req, res) => {
  const workouts = getWorkouts(req.user.id);
  const w = workouts.find((x) => x.id === Number(req.params.id));
  if (!w) return res.status(404).json({ ok: false, error: 'not_found' });
  const status = req.body?.status;
  if (!['completed', 'partial', 'missed'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const skipped = (Array.isArray(req.body?.skipped) ? req.body.skipped : [])
    .slice(0, 40)
    .map((e) => ({
      name: String(e?.name || '').trim().slice(0, 80),
      note: String(e?.note || '').trim().slice(0, 300),
    }))
    .filter((e) => e.note);
  w.result = {
    status,
    rpe: num(req.body?.rpe),
    km: num(req.body?.km),
    dur: num(req.body?.dur),
    hr_avg: num(req.body?.hr_avg),
    hr_max: num(req.body?.hr_max),
    fb: String(req.body?.fb || '').trim().slice(0, 1000),
    skipped,
    at: new Date().toISOString(),
  };
  saveWorkout(w);
  res.json({ ok: true, workout: w });
});

/** Chat */
app.get('/api/chat', requireAuth, (req, res) => {
  const coachId = Number(req.query.coachId);
  const athleteId = Number(req.query.athleteId);
  if (!coachId || !athleteId) return res.status(400).json({ ok: false, error: 'ids_required' });
  if (req.session.role === 'coach' && req.user.id !== coachId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (req.session.role === 'athlete' && req.user.id !== athleteId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const chat = getChat(coachId, athleteId);
  res.json({ ok: true, messages: chat.messages });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const coachId = Number(req.body?.coachId);
  const athleteId = Number(req.body?.athleteId);
  const text = String(req.body?.text || '').trim();
  if (!coachId || !athleteId || !text) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }
  const who = req.session.role === 'coach' ? 'coach' : 'athlete';
  if (who === 'coach' && req.user.id !== coachId) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (who === 'athlete' && req.user.id !== athleteId) return res.status(403).json({ ok: false, error: 'forbidden' });
  const chat = addChatMessage(coachId, athleteId, { who, html: escapeHtml(text), text });
  const other = who === 'coach' ? findUserById(athleteId) : findUserById(coachId);
  await notifyUser(
    BOT_TOKEN,
    other?.telegram_id,
    `<b>TRENA</b>\n${escapeHtml(req.user.first_name || req.user.username)}: ${escapeHtml(text)}`
  );
  res.json({ ok: true, messages: chat.messages });
});

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Секрет webhook только если задали явно (иначе Telegram шлёт без него — проще для Railway)
const WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '')
  .trim()
  .replace(/[^A-Za-z0-9_-]/g, '')
  .slice(0, 256);

/** Cloud: Telegram webhook */
app.post('/api/telegram/webhook', async (req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ ok: false, error: 'no_bot_token' });
  if (WEBHOOK_SECRET) {
    const hdr = req.headers['x-telegram-bot-api-secret-token'];
    if (hdr !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }
  try {
    await handleUpdate(req.body, {
      token: BOT_TOKEN,
      botUsername: BOT_USERNAME,
      onLogin: (user) => console.log(`[login] ${user.username || user.telegram_id}`),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook]', e.message);
    res.status(500).json({ ok: false });
  }
});

/** Диагностика webhook (без секретов) */
app.get('/api/telegram/webhook-info', async (_req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ ok: false, error: 'no_bot_token' });
  try {
    const info = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`).then((r) => r.json());
    res.json({
      ok: !!info.ok,
      publicUrl: PUBLIC_URL || null,
      mode: MODE,
      expectedWebhook: PUBLIC_URL ? `${PUBLIC_URL}/api/telegram/webhook` : null,
      telegram: info.result || info,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Static frontend
const webDist = path.resolve(__dirname, '../../web/dist');
const webPublic = path.resolve(__dirname, '../../web');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.use(express.static(webPublic));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webPublic, 'index.html'));
  });
}

function workoutReminderText(w) {
  const lines = [`<b>${escapeHtml(w.title || 'Тренировка')}</b>`];
  const meta = [];
  if (w.km) meta.push(`${w.km} км`);
  if (w.pace) meta.push(String(w.pace));
  if (w.dur) meta.push(`${w.dur} мин`);
  if (meta.length) lines.push(escapeHtml(meta.join(' · ')));
  const extra = [];
  for (const e of w.exercises || []) {
    const bits = [e.name, e.sets && `${e.sets} подх.`, e.reps && `${e.reps} повт.`, e.rest && `отдых ${e.rest}`].filter(Boolean);
    if (bits.length) extra.push(bits.join(' · '));
  }
  if (w.desc) extra.push(String(w.desc));
  if (extra.length) lines.push(escapeHtml(extra.join('\n')));
  return lines.join('\n');
}

function moscowStamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}

async function sendMorningReminders() {
  if (!BOT_TOKEN || MODE !== 'cloud') return;
  const { date, hour } = moscowStamp();
  if (!date || Number.isNaN(hour) || hour < 8 || hour >= 12) return;
  if (!claimReminderDay(date)) return;
  const by = new Map();
  for (const w of workoutsOnDate(date)) {
    if (!by.has(w.athlete_user_id)) by.set(w.athlete_user_id, []);
    by.get(w.athlete_user_id).push(w);
  }
  for (const [athleteId, items] of by) {
    const user = findUserById(athleteId);
    if (!user?.telegram_id) continue;
    const real = items.filter((w) => w.type !== 'rest');
    const send = real.length ? real : items.slice(0, 1);
    const text = `Тренировка на сегодня\n\n${send.map(workoutReminderText).join('\n\n')}`.slice(0, 3500);
    await notifyUser(BOT_TOKEN, user.telegram_id, text);
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`TRENA server http://0.0.0.0:${PORT}`);
  console.log(`Bot @${BOT_USERNAME} · mode=${MODE} · token=${BOT_TOKEN ? 'yes' : 'NO'}`);
  if (MODE === 'cloud' && BOT_TOKEN) {
    const tick = () => sendMorningReminders().catch((e) => console.error('[remind]', e.message));
    setInterval(tick, 10 * 60 * 1000);
    tick();
  }
  if (!BOT_TOKEN) {
    console.error('[FATAL] Без BOT_TOKEN вход через Telegram не работает. Railway → Variables → BOT_TOKEN');
    return;
  }
  const onLogin = (user) => console.log(`[login] ${user.username || user.telegram_id}`);
  // В cloud только webhook — polling конфликтует с локальным TRENA и другим инстансом
  if (MODE === 'cloud') {
    if (!PUBLIC_URL) {
      console.error('[bot] PUBLIC_URL не задан — webhook не поставить. Задайте Variables → PUBLIC_URL');
      return;
    }
    try {
      await setupWebhook({ token: BOT_TOKEN, publicUrl: PUBLIC_URL, secret: WEBHOOK_SECRET });
      console.log('[bot] webhook mode OK — локальный ЗАПУСК.bat закройте');
    } catch (e) {
      console.error('[bot] webhook failed (без polling):', e.message);
    }
    return;
  }
  startPolling({ token: BOT_TOKEN, botUsername: BOT_USERNAME, onLogin });
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../../data');
const dbPath = path.join(dataDir, 'trena.json');
const backupPath = path.join(dataDir, 'trena.backup.json');

function empty() {
  return {
    users: [],
    profiles: [],
    dossiers: [],
    links: [],
    workouts: [],
    dayNotes: [],
    busyDays: [],
    reminderDays: [],
    chats: [],
    templates: [],
    loginTokens: [],
    sessions: [],
    deviceTokens: [],
    nextId: 1,
  };
}

function emptyDossier(userId) {
  return {
    user_id: userId,
    why: '',
    notes: '',
    injuries: '',
    peculiarities: '',
    values: [],
    base: [],
    tools: [],
    starts: [],
    pbs: {
      '5 км': { now: '', goal: '' },
      '10 км': { now: '', goal: '' },
      '21,1 км': { now: '', goal: '' },
      '42,2 км': { now: '', goal: '' },
    },
    vdot: null,
    vdotNote: '',
    pace: '5:30',
    updated_at: new Date().toISOString(),
  };
}

function hasRealData(data) {
  if (!data || typeof data !== 'object') return false;
  return ['users', 'workouts', 'links', 'dossiers'].some((key) => Array.isArray(data[key]) && data[key].length > 0);
}

function readDbFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`TRENA: не читается ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let createdFresh = false;

function load() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const backup = readDbFile(backupPath);
  if (!fs.existsSync(dbPath)) {
    if (hasRealData(backup)) {
      writeAtomic(dbPath, backup);
      console.log('TRENA: база восстановлена из копии');
      return backup;
    }
    createdFresh = true;
    const init = empty();
    writeAtomic(dbPath, init);
    console.warn(`TRENA: создана пустая база ${dbPath}. На Railway нужен том с путём /app/data, иначе при обновлении тренировки пропадут.`);
    return init;
  }
  const parsed = readDbFile(dbPath);
  if (!parsed) {
    if (hasRealData(backup)) {
      writeAtomic(dbPath, backup);
      console.log('TRENA: повреждённый файл заменён копией');
      return backup;
    }
    throw new Error(`TRENA: база повреждена и копии нет: ${dbPath}`);
  }
  if (!hasRealData(parsed) && hasRealData(backup)) {
    writeAtomic(dbPath, backup);
    console.log('TRENA: пустая база заменена копией с тренировками');
    return backup;
  }
  return parsed;
}

let db = load();

function save() {
  if (!hasRealData(db)) {
    const existing = readDbFile(dbPath);
    if (hasRealData(existing)) {
      console.error('TRENA: запись пустой базы отменена, тренировки на диске сохранены');
      return;
    }
  }
  if (hasRealData(readDbFile(dbPath))) {
    try {
      fs.copyFileSync(dbPath, backupPath);
    } catch (err) {
      console.error(`TRENA: не удалось обновить копию: ${err.message}`);
    }
  }
  writeAtomic(dbPath, db);
}

export function dataStats() {
  return {
    workouts: db.workouts?.length || 0,
    users: db.users?.length || 0,
    backup: fs.existsSync(backupPath),
    fresh: createdFresh,
  };
}

export function databasePath() {
  return dbPath;
}

export function id() {
  const n = db.nextId++;
  save();
  return n;
}

export function token(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

export function normUser(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase();
}

export function getDb() {
  return db;
}

export function persist() {
  save();
}

export function findUserByTelegramId(telegramId) {
  return db.users.find((u) => String(u.telegram_id) === String(telegramId));
}

export function findUserByUsername(username) {
  const n = normUser(username);
  return db.users.find((u) => normUser(u.username) === n);
}

export function findUserById(userId) {
  return db.users.find((u) => u.id === userId);
}

export function upsertUserFromTelegram(tg) {
  let user = findUserByTelegramId(tg.id);
  if (!user) {
    user = {
      id: id(),
      telegram_id: String(tg.id),
      username: tg.username || '',
      first_name: tg.first_name || '',
      last_name: tg.last_name || '',
      bot_verified_at: null,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
  } else {
    user.username = tg.username || user.username;
    user.first_name = tg.first_name || user.first_name;
    user.last_name = tg.last_name || user.last_name;
  }
  save();
  return user;
}

export function markBotVerified(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  if (!user.bot_verified_at) user.bot_verified_at = new Date().toISOString();
  user.last_bot_at = new Date().toISOString();
  save();
  return user;
}

export function ensureProfile(userId, role) {
  let p = db.profiles.find((x) => x.user_id === userId && x.role === role);
  if (!p) {
    p = { id: id(), user_id: userId, role, created_at: new Date().toISOString() };
    db.profiles.push(p);
    save();
  }
  return p;
}

export function revokeProfile(userId, role) {
  const before = db.profiles.length;
  db.profiles = db.profiles.filter((p) => !(p.user_id === userId && p.role === role));
  if (db.profiles.length !== before) save();
  return db.profiles.length < before;
}

export function userProfiles(userId) {
  return db.profiles.filter((p) => p.user_id === userId).map((p) => p.role);
}

export function listAllUsers() {
  if (!db.deviceTokens) db.deviceTokens = [];
  return db.users.map((u) => ({
    ...publicUser(u),
    bot_verified_at: u.bot_verified_at || null,
    roles: userProfiles(u.id),
  }));
}

export function listAllLinks() {
  return db.links
    .filter((l) => l.status !== 'removed')
    .map((l) => ({
      ...l,
      coach: publicUser(findUserById(l.coach_user_id)),
      athlete: publicUser(findUserById(l.athlete_user_id)),
    }));
}

export function adminAssignLink(coachId, athleteId) {
  let link = db.links.find(
    (l) => l.coach_user_id === coachId && l.athlete_user_id === athleteId
  );
  if (link) {
    link.status = 'active';
    link.initiated_by = 'admin';
    link.updated_at = new Date().toISOString();
  } else {
    link = {
      id: id(),
      coach_user_id: coachId,
      athlete_user_id: athleteId,
      status: 'active',
      initiated_by: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.links.push(link);
  }
  ensureProfile(coachId, 'coach');
  ensureProfile(athleteId, 'athlete');
  save();
  return link;
}

export function adminRemoveLink(linkId) {
  const link = db.links.find((l) => l.id === linkId);
  if (!link) return null;
  link.status = 'removed';
  link.updated_at = new Date().toISOString();
  save();
  return link;
}

export function createDeviceToken(userId) {
  if (!db.deviceTokens) db.deviceTokens = [];
  const row = {
    token: token(24),
    user_id: userId,
    created_at: Date.now(),
    last_used: Date.now(),
  };
  db.deviceTokens = db.deviceTokens.filter(
    (t) => t.user_id !== userId || Date.now() - t.created_at < 400 * 24 * 3600 * 1000
  );
  const mine = db.deviceTokens.filter((t) => t.user_id === userId);
  if (mine.length >= 5) {
    const oldest = [...mine].sort((a, b) => a.last_used - b.last_used)[0];
    db.deviceTokens = db.deviceTokens.filter((t) => t.token !== oldest.token);
  }
  db.deviceTokens.push(row);
  save();
  return row.token;
}

export function consumeDeviceToken(deviceToken) {
  if (!db.deviceTokens) db.deviceTokens = [];
  const t = db.deviceTokens.find((x) => x.token === deviceToken);
  if (!t) return null;
  // 1 год
  if (Date.now() - t.created_at > 365 * 24 * 3600 * 1000) {
    db.deviceTokens = db.deviceTokens.filter((x) => x.token !== deviceToken);
    save();
    return null;
  }
  t.last_used = Date.now();
  save();
  return findUserById(t.user_id);
}

export function revokeDeviceTokens(userId) {
  if (!db.deviceTokens) db.deviceTokens = [];
  db.deviceTokens = db.deviceTokens.filter((t) => t.user_id !== userId);
  save();
}

export function createLoginToken() {
  const t = {
    token: token(12),
    user_id: null,
    created_at: Date.now(),
    used: false,
  };
  const cutoff = Date.now() - 15 * 60 * 1000;
  db.loginTokens = db.loginTokens.filter((x) => x.created_at > cutoff);
  db.loginTokens.push(t);
  save();
  return t.token;
}

export function consumeLoginToken(loginToken, userId) {
  const t = db.loginTokens.find((x) => x.token === loginToken && !x.used);
  if (!t) return false;
  if (Date.now() - t.created_at > 15 * 60 * 1000) return false;
  t.used = true;
  t.user_id = userId;
  save();
  return true;
}

export function peekLoginToken(loginToken) {
  const t = db.loginTokens.find((x) => x.token === loginToken);
  if (!t || !t.used || !t.user_id || t.claimed) return null;
  if (Date.now() - t.created_at > 20 * 60 * 1000) return null;
  return t;
}

export function claimLoginToken(loginToken) {
  const t = db.loginTokens.find((x) => x.token === loginToken);
  if (!t) return;
  t.claimed = true;
  save();
}

/** Последний подтверждённый в боте, но ещё не забранный браузером токен */
export function latestUnclaimedLogin() {
  const list = db.loginTokens
    .filter((t) => t.used && t.user_id && !t.claimed && Date.now() - t.created_at < 24 * 60 * 60 * 1000)
    .sort((a, b) => b.created_at - a.created_at);
  return list[0] || null;
}

export function createSession(userId, role = null) {
  const s = {
    id: token(24),
    user_id: userId,
    role,
    created_at: Date.now(),
  };
  db.sessions.push(s);
  save();
  return s;
}

export function getSession(sessionId) {
  return db.sessions.find((s) => s.id === sessionId) || null;
}

export function setSessionRole(sessionId, role) {
  const s = getSession(sessionId);
  if (!s) return null;
  s.role = role;
  if (role === 'coach' || role === 'athlete') ensureProfile(s.user_id, role);
  save();
  return s;
}

export function destroySession(sessionId) {
  db.sessions = db.sessions.filter((s) => s.id !== sessionId);
  save();
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    telegram_id: u.telegram_id,
  };
}

function blankCoachProfile(userId) {
  return {
    user_id: userId,
    headline: '',
    bio: '',
    city: '',
    experience: '',
    focus: [],
    photo: '',
  };
}

/** data-URL фото тренера: jpeg/png/webp, до ~500 КБ */
export function normalizeCoachPhoto(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return '';
  if (s.length > 500000) {
    const err = new Error('photo_too_large');
    err.code = 'photo_too_large';
    throw err;
  }
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    const err = new Error('bad_photo');
    err.code = 'bad_photo';
    throw err;
  }
  return s;
}

export function getCoachProfile(userId) {
  if (!db.coachProfiles) db.coachProfiles = [];
  return db.coachProfiles.find((x) => x.user_id === userId) || blankCoachProfile(userId);
}

export function saveCoachProfile(userId, patch) {
  if (!db.coachProfiles) db.coachProfiles = [];
  let p = db.coachProfiles.find((x) => x.user_id === userId);
  if (!p) {
    p = blankCoachProfile(userId);
    db.coachProfiles.push(p);
  }
  const clip = (s, n) => String(s ?? '').trim().slice(0, n);
  if (patch.headline !== undefined) p.headline = clip(patch.headline, 140);
  if (patch.bio !== undefined) p.bio = clip(patch.bio, 4000);
  if (patch.city !== undefined) p.city = clip(patch.city, 80);
  if (patch.experience !== undefined) p.experience = clip(patch.experience, 80);
  if (patch.focus !== undefined) {
    const list = Array.isArray(patch.focus) ? patch.focus : [];
    p.focus = list.map((x) => clip(x, 40)).filter(Boolean).slice(0, 12);
  }
  if (patch.photo !== undefined) p.photo = normalizeCoachPhoto(patch.photo);
  p.updated_at = new Date().toISOString();
  save();
  return p;
}

/** Карточка тренера для ученика: имя + резюме, без telegram id */
export function publicCoach(u) {
  if (!u) return null;
  const p = getCoachProfile(u.id);
  return {
    id: u.id,
    username: u.username || '',
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    headline: p.headline || '',
    bio: p.bio || '',
    city: p.city || '',
    experience: p.experience || '',
    focus: Array.isArray(p.focus) ? p.focus : [],
    photo: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.photo || '') ? p.photo : '',
  };
}

export function findLink(coachId, athleteId) {
  return db.links.find(
    (l) => l.coach_user_id === coachId && l.athlete_user_id === athleteId && l.status !== 'removed'
  );
}

export function listAthletesForCoach(coachId) {
  return db.links
    .filter((l) => l.coach_user_id === coachId && l.status !== 'removed')
    .map((l) => ({
      ...l,
      athlete: publicUser(findUserById(l.athlete_user_id)),
    }));
}

export function listCoachesForAthlete(athleteId) {
  return db.links
    .filter((l) => l.athlete_user_id === athleteId && l.status !== 'removed')
    .map((l) => ({
      ...l,
      coach: publicCoach(findUserById(l.coach_user_id)),
    }));
}

/** Публичный список тренеров для поиска учеником */
export function listCoachDirectory() {
  return db.users
    .filter((u) => userProfiles(u.id).includes('coach'))
    .map((u) => publicCoach(u))
    .sort((a, b) =>
      String(a.first_name || a.username).localeCompare(String(b.first_name || b.username), 'ru')
    );
}

export function requestLink({ coachId, athleteId, initiatedBy }) {
  let link = db.links.find(
    (l) => l.coach_user_id === coachId && l.athlete_user_id === athleteId
  );
  if (link && link.status === 'active') return link;
  if (link && link.status === 'pending') return link;
  if (link && link.status === 'removed') {
    link.status = 'pending';
    link.initiated_by = initiatedBy;
    link.updated_at = new Date().toISOString();
    save();
    return link;
  }
  link = {
    id: id(),
    coach_user_id: coachId,
    athlete_user_id: athleteId,
    status: 'pending',
    initiated_by: initiatedBy,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.links.push(link);
  save();
  return link;
}

export function setLinkStatus(linkId, coachId, status) {
  const link = db.links.find((l) => l.id === linkId && l.coach_user_id === coachId);
  if (!link) return null;
  link.status = status;
  link.updated_at = new Date().toISOString();
  save();
  return link;
}

export function removeLink(linkId, coachId) {
  return setLinkStatus(linkId, coachId, 'removed');
}

export function getWorkouts(athleteId, coachId = null) {
  return db.workouts.filter(
    (w) => w.athlete_user_id === athleteId && (!coachId || w.coach_user_id === coachId)
  );
}

export function athletesMissingReports(coachId, dates) {
  const want = new Set(dates);
  const ids = new Set();
  for (const w of db.workouts) {
    if (w.coach_user_id !== coachId || w.type === 'rest') continue;
    if (!want.has(w.date) || w.result) continue;
    ids.add(w.athlete_user_id);
  }
  return [...ids];
}

const TEMPLATE_TYPES = new Set(['running', 'swimming', 'cycling', 'strength', 'recovery', 'rest', 'sbu', 'hurdles', 'custom']);

function ensureTemplates() {
  if (!Array.isArray(db.templates)) db.templates = [];
}

function cleanTemplateExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map((e) => ({
    name: String(e?.name || '').trim().slice(0, 80),
    sets: String(e?.sets ?? '').trim().slice(0, 12),
    reps: String(e?.reps ?? '').trim().slice(0, 24),
    rest: String(e?.rest || '').trim().slice(0, 24),
  })).filter((e) => e.name || e.sets || e.reps || e.rest);
}

export function listTemplates(coachId) {
  ensureTemplates();
  return db.templates.filter((t) => t.coach_user_id === coachId);
}

function optNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSport(type, body = {}) {
  const pace = body.pace ? String(body.pace).trim().slice(0, 20) : null;
  const zone = optNum(body.zone);
  const dur = optNum(body.dur);
  const kmIn = optNum(body.km);
  const meters = optNum(body.meters);
  const pool = Number(body.pool) === 50 ? 50 : (Number(body.pool) === 25 ? 25 : null);
  const speed = optNum(body.speed);
  const elev = optNum(body.elev);
  const power = optNum(body.power);
  const powerMax = optNum(body.powerMax);
  const hurdle = optNum(body.hurdle);
  const hurdleN = optNum(body.hurdleN);
  const hurdleSets = optNum(body.hurdleSets);
  const hurdleRest = body.hurdleRest ? String(body.hurdleRest).trim().slice(0, 24) : null;
  const blank = {
    km: null, pace: null, zone: null, dur: null, pool: null, meters: null,
    speed: null, elev: null, power: null, powerMax: null,
    hurdle: null, hurdleN: null, hurdleSets: null, hurdleRest: null,
  };
  if (type === 'rest') return blank;
  if (type === 'swimming') {
    const km = meters == null ? null : Math.round((meters / 1000) * 1000) / 1000;
    return { ...blank, km, meters, pool: pool || 25, pace, zone, dur };
  }
  if (type === 'cycling') {
    return { ...blank, km: kmIn, speed, elev, power, powerMax, zone, dur };
  }
  if (type === 'hurdles') {
    const sets = hurdleSets && hurdleSets > 0 ? hurdleSets : 1;
    const km = meters == null ? null : Math.round((meters * sets / 1000) * 1000) / 1000;
    return { ...blank, km, meters, hurdle, hurdleN, hurdleSets, hurdleRest, zone, dur };
  }
  if (type === 'running') return { ...blank, km: kmIn, pace, elev, zone, dur };
  if (type === 'sbu') return { ...blank, km: kmIn, dur };
  if (type === 'strength') return { ...blank, dur };
  if (type === 'recovery') return { ...blank, km: kmIn, zone, dur };
  return { ...blank, km: kmIn, pace, zone, dur };
}

function sportSnapshot(w) {
  return {
    km: w.km ?? null,
    pace: w.pace ?? null,
    zone: w.zone ?? null,
    dur: w.dur ?? null,
    pool: w.pool ?? null,
    meters: w.meters ?? null,
    speed: w.speed ?? null,
    elev: w.elev ?? null,
    power: w.power ?? null,
    powerMax: w.powerMax ?? null,
    hurdle: w.hurdle ?? null,
    hurdleN: w.hurdleN ?? null,
    hurdleSets: w.hurdleSets ?? null,
    hurdleRest: w.hurdleRest ?? null,
  };
}

export function saveTemplate(coachId, body) {
  ensureTemplates();
  if (db.templates.filter((t) => t.coach_user_id === coachId).length >= 30) return null;
  const type = TEMPLATE_TYPES.has(body.type) ? body.type : 'custom';
  const sport = normalizeSport(type, body);
  const row = {
    id: id(),
    coach_user_id: coachId,
    title: String(body.title || 'Тренировка').trim().slice(0, 120) || 'Тренировка',
    type,
    typeLabel: type === 'custom' ? String(body.typeLabel || '').trim().slice(0, 40) : '',
    ...sport,
    desc: String(body.desc || '').slice(0, 2000),
    exercises: type === 'strength' || type === 'sbu' ? cleanTemplateExercises(body.exercises) : [],
  };
  db.templates.push(row);
  save();
  return row;
}

export function deleteTemplate(coachId, templateId) {
  ensureTemplates();
  const i = db.templates.findIndex((t) => t.id === templateId && t.coach_user_id === coachId);
  if (i < 0) return false;
  db.templates.splice(i, 1);
  save();
  return true;
}

export function saveWorkout(w) {
  if (w.id) {
    const i = db.workouts.findIndex((x) => x.id === w.id);
    if (i >= 0) {
      const prev = db.workouts[i];
      const next = { ...prev };
      for (const [k, v] of Object.entries(w)) {
        if (v !== undefined) next[k] = v;
      }
      // не затираем отчёт атлета, если тренер просто правил план
      if (w.result === undefined) next.result = prev.result;
      next.updated_at = new Date().toISOString();
      db.workouts[i] = next;
      save();
      return db.workouts[i];
    }
  }
  const row = { ...w, id: id(), created_at: new Date().toISOString() };
  db.workouts.push(row);
  save();
  return row;
}

export function listDayNotes(athleteId) {
  if (!db.dayNotes) db.dayNotes = [];
  return db.dayNotes.filter((n) => n.athlete_user_id === athleteId);
}

export function saveDayNote({ athleteId, date, role, text }) {
  if (!db.dayNotes) db.dayNotes = [];
  let n = db.dayNotes.find((x) => x.athlete_user_id === athleteId && x.date === date);
  if (!n) {
    n = {
      id: id(),
      athlete_user_id: athleteId,
      date,
      coach_text: '',
      athlete_text: '',
    };
    db.dayNotes.push(n);
  }
  const t = String(text ?? '').slice(0, 2000);
  if (role === 'coach') n.coach_text = t;
  else n.athlete_text = t;
  n.updated_at = new Date().toISOString();
  save();
  return n;
}

export function moveWorkout(workoutId, coachId, date) {
  const w = db.workouts.find((x) => x.id === workoutId && x.coach_user_id === coachId);
  if (!w) return null;
  w.date = date;
  w.updated_at = new Date().toISOString();
  save();
  return w;
}

function shiftIso(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const VOLUME_TYPES = new Set(['running', 'cycling', 'swimming', 'sbu', 'hurdles']);

function kmOf(w) {
  return VOLUME_TYPES.has(w.type) ? Number(w.km) || 0 : 0;
}

function roundKm(n) {
  return Math.round(n * 10) / 10;
}

function sumKm(athleteId, coachId, from, to, skipId = null) {
  return db.workouts.reduce((sum, w) => {
    if (w.athlete_user_id !== athleteId || w.coach_user_id !== coachId) return sum;
    if (skipId && w.id === skipId) return sum;
    if (w.date < from || w.date > to) return sum;
    return sum + kmOf(w);
  }, 0);
}

export function weekOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const delta = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const from = shiftIso(iso, -delta);
  return { from, to: shiftIso(from, 6), prevFrom: shiftIso(from, -7), prevTo: shiftIso(from, -1) };
}

export function loadWarning({ coachId, athleteId, date, addKm = 0, skipId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const range = weekOf(date);
  const prev = sumKm(athleteId, coachId, range.prevFrom, range.prevTo);
  const next = sumKm(athleteId, coachId, range.from, range.to, skipId) + (Number(addKm) || 0);
  if (prev <= 0 || next <= prev * 1.1) return null;
  const user = findUserById(athleteId);
  return {
    athleteId,
    name: user?.first_name || user?.username || 'Ученик',
    prev: roundKm(prev),
    next: roundKm(next),
    pct: Math.round(((next - prev) / prev) * 100),
  };
}

function workoutCopy(w, athleteId, coachId) {
  return {
    id: id(),
    coach_user_id: coachId,
    athlete_user_id: athleteId,
    date: w.date,
    type: w.type || 'running',
    typeLabel: w.typeLabel || '',
    title: w.title || 'Тренировка',
    desc: w.desc || '',
    ...sportSnapshot(w),
    exercises: Array.isArray(w.exercises) ? w.exercises.map((e) => ({ ...e })) : [],
    result: null,
    created_at: new Date().toISOString(),
  };
}

export function shareWorkout(coachId, workout, athleteIds) {
  const rows = [];
  for (const athleteId of athleteIds) {
    const row = workoutCopy(workout, athleteId, coachId);
    db.workouts.push(row);
    rows.push(row);
  }
  if (rows.length) save();
  return rows;
}

export function copyWeekToAthletes({ coachId, fromAthleteId, from, athleteIds }) {
  const end = shiftIso(from, 6);
  const list = db.workouts.filter(
    (w) => w.coach_user_id === coachId && w.athlete_user_id === fromAthleteId && w.date >= from && w.date <= end
  );
  const addKm = list.reduce((sum, w) => sum + kmOf(w), 0);
  const warnings = [];
  const targets = athleteIds.filter((id) => id && id !== fromAthleteId);
  for (const athleteId of targets) {
    const warn = loadWarning({ coachId, athleteId, date: from, addKm });
    if (warn) warnings.push(warn);
  }
  return { list, targets, warnings, addKm };
}

export function applyWeekToAthletes({ coachId, list, targets }) {
  const created = [];
  for (const athleteId of targets) {
    for (const w of list) {
      const row = workoutCopy(w, athleteId, coachId);
      db.workouts.push(row);
      created.push(row);
    }
  }
  if (created.length) save();
  return created;
}

export function copyForwardWarning({ coachId, athleteId, from }) {
  const addKm = sumKm(athleteId, coachId, from, shiftIso(from, 6));
  return loadWarning({ coachId, athleteId, date: shiftIso(from, 7), addKm });
}

export function copyWorkoutsWeek({ coachId, athleteId, from }) {
  const end = shiftIso(from, 6);
  const list = db.workouts.filter(
    (w) => w.coach_user_id === coachId && w.athlete_user_id === athleteId && w.date >= from && w.date <= end
  );
  const created = list.map((w) => {
    const row = {
      id: id(),
      coach_user_id: coachId,
      athlete_user_id: athleteId,
      date: shiftIso(w.date, 7),
      type: w.type,
      typeLabel: w.typeLabel || '',
      title: w.title,
      desc: w.desc || '',
      ...sportSnapshot(w),
      exercises: Array.isArray(w.exercises) ? w.exercises : [],
      result: null,
      created_at: new Date().toISOString(),
    };
    db.workouts.push(row);
    return row;
  });
  if (created.length) save();
  return { created, to: shiftIso(from, 7) };
}

export function listBusy(athleteId) {
  if (!db.busyDays) db.busyDays = [];
  return db.busyDays.filter((b) => b.athlete_user_id === athleteId);
}

export function setBusy({ athleteId, date, busy, note }) {
  if (!db.busyDays) db.busyDays = [];
  const i = db.busyDays.findIndex((b) => b.athlete_user_id === athleteId && b.date === date);
  if (!busy) {
    if (i >= 0) {
      db.busyDays.splice(i, 1);
      save();
    }
    return null;
  }
  const row = {
    athlete_user_id: athleteId,
    date,
    note: String(note || '').trim().slice(0, 200),
  };
  if (i >= 0) db.busyDays[i] = row;
  else db.busyDays.push(row);
  save();
  return row;
}

export function workoutsOnDate(date) {
  return db.workouts.filter((w) => w.date === date);
}

export function claimReminderDay(date) {
  if (!db.reminderDays) db.reminderDays = [];
  if (db.reminderDays.includes(date)) return false;
  db.reminderDays.push(date);
  if (db.reminderDays.length > 90) db.reminderDays = db.reminderDays.slice(-90);
  save();
  return true;
}

export function deleteWorkout(workoutId, coachId) {
  const before = db.workouts.length;
  db.workouts = db.workouts.filter(
    (w) => !(w.id === workoutId && w.coach_user_id === coachId)
  );
  save();
  return db.workouts.length < before;
}

export function getChat(coachId, athleteId) {
  let c = db.chats.find(
    (x) => x.coach_user_id === coachId && x.athlete_user_id === athleteId
  );
  if (!c) {
    c = {
      id: id(),
      coach_user_id: coachId,
      athlete_user_id: athleteId,
      messages: [],
    };
    db.chats.push(c);
    save();
  }
  return c;
}

export function addChatMessage(coachId, athleteId, message) {
  const c = getChat(coachId, athleteId);
  c.messages.push({
    id: id(),
    ...message,
    time: message.time || new Date().toISOString(),
  });
  if (c.messages.length > 500) c.messages = c.messages.slice(-500);
  save();
  return c;
}

export function getDossier(userId) {
  if (!db.dossiers) db.dossiers = [];
  let d = db.dossiers.find((x) => x.user_id === userId);
  if (!d) {
    d = emptyDossier(userId);
    db.dossiers.push(d);
    save();
  }
  return d;
}

export function saveDossier(userId, patch) {
  const d = getDossier(userId);
  const allowed = [
    'why', 'notes', 'injuries', 'peculiarities',
    'values', 'base', 'tools', 'starts', 'pbs',
    'vdot', 'vdotNote', 'pace',
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) d[k] = patch[k];
  }
  d.updated_at = new Date().toISOString();
  save();
  return d;
}

export function canCoachAccessAthlete(coachId, athleteId) {
  return db.links.some(
    (l) =>
      l.coach_user_id === coachId &&
      l.athlete_user_id === athleteId &&
      l.status === 'active'
  );
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../../../data');
const dbPath = path.join(dataDir, 'trena.json');

function empty() {
  return {
    users: [],
    profiles: [],
    dossiers: [],
    links: [],
    workouts: [],
    chats: [],
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

function load() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const init = empty();
    fs.writeFileSync(dbPath, JSON.stringify(init, null, 2), 'utf8');
    return init;
  }
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

let db = load();

function save() {
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
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
      coach: publicUser(findUserById(l.coach_user_id)),
    }));
}

/** Публичный список тренеров для поиска учеником */
export function listCoachDirectory() {
  return db.users
    .filter((u) => userProfiles(u.id).includes('coach'))
    .map((u) => ({
      id: u.id,
      username: u.username || '',
      first_name: u.first_name || '',
      last_name: u.last_name || '',
    }))
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

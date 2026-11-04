import {
  PB_LIST, VD_DISTS, parseTime, fmtPace, vdFmt, vdotOf, paces, vdotFromPBs, goalLabel,
} from './vdot.js';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const state = {
  user: null,
  role: null,
  roles: [],
  isAdmin: false,
  view: 'boot',
  loginToken: null,
  deepLink: null,
  pollTimer: null,
  athletes: [],
  coaches: [],
  coachDirectory: [],
  coachSearch: '',
  selectedAthleteId: null,
  coachTab: 'plan', // plan | profile | stats
  athleteTab: 'plan', // plan | profile | stats
  statsPeriod: 'week', // week | month | season
  editingWorkoutId: null,
  dossier: null,
  workouts: [],
  reportDraft: null, // { id, status, title, km }
  adminUsers: [],
  adminLinks: [],
  error: '',
  notice: '',
};

const VOLUME_TYPES = new Set(['running', 'cycling', 'swimming']);
const TYPE_LABEL = {
  running: 'Бег', swimming: 'Плавание', cycling: 'Вело',
  strength: 'ОФП', recovery: 'Восст.', rest: 'Отдых',
};

const VALUE_OPTS = ['Чёткие цифры и план', 'Разнообразие тренировок', 'Бег в удовольствие', 'Здоровье и долголетие', 'Соревновательность', 'Быстрый прогресс', 'Без перегрузок', 'Общение / беговая группа', 'Гибкий график'];
const BASE_OPTS = ['Стадион', 'Беговая дорожка', 'Парк / лес', 'Горы / трейлы', 'Шоссе / веломаршрут', 'Площадка для ОФП', 'Тренажёрный зал', 'Бассейн', 'Открытая вода', 'Велотренажёр', 'Резинки / эспандеры', 'Гантели / гири'];
const TOOL_OPTS = ['Часы Garmin', 'Нагрудный пульсометр', 'МФР-ролл', 'Перкуссионный массажёр', 'Мячи для МФР', 'Кинезио-тейп', 'Умные весы'];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function setTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('trena-theme', next);
  render();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function initials(u) {
  const n = `${u?.first_name || ''} ${u?.last_name || ''}`.trim() || u?.username || '?';
  return n.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function savePendingLogin(payload) {
  sessionStorage.setItem('trena-pending-login', JSON.stringify(payload));
}
function loadPendingLogin() {
  try {
    return JSON.parse(sessionStorage.getItem('trena-pending-login') || 'null');
  } catch {
    return null;
  }
}
function clearPendingLogin() {
  sessionStorage.removeItem('trena-pending-login');
}

function applyAuth(data) {
  state.user = data.user;
  state.roles = data.roles || [];
  state.isAdmin = !!data.isAdmin;
  state.role = data.role ?? null;
}

async function enterAfterAuth(data) {
  applyAuth(data);
  state.loginToken = null;
  clearPendingLogin();
  await routeAfterLogin();
}

async function routeAfterLogin() {
  const roles = state.roles || [];
  const canCoach = roles.includes('coach') || state.isAdmin;
  // уже выбранная роль в сессии
  if (state.role === 'admin' && state.isAdmin) {
    state.view = 'admin';
    await loadAdmin();
    render();
    return;
  }
  if (state.role === 'coach' && canCoach) {
    state.view = 'coach';
    await loadCoach();
    render();
    return;
  }
  if (state.role === 'athlete') {
    state.view = 'athlete';
    await loadAthlete();
    render();
    return;
  }
  // авто-вход без лишнего экрана
  if (!canCoach && !state.isAdmin) {
    await chooseRole('athlete');
    return;
  }
  state.view = 'role';
  render();
}

function onLoginSuccess(data) {
  clearInterval(state.pollTimer);
  toast('Вход выполнен');
  enterAfterAuth(data);
}

async function boot() {
  try {
    const me = await api('/api/me');
    applyAuth(me);
    clearPendingLogin();
    await routeAfterLogin();
    return;
  } catch (_) {}

  // повторный вход без бота (устройство уже подтверждалось)
  try {
    const resumed = await api('/api/auth/resume', { method: 'POST', body: '{}' });
    if (resumed.status === 'ok') {
      toast('Снова в системе');
      await enterAfterAuth(resumed);
      return;
    }
  } catch (_) {}

  const pending = loadPendingLogin();
  if (pending?.loginToken) {
    state.loginToken = pending.loginToken;
    state.deepLink = pending.deepLink;
    state.tgLink = pending.tgLink;
    state.view = 'waiting';
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollLogin, 1200);
    pollLogin();
    tryRecoverLogin(true);
  } else {
    state.view = 'login';
    tryRecoverLogin(true);
  }
  render();
}

async function tryRecoverLogin(silent) {
  try {
    const data = await api('/api/auth/telegram/recover', { method: 'POST', body: '{}' });
    if (data.status === 'ok') {
      onLoginSuccess(data);
      return true;
    }
  } catch (_) {}
  if (!silent) toast('Пока нет подтверждения от бота. Нажмите Start в Telegram ещё раз.');
  return false;
}

async function startLogin() {
  state.error = '';
  state.notice = '';
  try {
    const data = await api('/api/auth/telegram/start', { method: 'POST', body: '{}' });
    state.loginToken = data.loginToken;
    state.deepLink = data.deepLink;
    state.tgLink = `tg://resolve?domain=${encodeURIComponent(data.bot || 'Trenatrena_bot')}&start=login_${data.loginToken}`;
    savePendingLogin({
      loginToken: state.loginToken,
      deepLink: state.deepLink,
      tgLink: state.tgLink,
    });
    state.view = 'waiting';
    render();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollLogin, 1200);
    // НЕ делаем location.href — иначе вкладка TRENA сбрасывается и вход «теряется»
  } catch (e) {
    state.error = e.message;
    render();
  }
}

async function pollLogin() {
  if (!state.loginToken) return;
  try {
    const data = await api(`/api/auth/telegram/poll?token=${encodeURIComponent(state.loginToken)}`);
    if (data.status !== 'ok') return;
    onLoginSuccess(data);
  } catch (_) {}
}

async function chooseRole(role) {
  try {
    const data = await api('/api/auth/role', { method: 'POST', body: JSON.stringify({ role }) });
    state.role = data.role;
    state.roles = data.roles || state.roles;
    state.isAdmin = !!data.isAdmin || state.isAdmin;
    if (role === 'admin') {
      state.view = 'admin';
      await loadAdmin();
    } else if (role === 'coach') {
      state.view = 'coach';
      await loadCoach();
    } else {
      state.view = 'athlete';
      await loadAthlete();
    }
    render();
  } catch (e) {
    toast(e.message || e.data?.message || 'Нет доступа');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (_) {}
  state.user = null;
  state.role = null;
  state.roles = [];
  state.isAdmin = false;
  state.view = 'login';
  render();
}

async function loadAdmin() {
  const data = await api('/api/admin/overview');
  state.adminUsers = data.users || [];
  state.adminLinks = data.links || [];
}

async function adminGrantCoach() {
  const username = $('#adm-coach-user')?.value.trim();
  if (!username) return toast('Укажите @username');
  try {
    await api('/api/admin/grant-coach', { method: 'POST', body: JSON.stringify({ username }) });
    toast('Роль тренера выдана');
    await loadAdmin();
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function adminRevokeCoach(userId) {
  if (!confirm('Снять роль тренера?')) return;
  await api('/api/admin/revoke-coach', { method: 'POST', body: JSON.stringify({ userId }) });
  toast('Роль тренера снята');
  await loadAdmin();
  render();
}

async function adminAssign() {
  const coachUsername = $('#adm-link-coach')?.value.trim();
  const athleteUsername = $('#adm-link-athlete')?.value.trim();
  if (!coachUsername || !athleteUsername) return toast('Укажите тренера и ученика');
  try {
    await api('/api/admin/assign', {
      method: 'POST',
      body: JSON.stringify({ coachUsername, athleteUsername }),
    });
    toast('Назначение сохранено');
    await loadAdmin();
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function adminUnlink(id) {
  if (!confirm('Убрать связку тренер ↔ ученик?')) return;
  await api(`/api/admin/links/${id}`, { method: 'DELETE' });
  toast('Связка удалена');
  await loadAdmin();
  render();
}

async function loadCoach() {
  const data = await api('/api/coach/athletes');
  state.athletes = data.athletes || [];
  const active = state.athletes.filter((a) => a.status === 'active');
  if (!state.selectedAthleteId && active[0]) state.selectedAthleteId = active[0].athlete_user_id;
  if (state.selectedAthleteId) {
    await Promise.all([
      loadWorkouts(state.selectedAthleteId),
      loadDossier(state.selectedAthleteId),
    ]);
  }
}

async function loadAthlete() {
  const q = state.coachSearch ? `?q=${encodeURIComponent(state.coachSearch)}` : '';
  const data = await api(`/api/athlete/coaches${q}`);
  state.coaches = data.coaches || [];
  state.coachDirectory = data.directory || [];
  await Promise.all([loadWorkouts(state.user.id), loadDossier(state.user.id)]);
}

async function loadWorkouts(athleteId) {
  const data = await api(`/api/workouts?athleteId=${athleteId}`);
  state.workouts = data.workouts || [];
}

async function addAthleteByUsername() {
  const username = $('#athlete-user')?.value.trim();
  if (!username) return toast('Укажите @username ученика');
  try {
    await api('/api/coach/athletes', { method: 'POST', body: JSON.stringify({ username }) });
    toast('Ученик добавлен');
    await loadCoach();
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function acceptLink(id) {
  await api(`/api/coach/athletes/${id}/accept`, { method: 'POST', body: '{}' });
  await loadCoach();
  render();
  toast('Заявка принята');
}

async function removeAthlete(id) {
  if (!confirm('Удалить ученика из списка?')) return;
  await api(`/api/coach/athletes/${id}`, { method: 'DELETE' });
  if (state.selectedAthleteId) {
    const still = state.athletes.find((a) => a.id === id);
    if (still && still.athlete_user_id === state.selectedAthleteId) {
      state.selectedAthleteId = null;
      state.workouts = [];
    }
  }
  await loadCoach();
  render();
  toast('Удалено');
}

async function selectAthlete(id) {
  state.selectedAthleteId = id;
  state.coachTab = 'plan';
  state.editingWorkoutId = null;
  await Promise.all([loadWorkouts(id), loadDossier(id)]);
  render();
}

async function loadDossier(athleteId) {
  if (!athleteId) {
    state.dossier = null;
    return;
  }
  const data = await api(`/api/athletes/${athleteId}/dossier`);
  state.dossier = data.dossier;
}

function collectProfileFromForm() {
  const d = state.dossier || {};
  const starts = [];
  document.querySelectorAll('[data-start]').forEach((row) => {
    const id = row.dataset.start;
    starts.push({
      id: Number(id) || Date.now(),
      prio: $(`[data-sf="prio-${id}"]`)?.value || 'B',
      name: $(`[data-sf="name-${id}"]`)?.value.trim() || '',
      date: $(`[data-sf="date-${id}"]`)?.value || '',
      dist: $(`[data-sf="dist-${id}"]`)?.value.trim() || '',
      goal: $(`[data-sf="goal-${id}"]`)?.value.trim() || '',
    });
  });
  const pbs = {};
  PB_LIST.forEach((x) => {
    pbs[x.k] = {
      now: $(`[data-pb-now="${x.k}"]`)?.value.trim() || '',
      goal: $(`[data-pb-goal="${x.k}"]`)?.value.trim() || '',
    };
  });
  const chipOn = (key) => [...document.querySelectorAll(`[data-chip="${key}"].on`)].map((el) => el.dataset.val);
  return {
    why: $('#pf-why')?.value.trim() || '',
    notes: $('#pf-notes')?.value.trim() || '',
    injuries: $('#pf-injuries')?.value.trim() || '',
    peculiarities: $('#pf-peculiarities')?.value.trim() || '',
    values: chipOn('values'),
    base: chipOn('base'),
    tools: chipOn('tools'),
    starts,
    pbs,
    pace: $('#pf-pace')?.value.trim() || d.pace || '5:30',
    vdot: d.vdot ?? null,
    vdotNote: d.vdotNote || '',
  };
}

function dossierTargetId() {
  if (state.role === 'athlete') return state.user?.id;
  return state.selectedAthleteId;
}

async function saveProfile() {
  const athleteId = dossierTargetId();
  if (!athleteId) return;
  const patch = collectProfileFromForm();
  const data = await api(`/api/athletes/${athleteId}/dossier`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  state.dossier = data.dossier;
  toast(state.role === 'athlete' ? 'Данные сохранены — тренер их увидит' : 'Профиль сохранён');
  render();
}

function chipGroup(key, opts, selected) {
  const all = [...new Set([...opts, ...(selected || [])])];
  return `<div class="chips">${all.map((v) => `
    <button type="button" class="tgl ${(selected || []).includes(v) ? 'on' : ''}" data-chip="${key}" data-val="${esc(v)}" data-act="toggle-chip">${esc(v)}</button>
  `).join('')}</div>
  <div class="chip-add">
    <input id="chip-add-${key}" placeholder="Свой вариант…" maxlength="80">
    <button type="button" class="btn" data-act="add-chip" data-chip-key="${key}" style="width:auto">+ Добавить</button>
  </div>`;
}

function addCustomChip(key) {
  if (!state.dossier) return;
  const allowed = ['values', 'base', 'tools'];
  if (!allowed.includes(key)) return;
  const raw = $(`#chip-add-${key}`)?.value.trim();
  if (!raw) return toast('Введите свой вариант');
  Object.assign(state.dossier, collectProfileFromForm());
  const list = Array.isArray(state.dossier[key]) ? [...state.dossier[key]] : [];
  if (!list.includes(raw)) list.push(raw);
  state.dossier[key] = list;
  render();
  toast('Добавлено — не забудьте сохранить профиль');
}

function fmtUpdated(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function vdotPanelHtml(dossier) {
  const v = dossier?.vdot;
  const P = v ? paces(v) : null;
  const opts = VD_DISTS.map((d, i) => `<option value="${i}" ${d.m === 10000 ? 'selected' : ''}>${d.k}</option>`).join('');
  return `<div class="vd" id="f-vdot">
    <div class="vd-top"><b>${v ? 'VDOT атлета: ' + vdFmt(v) : 'VDOT не задан'}</b>
      <span class="hint" style="margin:0">${v ? esc(dossier.vdotNote || '') : 'посчитайте по результату ниже'}</span></div>
    ${v ? `<div class="chips" style="margin:8px 0 0">${Object.entries(P).map(([k, x]) => `
      <button type="button" class="tgl" data-act="apply-pace" data-pace-key="${k}" title="${esc(x.ru)}">${k} · ${k === 'E' ? fmtPace(x.fast) + '–' + fmtPace(x.slow) : fmtPace(x.p)}</button>
    `).join('')}</div>
    <div class="hint" style="margin:6px 0 0">Нажмите темп, чтобы подставить в тренировку (E/M/T/I/R).</div>` : ''}
    <div class="f3" style="margin-top:10px">
      <div><label>Дистанция</label><select id="vd-dist-i">${opts}</select></div>
      <div><label>Результат</label><input id="vd-time-i" placeholder="ч:мм:сс или мм:сс"></div>
      <button type="button" class="btn" data-act="recalc-vdot" style="width:auto;align-self:end">Рассчитать VDOT</button>
    </div>
  </div>`;
}

async function recalcVdotInline() {
  const athleteId = dossierTargetId();
  if (!athleteId || !state.dossier) return;
  const d = VD_DISTS[Number($('#vd-dist-i')?.value || 0)];
  const raw = $('#vd-time-i')?.value.trim();
  const t = parseTime(raw);
  if (t == null || t <= 0) return toast('Укажите время ч:мм:сс или мм:сс');
  const v = vdotOf(d.m, t);
  if (!(v > 15 && v < 90)) return toast('Результат вне разумного диапазона');
  const patch = {
    ...collectProfileFromForm(),
    vdot: Math.round(v * 10) / 10,
    vdotNote: `по результату: ${d.k} ${raw}`,
  };
  const data = await api(`/api/athletes/${athleteId}/dossier`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  state.dossier = data.dossier;
  toast(`VDOT сохранён: ${vdFmt(state.dossier.vdot)}`);
  render();
}

function applyPaceKey(k) {
  if (!state.dossier?.vdot) return toast('Сначала рассчитайте VDOT');
  const x = paces(state.dossier.vdot)[k];
  if ($('#wo-pace')) $('#wo-pace').value = fmtPace(x.p);
  if ($('#wo-zone')) $('#wo-zone').value = String(x.zone);
  toast(`Темп ${fmtPace(x.p)}/км (${k}) подставлен`);
}

async function vdotFromRecords() {
  const athleteId = dossierTargetId();
  if (!state.dossier || !athleteId) return;
  const r = vdotFromPBs(collectProfileFromForm().pbs);
  if (!r) return toast('Заполните хотя бы один личный рекорд');
  const patch = {
    ...collectProfileFromForm(),
    vdot: Math.round(r.v * 10) / 10,
    vdotNote: r.note,
  };
  const data = await api(`/api/athletes/${athleteId}/dossier`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  state.dossier = data.dossier;
  toast(`VDOT из рекордов: ${vdFmt(state.dossier.vdot)}`);
  render();
}

function addStartRow() {
  if (!state.dossier) return;
  state.dossier.starts = state.dossier.starts || [];
  // preserve form edits first
  Object.assign(state.dossier, collectProfileFromForm());
  state.dossier.starts.push({
    id: Date.now(),
    prio: 'B',
    name: '',
    date: '',
    dist: '',
    goal: '',
  });
  render();
}

function removeStartRow(id) {
  Object.assign(state.dossier, collectProfileFromForm());
  state.dossier.starts = (state.dossier.starts || []).filter((s) => String(s.id) !== String(id));
  render();
}

async function findCoach() {
  const username = $('#coach-user')?.value.trim();
  if (!username) return toast('Укажите @username тренера');
  try {
    await api('/api/athlete/coaches', { method: 'POST', body: JSON.stringify({ username }) });
    toast('Заявка отправлена тренеру');
    state.coachSearch = '';
    await loadAthlete();
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function pickCoach(coachId) {
  try {
    await api('/api/athlete/coaches', { method: 'POST', body: JSON.stringify({ coachId }) });
    toast('Заявка отправлена тренеру');
    state.coachSearch = '';
    await loadAthlete();
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function searchCoaches() {
  state.coachSearch = $('#coach-search')?.value.trim() || '';
  if ($('#coach-user') && state.coachSearch && !state.coachSearch.includes(' ')) {
    $('#coach-user').value = state.coachSearch.startsWith('@') ? state.coachSearch : '@' + state.coachSearch;
  }
  const q = state.coachSearch ? `?q=${encodeURIComponent(state.coachSearch)}` : '';
  const data = await api(`/api/athlete/coaches${q}`);
  state.coaches = data.coaches || [];
  state.coachDirectory = data.directory || [];
  render();
}

function startEditWorkout(id) {
  state.editingWorkoutId = Number(id);
  state.coachTab = 'plan';
  render();
  $('#wo-title')?.focus();
  toast('Редактирование — измените поля и сохраните');
}

function cancelEditWorkout() {
  state.editingWorkoutId = null;
  render();
}

async function saveWorkoutForm() {
  const athleteId = state.selectedAthleteId;
  if (!athleteId) return toast('Выберите ученика');
  const editingId = state.editingWorkoutId;
  const title = $('#wo-title')?.value.trim() || 'Тренировка';
  const date = $('#wo-date')?.value || new Date().toISOString().slice(0, 10);
  const type = $('#wo-type')?.value || 'running';
  const payload = {
    athlete_user_id: athleteId,
    title,
    date,
    type,
    km: type === 'running' || type === 'cycling' || type === 'swimming' ? Number($('#wo-km')?.value || 0) || null : null,
    pace: type === 'running' ? ($('#wo-pace')?.value.trim() || null) : null,
    zone: Number($('#wo-zone')?.value || 0) || null,
    dur: Number($('#wo-dur')?.value || 0) || null,
    desc: $('#wo-desc')?.value.trim() || '',
  };
  if (editingId) payload.id = editingId;
  await api('/api/workouts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  state.editingWorkoutId = null;
  await loadWorkouts(athleteId);
  render();
  toast(editingId ? 'Тренировка обновлена' : 'Тренировка добавлена');
}

async function deleteWorkoutById(id) {
  if (!confirm('Удалить эту тренировку из плана?')) return;
  await api(`/api/workouts/${id}`, { method: 'DELETE' });
  if (state.editingWorkoutId === Number(id)) state.editingWorkoutId = null;
  await loadWorkouts(state.selectedAthleteId);
  render();
  toast('Тренировка удалена');
}

function openReportModal(id, status) {
  const w = state.workouts.find((x) => x.id === id);
  if (!w) return;
  if (status === 'missed') {
    submitReport(id, { status: 'missed' });
    return;
  }
  state.reportDraft = { id, status, title: w.title, km: w.km, dur: w.dur };
  renderModal();
}

function closeReportModal() {
  state.reportDraft = null;
  const m = $('#modal');
  if (m) { m.hidden = true; m.innerHTML = ''; }
}

function renderModal() {
  const m = $('#modal');
  if (!m) return;
  const d = state.reportDraft;
  if (!d) {
    m.hidden = true;
    m.innerHTML = '';
    return;
  }
  const stLabel = d.status === 'partial' ? 'частично' : 'выполнено';
  m.hidden = false;
  m.innerHTML = `<div class="sheet">
    <h3>Отчёт · ${esc(d.title)}</h3>
    <p class="muted" style="margin:0 0 12px">Статус: ${stLabel}. Заполните нагрузку — тренер увидит в статистике.</p>
    <div class="stack">
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>RPE (1–10)</label><input id="rep-rpe" type="number" min="1" max="10" step="1" placeholder="6"></div>
        <div><label>Факт, км</label><input id="rep-km" type="number" step="0.1" value="${d.km != null ? esc(d.km) : ''}" placeholder="км"></div>
      </div>
      <div class="row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><label>Время, мин</label><input id="rep-dur" type="number" min="1" value="${d.dur != null ? esc(d.dur) : ''}" placeholder="мин"></div>
        <div><label>Пульс ср.</label><input id="rep-hr-avg" type="number" min="40" max="220" placeholder="145"></div>
        <div><label>Пульс макс.</label><input id="rep-hr-max" type="number" min="40" max="220" placeholder="168"></div>
      </div>
      <div><label>Комментарий</label><textarea id="rep-fb" rows="2" placeholder="Самочувствие, погода, ощущения"></textarea></div>
    </div>
    <div class="actions">
      <button class="btn ghost" data-act="close-report">Отмена</button>
      <button class="btn primary" data-act="submit-report">Отправить</button>
    </div>
  </div>`;
}

async function submitReport(id, payload) {
  await api(`/api/workouts/${id}/report`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  closeReportModal();
  await loadWorkouts(state.user.id);
  render();
  toast('Отчёт отправлен');
}

async function submitReportFromModal() {
  const d = state.reportDraft;
  if (!d) return;
  const rpe = Number($('#rep-rpe')?.value);
  await submitReport(d.id, {
    status: d.status,
    rpe: rpe >= 1 && rpe <= 10 ? rpe : null,
    km: $('#rep-km')?.value || null,
    dur: $('#rep-dur')?.value || null,
    hr_avg: $('#rep-hr-avg')?.value || null,
    hr_max: $('#rep-hr-max')?.value || null,
    fb: $('#rep-fb')?.value.trim() || '',
  });
}

function themeButtons() {
  const t = document.documentElement.getAttribute('data-theme') || 'dark';
  return `<div class="theme-row">
    <button class="theme-btn ${t === 'dark' ? 'on' : ''}" data-act="theme-dark">Тёмная</button>
    <button class="theme-btn ${t === 'light' ? 'on' : ''}" data-act="theme-light">Светлая</button>
  </div>`;
}

function renderLogin() {
  return `<div class="screen"><div class="card">
    <div class="brand-hero">
      <img src="/trena-logo.jpg" alt="TRENA">
      <h1>TRENA</h1>
      <p>Тренируйся · Развивайся · Достигай</p>
    </div>
    <p class="muted" style="text-align:center;margin:0 0 16px">Бот нужен только при первом входе на устройстве</p>
    <button class="btn tg" data-act="try-resume">Войти</button>
    <button class="btn" data-act="login" style="margin-top:10px">Первый вход через Telegram</button>
    <button class="btn ghost" data-act="confirm-login" style="margin-top:10px;width:100%">Уже нажал Start в боте</button>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}
    <p class="hint">Ученик выбирает тренера в кабинете. Бот нужен только при первом входе на устройстве.</p>
  </div></div>`;
}

function renderWaiting() {
  return `<div class="screen"><div class="card">
    <div class="brand-hero">
      <img src="/trena-logo.jpg" alt="TRENA">
      <h1>Подтвердите вход</h1>
      <p>Start — <b>в приложении Telegram</b>. Эту вкладку не закрывайте.</p>
    </div>
    <ol class="muted" style="padding-left:18px;margin:0 0 16px;line-height:1.5">
      <li>Нажмите синюю кнопку ниже</li>
      <li>В Telegram нажмите <b>START</b></li>
      <li>Дождитесь «Вход подтверждён»</li>
      <li>Вернитесь сюда и нажмите «Я нажал Start»</li>
    </ol>
    <a class="btn tg" href="${esc(state.tgLink || state.deepLink)}" target="_blank" rel="noopener">1. Открыть Telegram</a>
    <a class="btn" href="${esc(state.deepLink)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;margin-top:10px">Или открыть t.me/@Trenatrena_bot</a>
    <button class="btn primary" data-act="confirm-login" style="margin-top:10px">2. Я нажал Start — продолжить</button>
    <button class="btn" data-act="login" style="margin-top:10px">Получить новую ссылку</button>
    <button class="btn ghost" data-act="back-login">Назад</button>
    <p class="hint">Если браузер пишет «окно заблокировано» — разрешите всплывающие окна для 127.0.0.1</p>
  </div></div>`;
}

function renderRole() {
  const name = state.user?.first_name || state.user?.username || 'пользователь';
  const canCoach = (state.roles || []).includes('coach') || state.isAdmin;
  return `<div class="screen"><div class="card">
    <div class="brand-hero">
      <img src="/trena-logo.jpg" alt="TRENA">
      <h1>Привет, ${esc(name)}</h1>
      <p>${state.user?.username ? '@' + esc(state.user.username) : 'кабинет'}</p>
    </div>
    <div class="role-grid">
      ${state.isAdmin ? `<button class="role-btn" data-act="role-admin">
        <strong>Администрирование</strong>
        <span class="muted">Роли тренеров и назначения учеников</span>
      </button>` : ''}
      ${canCoach ? `<button class="role-btn" data-act="role-coach">
        <strong>Я тренер</strong>
        <span class="muted">Планы, ученики, анализ нагрузки</span>
      </button>` : `<div class="panel" style="margin:0"><p class="muted" style="margin:0">Роль тренера выдаёт только администратор.</p></div>`}
      <button class="role-btn" data-act="role-athlete">
        <strong>Я ученик</strong>
        <span class="muted">План от тренера и отчёты</span>
      </button>
    </div>
    <button class="btn ghost" style="margin-top:14px;width:100%" data-act="logout">Выйти</button>
  </div></div>`;
}

function renderAdmin() {
  const coaches = state.adminUsers.filter((u) => u.roles.includes('coach'));
  const athletes = state.adminUsers.filter((u) => u.roles.includes('athlete') || !u.roles.includes('coach'));
  return `<div class="layout">
    <aside>
      <div class="brand">
        <img src="/trena-logo.jpg" alt="">
        <div><div class="name">TRENA</div><div class="tag">Админ</div></div>
      </div>
      ${themeButtons()}
      <div class="muted" style="margin:0 6px 10px;font-size:12px">${esc(state.user?.first_name || '')} ${state.user?.username ? '@' + esc(state.user.username) : ''}</div>
      <button class="btn ghost" data-act="switch-role">Сменить роль</button>
      <button class="btn ghost" data-act="logout">Выйти</button>
    </aside>
    <main>
      <div class="head">
        <div>
          <h1>Администрирование</h1>
          <div class="muted">Только вы выдаёте тренеров и назначаете учеников</div>
        </div>
        <span class="grow"></span>
        <span class="badge active">admin</span>
      </div>

      <div class="panel">
        <h3>Выдать роль тренера</h3>
        <div class="f2">
          <div><label>Telegram @username</label><input id="adm-coach-user" placeholder="@username"></div>
          <button class="btn primary" style="width:auto" data-act="adm-grant">Выдать</button>
        </div>
        <p class="hint">Человек должен один раз войти через бота, иначе его не будет в базе.</p>
      </div>

      <div class="panel">
        <h3>Назначить ученика тренеру</h3>
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">
          <div><label>Тренер @username</label><input id="adm-link-coach" placeholder="@coach" list="adm-coaches"></div>
          <div><label>Ученик @username</label><input id="adm-link-athlete" placeholder="@athlete" list="adm-athletes"></div>
          <button class="btn primary" style="width:auto" data-act="adm-assign">Назначить</button>
        </div>
        <datalist id="adm-coaches">${coaches.map((u) => `<option value="@${esc(u.username || '')}">`).join('')}</datalist>
        <datalist id="adm-athletes">${athletes.map((u) => `<option value="@${esc(u.username || '')}">`).join('')}</datalist>
      </div>

      <div class="panel">
        <h3>Пользователи</h3>
        <div class="list">
          ${state.adminUsers.map((u) => `
            <div class="list-item">
              <div>
                <b>${esc(u.first_name || u.username || '—')}</b> ${u.username ? '@' + esc(u.username) : ''}
                <div class="muted">id ${u.id} · ${esc((u.roles || []).join(', ') || 'без ролей')}${u.bot_verified_at ? ' · бот ✓' : ' · бот не подтверждён'}</div>
              </div>
              <div class="row">
                ${(u.roles || []).includes('coach')
    ? `<button class="btn danger" style="width:auto" data-act="adm-revoke" data-id="${u.id}">Снять тренера</button>`
    : `<button class="btn" style="width:auto" data-act="adm-grant-id" data-id="${u.id}">Сделать тренером</button>`}
              </div>
            </div>`).join('') || '<div class="muted">Пока никого нет</div>'}
        </div>
      </div>

      <div class="panel">
        <h3>Назначения</h3>
        <div class="list">
          ${state.adminLinks.map((l) => `
            <div class="list-item">
              <div>
                <b>${esc(l.coach?.first_name || l.coach?.username)}</b>
                →
                <b>${esc(l.athlete?.first_name || l.athlete?.username)}</b>
                <div class="muted">${esc(l.status)} · ${esc(l.initiated_by || '')}</div>
              </div>
              <button class="btn danger" style="width:auto" data-act="adm-unlink" data-id="${l.id}">Убрать</button>
            </div>`).join('') || '<div class="muted">Связок пока нет</div>'}
        </div>
      </div>
    </main>
  </div>`;
}

function renderCoachProfile(selected) {
  const d = state.dossier || {};
  const starts = d.starts?.length ? d.starts : [{ id: Date.now(), prio: 'A', name: '', date: '', dist: '', goal: '' }];
  const updated = fmtUpdated(d.updated_at);
  return `
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between">
      <div>
        <h3 style="margin:0">Профиль атлета</h3>
        <p class="hint" style="margin:4px 0 0">${updated ? 'Обновлено: ' + esc(updated) : 'Пока не сохраняли'}${state.role === 'coach' ? ' · нажмите «Обновить», если ученик только что сохранил' : ''}</p>
      </div>
      <button type="button" class="btn" data-act="refresh-profile" style="width:auto">↻ Обновить с сервера</button>
    </div>
    <div class="panel">
      <h3>Цель и мотивация</h3>
      <label>Для чего занимается</label>
      <textarea id="pf-why" rows="3" placeholder="Зачем атлету тренировки, чего хочет добиться">${esc(d.why || '')}</textarea>
      <label style="margin-top:10px">Что важно в процессе</label>
      ${chipGroup('values', VALUE_OPTS, d.values || [])}
      <div style="margin-top:10px"><label>Базовый темп, мин/км</label><input id="pf-pace" value="${esc(d.pace || '5:30')}" placeholder="5:30" style="max-width:160px"></div>
    </div>
    <div class="panel">
      <h3>Травмы и ограничения</h3>
      <textarea id="pf-injuries" rows="3" placeholder="Текущие травмы, боли, противопоказания, ограничения по нагрузке">${esc(d.injuries || '')}</textarea>
    </div>
    <div class="panel">
      <h3>Индивидуальные особенности</h3>
      <textarea id="pf-peculiarities" rows="3" placeholder="Например: другие тренировки в неделю (зал, футбол), сменный график, учёба, что нужно учитывать в плане">${esc(d.peculiarities || '')}</textarea>
    </div>
    <div class="panel">
      <h3>Заметки тренера</h3>
      <textarea id="pf-notes" rows="2" placeholder="Внутренние заметки тренера по атлету">${esc(d.notes || '')}</textarea>
    </div>
    <div class="panel">
      <h3>Ключевые старты</h3>
      <p class="hint">A — главный старт, B — важный, C — проходной</p>
      ${starts.map((s) => `
        <div class="start-row" data-start="${s.id}" style="display:grid;grid-template-columns:64px 1fr 140px 30px;gap:8px;margin-bottom:8px;align-items:center">
          <select data-sf="prio-${s.id}">${['A', 'B', 'C'].map((p) => `<option ${s.prio === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <input data-sf="name-${s.id}" value="${esc(s.name || '')}" placeholder="Название старта">
          <input data-sf="date-${s.id}" type="date" value="${esc(s.date || '')}">
          <button type="button" class="x" data-act="del-start" data-id="${s.id}" title="Удалить">×</button>
          <span></span>
          <input data-sf="dist-${s.id}" value="${esc(s.dist || '')}" placeholder="Дистанция, напр. 21,1 км">
          <input data-sf="goal-${s.id}" value="${esc(s.goal || '')}" placeholder="Цель, напр. 1:45:00">
          <span></span>
        </div>`).join('')}
      <button type="button" class="btn" data-act="add-start" style="width:auto">+ Добавить старт</button>
    </div>
    <div class="panel">
      <h3>Личные рекорды и цели</h3>
      <table class="pbt"><thead><tr><th>Дистанция</th><th>Сейчас</th><th>Цель</th></tr></thead><tbody>
        ${PB_LIST.map((x) => `<tr>
          <td><b>${x.k}</b></td>
          <td><input data-pb-now="${x.k}" value="${esc(d.pbs?.[x.k]?.now || '')}" placeholder="ч:мм:сс"></td>
          <td><input data-pb-goal="${x.k}" value="${esc(d.pbs?.[x.k]?.goal || '')}" placeholder="ч:мм:сс"></td>
        </tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin-top:10px">
        <button type="button" class="btn" data-act="vdot-from-pb" style="width:auto">Взять VDOT из рекордов</button>
        ${d.vdot ? `<span class="badge active">VDOT ${vdFmt(d.vdot)}</span>` : ''}
      </div>
    </div>
    <div class="panel">
      <h3>База и оснащение</h3>
      <label>Где тренируется</label>${chipGroup('base', BASE_OPTS, d.base || [])}
      <label style="margin-top:10px">Инструменты</label>${chipGroup('tools', TOOL_OPTS, d.tools || [])}
      <p class="hint">Можно отметить готовые варианты или добавить свои вручную.</p>
    </div>
    <button class="btn primary" data-act="save-profile" style="width:auto">${state.role === 'athlete' ? 'Сохранить мои данные' : 'Сохранить профиль ' + esc(selected?.athlete?.first_name || '')}</button>
    ${state.role === 'athlete' ? '<p class="hint">После сохранения тренер увидит данные во вкладке «Профиль атлета» (кнопка «Обновить»).</p>' : '<p class="hint">Ученик заполняет тот же профиль у себя. Не сохраняйте пустую форму поверх его данных — сначала «Обновить».</p>'}
  `;
}

function renderCoachPlan(selected) {
  const days = weekDays();
  const d = state.dossier;
  const edit = state.editingWorkoutId
    ? state.workouts.find((w) => w.id === state.editingWorkoutId)
    : null;
  const types = ['running', 'swimming', 'cycling', 'strength', 'recovery', 'rest'];
  const typeOpts = types.map((t) =>
    `<option value="${t}" ${(edit?.type || 'running') === t ? 'selected' : ''}>${TYPE_LABEL[t] || t}</option>`
  ).join('');
  const zone = edit?.zone || 2;
  const zoneOpts = [1, 2, 3, 4, 5].map((z) =>
    `<option value="${z}" ${Number(zone) === z ? 'selected' : ''}>${z}</option>`
  ).join('');
  const sorted = [...state.workouts].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  return `
    <div class="panel" id="wo-form">
      <h3>${edit ? 'Редактирование тренировки' : 'Новая тренировка'} для ${esc(selected.athlete?.first_name || selected.athlete?.username)}</h3>
      ${edit ? `<p class="hint" style="margin:0 0 10px">Отчёт атлета при правке плана не сбрасывается. <button type="button" class="btn ghost" data-act="cancel-edit-wo" style="width:auto;padding:4px 8px;margin:0;display:inline">Отменить</button></p>` : ''}
      <div class="stack">
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Дата</label><input id="wo-date" type="date" value="${esc(edit?.date || new Date().toISOString().slice(0, 10))}"></div>
          <div><label>Тип</label><select id="wo-type">${typeOpts}</select></div>
        </div>
        <div><label>Название</label><input id="wo-title" value="${esc(edit?.title || '')}" placeholder="Лёгкий бег 8 км"></div>
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
          <div><label>Дистанция, км</label><input id="wo-km" type="number" step="0.5" value="${edit?.km != null ? esc(edit.km) : ''}" placeholder="8"></div>
          <div><label>Темп, мин/км</label><input id="wo-pace" value="${esc(edit?.pace || '')}" placeholder="${esc(d?.pace || '5:30')}"></div>
          <div><label>Зона</label><select id="wo-zone">${zoneOpts}</select></div>
          <div><label>Время, мин</label><input id="wo-dur" type="number" min="1" value="${edit?.dur != null ? esc(edit.dur) : ''}" placeholder="45"></div>
        </div>
        <div><label>Описание</label><textarea id="wo-desc" rows="2" placeholder="Темп, зона, акценты">${esc(edit?.desc || '')}</textarea></div>
        ${vdotPanelHtml(d)}
        <div class="row">
          <button class="btn primary" data-act="add-wo" style="width:auto">${edit ? 'Сохранить изменения' : 'Сохранить тренировку'}</button>
          ${edit ? `<button class="btn danger" data-act="del-wo" data-id="${edit.id}" style="width:auto">Удалить</button>
            <button class="btn ghost" data-act="cancel-edit-wo" style="width:auto">Отмена</button>` : ''}
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>План · ближайшие дни</h3>
      <p class="hint">Нажмите на тренировку, чтобы изменить</p>
      <div class="week">
        ${days.map((day) => {
          const items = state.workouts.filter((w) => w.date === day.iso);
          return `<div class="day"><h4><span>${day.label}</span><span>${day.day}</span></h4>
            ${items.map((w) => `<button type="button" class="wo ${w.id === state.editingWorkoutId ? 'editing' : ''}" data-act="edit-wo" data-id="${w.id}">
              <b>${esc(w.title)}</b>
              <small>${esc(TYPE_LABEL[w.type] || w.type)}${w.km ? ' · ' + w.km + ' км' : ''}${w.pace ? ' · ' + esc(w.pace) : ''}${w.result ? ' · ' + w.result.status + (w.result.rpe != null ? ' · RPE ' + w.result.rpe : '') : ''}</small>
            </button>`).join('') || '<div class="muted" style="font-size:12px">—</div>'}
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>Все тренировки плана</h3>
      ${sorted.length ? `<div class="list">${sorted.map((w) => `
        <div class="list-item ${w.id === state.editingWorkoutId ? 'on-edit' : ''}">
          <div>
            <b>${esc(w.date)}</b> · ${esc(w.title)}
            <div class="muted">${esc(TYPE_LABEL[w.type] || w.type)}${w.km ? ' · ' + w.km + ' км' : ''}${w.result ? ' · ' + w.result.status : ' · без отчёта'}</div>
          </div>
          <div class="row">
            <button class="btn" style="width:auto" data-act="edit-wo" data-id="${w.id}">Изменить</button>
            <button class="btn danger" style="width:auto" data-act="del-wo" data-id="${w.id}">Удалить</button>
          </div>
        </div>`).join('')}</div>` : '<p class="muted">Пока нет тренировок</p>'}
    </div>`;
}

function renderCoach() {
  const pending = state.athletes.filter((a) => a.status === 'pending');
  const active = state.athletes.filter((a) => a.status === 'active');
  const selected = active.find((a) => a.athlete_user_id === state.selectedAthleteId);
  const goal = selected && state.dossier ? goalLabel(state.dossier) : '';
  return `<div class="layout">
    <aside>
      <div class="brand">
        <img src="/trena-logo.jpg" alt="">
        <div><div class="name">TRENA</div><div class="tag">Кабинет тренера</div></div>
      </div>
      ${themeButtons()}
      <div class="muted" style="margin:0 6px 10px;font-size:12px">${esc(state.user?.first_name || '')} ${state.user?.username ? '@' + esc(state.user.username) : ''}</div>
      <button class="btn ghost" data-act="logout">Выйти</button>
      <button class="btn ghost" data-act="switch-role">Сменить роль</button>
      <div class="side-title">Ученики</div>
      <div id="side">
        ${active.map((a) => `
          <button class="ath ${a.athlete_user_id === state.selectedAthleteId ? 'active' : ''}" data-act="select-athlete" data-id="${a.athlete_user_id}">
            <span class="av">${esc(initials(a.athlete))}</span>
            <div>
              <div class="n">${esc(a.athlete?.first_name || a.athlete?.username || 'Ученик')}</div>
              <div class="g">${a.athlete?.username ? '@' + esc(a.athlete.username) : ''}</div>
            </div>
          </button>`).join('') || '<div class="muted" style="padding:8px">Пока нет активных учеников</div>'}
      </div>
    </aside>
    <main>
      <div class="head">
        <div>
          <h1>${selected ? esc(selected.athlete?.first_name || selected.athlete?.username) : 'Тренерский кабинет'}</h1>
          ${selected ? `<div class="muted">${esc(goal)}${selected.athlete?.username ? ' · @' + esc(selected.athlete.username) : ''}${state.dossier?.vdot ? ' · VDOT ' + vdFmt(state.dossier.vdot) : ''}</div>` : ''}
        </div>
        <span class="grow"></span>
        <span class="badge active">тренер</span>
      </div>

      <div class="panel">
        <h3>Добавить ученика по Telegram @username</h3>
        <div class="f2">
          <div><label>Username ученика</label><input id="athlete-user" placeholder="@username"></div>
          <button class="btn primary" data-act="add-athlete" style="width:auto">Добавить</button>
        </div>
        <p class="hint">Ученик должен хотя бы раз войти в TRENA через бота.</p>
      </div>

      ${pending.length ? `<div class="panel"><h3>Заявки</h3><div class="list">
        ${pending.map((a) => `<div class="list-item">
          <div><b>${esc(a.athlete?.first_name || a.athlete?.username)}</b> ${a.athlete?.username ? '@' + esc(a.athlete.username) : ''} <span class="badge pending">ожидает</span></div>
          <div class="row">
            <button class="btn primary" style="width:auto" data-act="accept" data-id="${a.id}">Принять</button>
            <button class="btn danger" style="width:auto" data-act="remove" data-id="${a.id}">Отклонить</button>
          </div>
        </div>`).join('')}
      </div></div>` : ''}

      <div class="panel">
        <h3>Состав</h3>
        ${active.length ? `<div class="list">${active.map((a) => `<div class="list-item">
          <div><b>${esc(a.athlete?.first_name || a.athlete?.username)}</b> ${a.athlete?.username ? '@' + esc(a.athlete.username) : ''}</div>
          <div class="row">
            <button class="btn" style="width:auto" data-act="select-athlete" data-id="${a.athlete_user_id}">Открыть</button>
            <button class="btn danger" style="width:auto" data-act="remove" data-id="${a.id}">Удалить</button>
          </div>
        </div>`).join('')}</div>` : '<p class="muted">Пока нет активных учеников</p>'}
      </div>

      ${selected ? `
        <div class="tabs">
          <button class="${state.coachTab === 'plan' ? 'on' : ''}" data-act="tab-plan">План</button>
          <button class="${state.coachTab === 'stats' ? 'on' : ''}" data-act="tab-stats">Статистика</button>
          <button class="${state.coachTab === 'profile' ? 'on' : ''}" data-act="tab-profile">Профиль атлета</button>
        </div>
        ${state.coachTab === 'profile' ? renderCoachProfile(selected)
          : state.coachTab === 'stats' ? renderStats()
          : renderCoachPlan(selected)}
      ` : '<div class="panel muted">Выберите ученика слева или добавьте нового.</div>'}
    </main>
  </div>`;
}

function renderAthletePlan() {
  const activeCoach = state.coaches.find((c) => c.status === 'active');
  const pending = state.coaches.filter((c) => c.status === 'pending');
  const linkedIds = new Set(state.coaches.map((c) => c.coach_user_id || c.coach?.id));
  const directory = (state.coachDirectory || []).filter((c) => !linkedIds.has(c.id));
  const days = weekDays();
  return `
      <div class="panel">
        <h3>Мой тренер</h3>
        ${activeCoach ? `<div class="list-item"><div><b>${esc(activeCoach.coach?.first_name || activeCoach.coach?.username)}</b> ${activeCoach.coach?.username ? '@' + esc(activeCoach.coach.username) : ''} <span class="badge active">связан</span></div></div>` : '<p class="muted">Тренер ещё не выбран — найдите ниже</p>'}
        ${pending.map((c) => `<div class="list-item" style="margin-top:8px"><div><b>${esc(c.coach?.first_name || c.coach?.username)}</b> <span class="badge pending">заявка отправлена</span></div></div>`).join('')}
      </div>

      <div class="panel">
        <h3>Найти тренера</h3>
        <div class="f2" style="margin-bottom:10px">
          <div><label>Поиск по имени или @username</label><input id="coach-search" value="${esc(state.coachSearch || '')}" placeholder="например антон или mromnv"></div>
          <button class="btn" style="width:auto" data-act="search-coach">Найти</button>
        </div>
        <div class="f2">
          <div><label>Или введите @username точно</label><input id="coach-user" placeholder="@username_тренера" list="coach-dir-list"></div>
          <button class="btn primary" style="width:auto" data-act="find-coach">Отправить заявку</button>
        </div>
        <datalist id="coach-dir-list">${directory.map((c) => `<option value="@${esc(c.username)}">${esc(c.first_name || '')}</option>`).join('')}</datalist>
        <div class="list" style="margin-top:12px">
          ${directory.length ? directory.map((c) => `
            <div class="list-item">
              <div>
                <b>${esc(c.first_name || c.username || 'Тренер')}</b> ${c.username ? '@' + esc(c.username) : ''}
              </div>
              <button class="btn primary" style="width:auto" data-act="pick-coach" data-id="${c.id}">Выбрать</button>
            </div>`).join('') : `<p class="muted">${state.coachSearch ? 'Никого не найдено по запросу' : 'Пока нет тренеров в каталоге — введите @username вручную'}</p>`}
        </div>
        <p class="hint">После заявки тренер подтвердит связь в своём кабинете.</p>
      </div>

      <div class="panel">
        <h3>Тренировки</h3>
        <div class="week">
          ${days.map((d) => {
            const items = state.workouts.filter((w) => w.date === d.iso);
            return `<div class="day"><h4><span>${d.label}</span><span>${d.day}</span></h4>
              ${items.map((w) => `<div class="wo">
                <b>${esc(w.title)}</b>
                <small>${esc(w.type)}${w.km ? ' · ' + w.km + ' км' : ''}</small>
                ${w.result ? `<span class="badge active">${esc(w.result.status)}${w.result.rpe != null ? ' · RPE ' + w.result.rpe : ''}</span>` : `
                  <div class="row" style="margin-top:6px">
                    <button class="btn" style="width:auto;padding:6px 8px;font-size:12px" data-act="report" data-id="${w.id}" data-status="completed" title="Выполнено">✅</button>
                    <button class="btn" style="width:auto;padding:6px 8px;font-size:12px" data-act="report" data-id="${w.id}" data-status="partial" title="Частично">⚠️</button>
                    <button class="btn" style="width:auto;padding:6px 8px;font-size:12px" data-act="report" data-id="${w.id}" data-status="missed" title="Пропуск">❌</button>
                  </div>`}
              </div>`).join('') || '<div class="muted" style="font-size:12px">Нет тренировок</div>'}
            </div>`;
          }).join('')}
        </div>
      </div>`;
}

function renderAthlete() {
  const goal = state.dossier ? goalLabel(state.dossier) : '';
  return `<div class="layout">
    <aside>
      <div class="brand">
        <img src="/trena-logo.jpg" alt="">
        <div><div class="name">TRENA</div><div class="tag">Кабинет ученика</div></div>
      </div>
      ${themeButtons()}
      <div class="muted" style="margin:0 6px 10px;font-size:12px">${esc(state.user?.first_name || '')} ${state.user?.username ? '@' + esc(state.user.username) : ''}</div>
      <button class="btn ghost" data-act="logout">Выйти</button>
      <button class="btn ghost" data-act="switch-role">Сменить роль</button>
    </aside>
    <main>
      <div class="head">
        <div>
          <h1>${state.athleteTab === 'profile' ? 'Мои данные' : state.athleteTab === 'stats' ? 'Моя статистика' : 'Мой план'}</h1>
          <div class="muted">${esc(goal)}${state.dossier?.vdot ? ' · VDOT ' + vdFmt(state.dossier.vdot) : ''}</div>
        </div>
        <span class="grow"></span>
        <span class="badge active">ученик</span>
      </div>

      <div class="tabs">
        <button class="${state.athleteTab === 'plan' ? 'on' : ''}" data-act="ath-tab-plan">План</button>
        <button class="${state.athleteTab === 'stats' ? 'on' : ''}" data-act="ath-tab-stats">Статистика</button>
        <button class="${state.athleteTab === 'profile' ? 'on' : ''}" data-act="ath-tab-profile">Мои данные</button>
      </div>
      ${state.athleteTab === 'profile' ? renderCoachProfile({ athlete: state.user })
        : state.athleteTab === 'stats' ? renderStats()
        : renderAthletePlan()}
    </main>
  </div>`;
}

function weekDays() {
  const monLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const monday = mondayOf(new Date());
  return [...Array(7)].map((_, i) => {
    const d = addDays(monday, i);
    return { iso: isoDate(d), label: monLabels[i], day: String(d.getDate()) };
  });
}

function isoDate(d) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function parseIso(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  return addDays(x, -day);
}
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
function avg(arr) {
  return arr.length ? sum(arr) / arr.length : null;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function fmtNum(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits).replace(/\.0$/, '').replace('.', ',');
}

/** Текущий сезон: апр–сен / окт–мар */
function periodRange(period, today = new Date()) {
  const end = new Date(today);
  end.setHours(12, 0, 0, 0);
  const to = isoDate(end);
  if (period === 'week') {
    const from = isoDate(mondayOf(end));
    return { from, to, label: `неделя ${from.slice(8)}.${from.slice(5, 7)}–${to.slice(8)}.${to.slice(5, 7)}` };
  }
  if (period === 'month') {
    const from = isoDate(new Date(end.getFullYear(), end.getMonth(), 1));
    return { from, to, label: end.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }) };
  }
  // season
  const m = end.getMonth();
  let start;
  let name;
  if (m >= 3 && m <= 8) {
    start = new Date(end.getFullYear(), 3, 1);
    name = `весна–лето ${end.getFullYear()}`;
  } else if (m >= 9) {
    start = new Date(end.getFullYear(), 9, 1);
    name = `осень–зима ${end.getFullYear()}/${end.getFullYear() + 1}`;
  } else {
    start = new Date(end.getFullYear() - 1, 9, 1);
    name = `осень–зима ${end.getFullYear() - 1}/${end.getFullYear()}`;
  }
  return { from: isoDate(start), to, label: name };
}

function actualKm(w) {
  if (!w.result || w.result.status === 'missed') return 0;
  if (w.result.km != null) return Number(w.result.km) || 0;
  if (VOLUME_TYPES.has(w.type)) return Number(w.km) || 0;
  return 0;
}
function actualDur(w) {
  if (!w.result || w.result.status === 'missed') return 0;
  if (w.result.dur != null) return Number(w.result.dur) || 0;
  return Number(w.dur) || 0;
}
function completionScore(status) {
  if (status === 'completed') return 1;
  if (status === 'partial') return 0.5;
  return 0;
}

function calcStats(workouts, period) {
  const range = periodRange(period);
  const inRange = (w) => w.date >= range.from && w.date <= range.to;
  const all = workouts.filter(inRange);
  const load = all.filter((w) => w.type !== 'rest');
  const reported = load.filter((w) => w.result);
  const pending = load.filter((w) => !w.result);
  const volumeWs = load.filter((w) => VOLUME_TYPES.has(w.type));
  const plannedKm = round1(sum(volumeWs.map((w) => Number(w.km) || 0)));
  const factKm = round1(sum(load.map(actualKm)));
  const plannedDur = Math.round(sum(load.map((w) => Number(w.dur) || 0)));
  const factDur = Math.round(sum(load.map(actualDur)));
  const completion = reported.length
    ? avg(reported.map((w) => completionScore(w.result.status)))
    : null;
  const rpes = reported.map((w) => w.result.rpe).filter((x) => x != null);
  const hrs = reported.map((w) => w.result.hr_avg).filter((x) => x != null);
  const hrMaxes = reported.map((w) => w.result.hr_max).filter((x) => x != null);
  const zones = load.map((w) => w.zone).filter((x) => x != null);
  // Training load ≈ sRPE (RPE × мин) или RPE × км
  const loads = reported.map((w) => {
    if (w.result.rpe == null) return null;
    const dur = actualDur(w);
    if (dur > 0) return w.result.rpe * dur;
    const km = actualKm(w);
    if (km > 0) return w.result.rpe * km * 6; // грубо: ~6 мин/км
    return w.result.rpe * 30;
  }).filter((x) => x != null);
  const byType = {};
  load.forEach((w) => {
    const k = w.type || 'other';
    if (!byType[k]) byType[k] = { planned: 0, fact: 0, count: 0, done: 0 };
    byType[k].count += 1;
    byType[k].planned += Number(w.km) || 0;
    byType[k].fact += actualKm(w);
    if (w.result && w.result.status !== 'missed') byType[k].done += 1;
  });
  // weekly buckets inside period for charts
  const weeks = [];
  let cursor = mondayOf(parseIso(range.from));
  const endMon = mondayOf(parseIso(range.to));
  while (cursor <= endMon) {
    const from = isoDate(cursor);
    const to = isoDate(addDays(cursor, 6));
    const ws = workouts.filter((w) => w.date >= from && w.date <= to && w.date >= range.from && w.date <= range.to && w.type !== 'rest');
    const vol = ws.filter((w) => VOLUME_TYPES.has(w.type));
    const res = ws.filter((w) => w.result);
    weeks.push({
      from,
      label: `${from.slice(8)}.${from.slice(5, 7)}`,
      planned: round1(sum(vol.map((w) => Number(w.km) || 0))),
      actual: round1(sum(ws.map(actualKm))),
      completion: res.length ? avg(res.map((w) => completionScore(w.result.status))) : null,
      rpe: avg(res.map((w) => w.result.rpe).filter((x) => x != null)),
    });
    cursor = addDays(cursor, 7);
  }
  // streak: consecutive non-missed reports from newest
  const doneSorted = workouts
    .filter((w) => w.type !== 'rest' && w.result)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  let streak = 0;
  for (const w of doneSorted) {
    if (w.result.status === 'missed') break;
    streak += 1;
  }
  return {
    range,
    sessions: load.length,
    done: reported.filter((w) => w.result.status !== 'missed').length,
    missed: reported.filter((w) => w.result.status === 'missed').length,
    pending: pending.length,
    plannedKm,
    factKm,
    plannedDur,
    factDur,
    completion,
    rpe: avg(rpes),
    hrAvg: avg(hrs),
    hrMax: hrMaxes.length ? Math.max(...hrMaxes) : null,
    zoneAvg: avg(zones),
    load: loads.length ? Math.round(sum(loads)) : null,
    byType,
    weeks,
    streak,
    reports: reported.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12),
  };
}

function kpiHtml(label, value, detail = '', tone = '') {
  return `<div class="kpi ${tone}"><div class="l">${label}</div><div class="v">${value}</div>${detail ? `<div class="d">${detail}</div>` : ''}</div>`;
}

function volumeBarChart(weeks) {
  if (!weeks.length) return '<p class="muted">Нет данных за период</p>';
  const W = 520, H = 200, L = 28, B = 22, T = 12;
  const max = Math.max(10, ...weeks.map((s) => Math.max(s.planned, s.actual))) * 1.15;
  const step = (W - L) / weeks.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = [0, 0.5, 1].map((f) => {
    const val = Math.round((max * f) / 1.15);
    return `<line class="grid-l" x1="${L}" x2="${W}" y1="${y(max * f / 1.15)}" y2="${y(max * f / 1.15)}"/><text x="2" y="${y(max * f / 1.15) + 3}">${val}</text>`;
  }).join('');
  weeks.forEach((s, i) => {
    const x = L + i * step + 4;
    const bw = Math.max(3, (step - 10) / 2);
    g += `<rect class="b-plan" x="${x}" y="${y(s.planned)}" width="${bw}" height="${Math.max(0, H - B - y(s.planned))}" rx="2"/>
      <rect class="b-act" x="${x + bw + 2}" y="${y(s.actual)}" width="${bw}" height="${Math.max(0, H - B - y(s.actual))}" rx="2"/>
      <text x="${x + bw}" y="${H - 5}" text-anchor="middle">${esc(s.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function completionLineChart(weeks) {
  if (!weeks.length) return '<p class="muted">Нет данных за период</p>';
  const W = 520, H = 200, L = 28, B = 22, T = 12;
  const step = (W - L) / weeks.length;
  const y = (v) => T + (H - T - B) * (1 - v);
  const x = (i) => L + i * step + step / 2;
  let g = [0, 0.5, 1].map((f) =>
    `<line class="grid-l" x1="${L}" x2="${W}" y1="${y(f)}" y2="${y(f)}"/><text x="2" y="${y(f) + 3}">${f * 100}</text>`
  ).join('');
  const pts = weeks.map((s, i) => (s.completion == null ? null : [x(i), y(s.completion)]));
  const line = pts.filter(Boolean).map((p) => p.join(',')).join(' ');
  if (line) g += `<polyline class="ln" points="${line}"/>`;
  pts.forEach((p, i) => {
    if (!p) return;
    g += `<circle class="pt" cx="${p[0]}" cy="${p[1]}" r="3.5"/><text x="${p[0]}" y="${p[1] - 8}" text-anchor="middle">${Math.round(weeks[i].completion * 100)}</text>`;
  });
  weeks.forEach((s, i) => { g += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${esc(s.label)}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function heatCalendar(workouts, weeks) {
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let h = `<div class="heat"><span></span>${days.map((d) => `<span style="text-align:center">${d}</span>`).join('')}`;
  const show = weeks.slice(-8);
  show.forEach((wk) => {
    h += `<span>${esc(wk.label)}</span>`;
    for (let i = 0; i < 7; i++) {
      const s = isoDate(addDays(parseIso(wk.from), i));
      const w = workouts.find((x) => x.date === s && x.type !== 'rest')
        || workouts.find((x) => x.date === s);
      let cls = 'none';
      if (!w) cls = 'none';
      else if (w.type === 'rest') cls = 'rest';
      else if (w.result) cls = w.result.status;
      else cls = 'pending';
      h += `<div class="cell ${cls}" title="${w ? esc(w.title) : ''}"></div>`;
    }
  });
  return `${h}</div>`;
}

function renderStats() {
  const s = calcStats(state.workouts, state.statsPeriod);
  const rpeTone = s.rpe == null ? '' : s.rpe >= 7.5 ? 'bad' : s.rpe >= 6.5 ? 'warn' : 'ok';
  const compTone = s.completion == null ? '' : s.completion >= 0.85 ? 'ok' : s.completion >= 0.6 ? 'warn' : 'bad';
  const typeRows = Object.entries(s.byType)
    .sort((a, b) => b[1].fact - a[1].fact || b[1].count - a[1].count);
  const maxFact = Math.max(1, ...typeRows.map(([, v]) => v.fact || v.count));
  return `
    <div class="panel" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
      <div>
        <h3 style="margin:0">Статистика нагрузки</h3>
        <p class="hint" style="margin:4px 0 0">${esc(s.range.label)} · ${s.range.from} → ${s.range.to}</p>
      </div>
      <div class="seg">
        <button class="${state.statsPeriod === 'week' ? 'on' : ''}" data-act="stats-period" data-period="week">Неделя</button>
        <button class="${state.statsPeriod === 'month' ? 'on' : ''}" data-act="stats-period" data-period="month">Месяц</button>
        <button class="${state.statsPeriod === 'season' ? 'on' : ''}" data-act="stats-period" data-period="season">Сезон</button>
      </div>
    </div>
    <div class="kpis">
      ${kpiHtml('Выполнение плана', s.completion != null ? Math.round(s.completion * 100) + '%' : '—', `${s.done} из ${s.sessions} · пропуск ${s.missed} · ждёт ${s.pending}`, compTone)}
      ${kpiHtml('Объём, км', fmtNum(s.factKm), `план ${fmtNum(s.plannedKm)} км`)}
      ${kpiHtml('Средний RPE', s.rpe != null ? fmtNum(s.rpe) : '—', s.rpe == null ? 'укажите в отчёте' : s.rpe >= 6.5 ? 'высокая нагрузка' : 'нагрузка в норме', rpeTone)}
      ${kpiHtml('Пульс ср. / макс.', s.hrAvg != null ? `${Math.round(s.hrAvg)} / ${s.hrMax ?? '—'}` : '—', s.zoneAvg != null ? `средняя зона ${fmtNum(s.zoneAvg)}` : 'из отчётов атлета')}
      ${kpiHtml('Время, мин', s.factDur || '—', s.plannedDur ? `план ${s.plannedDur} мин` : 'длительность из отчётов')}
      ${kpiHtml('Нагрузка (sRPE)', s.load != null ? s.load : '—', 'RPE × минуты')}
      ${kpiHtml('Серия без пропусков', s.streak, 'тренировок подряд')}
      ${kpiHtml('Тренировок', s.sessions, `выполнено ${s.done}`)}
    </div>
    <div class="two">
      <div class="panel">
        <h3>Объём по неделям, км</h3>
        ${volumeBarChart(s.weeks)}
        <div class="legend"><span><i style="background:var(--accent);opacity:.28"></i>план</span><span><i style="background:var(--accent)"></i>факт</span></div>
      </div>
      <div class="panel">
        <h3>Выполнение по неделям, %</h3>
        ${completionLineChart(s.weeks)}
      </div>
    </div>
    <div class="two" style="margin-top:0">
      <div class="panel">
        <h3>По видам спорта</h3>
        ${typeRows.length ? `<div class="type-bars">${typeRows.map(([k, v]) => `
          <div class="type-row">
            <span>${esc(TYPE_LABEL[k] || k)}</span>
            <div class="track"><div class="fill" style="width:${Math.round(((v.fact || v.count) / maxFact) * 100)}%"></div></div>
            <span class="muted">${VOLUME_TYPES.has(k) ? fmtNum(v.fact) + ' км' : v.done + '/' + v.count}</span>
          </div>`).join('')}</div>` : '<p class="muted">Пока нет тренировок</p>'}
      </div>
      <div class="panel">
        <h3>Календарь · до 8 нед.</h3>
        ${heatCalendar(state.workouts, s.weeks)}
        <div class="legend" style="margin-top:10px">
          <span><i style="background:var(--ok)"></i>ок</span>
          <span><i style="background:var(--warn)"></i>частично</span>
          <span><i style="background:var(--bad)"></i>пропуск</span>
          <span><i style="border:1px dashed var(--muted);background:transparent"></i>ждёт</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>Последние отчёты</h3>
      ${s.reports.length ? s.reports.map((w) => {
        const r = w.result;
        return `<div class="rep">
          <div class="rpe-box">${r.rpe ?? '—'}<small>RPE</small></div>
          <div style="flex:1">
            <div><b>${esc(w.title)}</b> <span class="badge ${r.status === 'completed' ? 'active' : r.status === 'missed' ? 'pending' : ''}">${esc(r.status)}</span></div>
            <div class="meta">${esc(w.date)} · ${esc(TYPE_LABEL[w.type] || w.type)}
              ${actualKm(w) ? ` · ${fmtNum(actualKm(w))} км` : ''}
              ${r.hr_avg != null ? ` · пульс ${r.hr_avg}${r.hr_max != null ? '/' + r.hr_max : ''}` : ''}
              ${actualDur(w) ? ` · ${actualDur(w)} мин` : ''}
            </div>
            ${r.fb ? `<q>«${esc(r.fb)}»</q>` : ''}
          </div>
        </div>`;
      }).join('') : '<p class="muted">Отчётов за период пока нет. Ученик отмечает тренировки и указывает RPE/пульс.</p>'}
    </div>`;
}

function render() {
  if (state.view === 'login') app.innerHTML = renderLogin();
  else if (state.view === 'waiting') app.innerHTML = renderWaiting();
  else if (state.view === 'role') app.innerHTML = renderRole();
  else if (state.view === 'admin') app.innerHTML = renderAdmin();
  else if (state.view === 'coach') app.innerHTML = renderCoach();
  else if (state.view === 'athlete') app.innerHTML = renderAthlete();
  else app.innerHTML = `<div class="screen"><div class="card">Загрузка…</div></div>`;
}

async function handleAct(btn) {
  const act = btn.dataset.act;
  try {
    if (act === 'login') await startLogin();
    if (act === 'confirm-login') {
      const ok = await tryRecoverLogin(false);
      if (!ok) await pollLogin();
    }
    if (act === 'back-login') {
      clearInterval(state.pollTimer);
      clearPendingLogin();
      state.view = 'login';
      render();
    }
    if (act === 'try-resume') {
      try {
        const data = await api('/api/auth/resume', { method: 'POST', body: '{}' });
        if (data.status === 'ok') {
          toast('Снова в системе');
          await enterAfterAuth(data);
          return;
        }
        toast('Нужен первый вход через Telegram');
        await startLogin();
      } catch (_) {
        await startLogin();
      }
    }
    if (act === 'role-admin') await chooseRole('admin');
    if (act === 'role-coach') await chooseRole('coach');
    if (act === 'role-athlete') await chooseRole('athlete');
    if (act === 'logout') await logout();
    if (act === 'switch-role') { state.view = 'role'; render(); }
    if (act === 'theme-dark') setTheme('dark');
    if (act === 'theme-light') setTheme('light');
    if (act === 'adm-grant') await adminGrantCoach();
    if (act === 'adm-grant-id') {
      await api('/api/admin/grant-coach', { method: 'POST', body: JSON.stringify({ userId: Number(btn.dataset.id) }) });
      toast('Роль тренера выдана');
      await loadAdmin();
      render();
    }
    if (act === 'adm-revoke') await adminRevokeCoach(Number(btn.dataset.id));
    if (act === 'adm-assign') await adminAssign();
    if (act === 'adm-unlink') await adminUnlink(Number(btn.dataset.id));
    if (act === 'add-athlete') await addAthleteByUsername();
    if (act === 'accept') await acceptLink(Number(btn.dataset.id));
    if (act === 'remove') await removeAthlete(Number(btn.dataset.id));
    if (act === 'select-athlete') await selectAthlete(Number(btn.dataset.id));
    if (act === 'tab-plan') { state.coachTab = 'plan'; render(); }
    if (act === 'tab-stats') { state.coachTab = 'stats'; render(); }
    if (act === 'tab-profile') {
      state.coachTab = 'profile';
      await loadDossier(state.selectedAthleteId);
      render();
    }
    if (act === 'ath-tab-plan') { state.athleteTab = 'plan'; render(); }
    if (act === 'ath-tab-stats') { state.athleteTab = 'stats'; render(); }
    if (act === 'ath-tab-profile') {
      state.athleteTab = 'profile';
      await loadDossier(state.user.id);
      render();
    }
    if (act === 'refresh-profile') {
      await loadDossier(dossierTargetId());
      render();
      toast('Профиль обновлён с сервера');
    }
    if (act === 'stats-period') { state.statsPeriod = btn.dataset.period; render(); }
    if (act === 'close-report') closeReportModal();
    if (act === 'submit-report') await submitReportFromModal();
    if (act === 'toggle-chip') btn.classList.toggle('on');
    if (act === 'add-chip') addCustomChip(btn.dataset.chipKey);
    if (act === 'save-profile') await saveProfile();
    if (act === 'add-start') addStartRow();
    if (act === 'del-start') removeStartRow(btn.dataset.id);
    if (act === 'recalc-vdot') await recalcVdotInline();
    if (act === 'apply-pace') applyPaceKey(btn.dataset.paceKey);
    if (act === 'vdot-from-pb') await vdotFromRecords();
    if (act === 'find-coach') await findCoach();
    if (act === 'search-coach') await searchCoaches();
    if (act === 'pick-coach') await pickCoach(Number(btn.dataset.id));
    if (act === 'add-wo') await saveWorkoutForm();
    if (act === 'edit-wo') startEditWorkout(Number(btn.dataset.id));
    if (act === 'cancel-edit-wo') cancelEditWorkout();
    if (act === 'del-wo') await deleteWorkoutById(Number(btn.dataset.id));
    if (act === 'report') openReportModal(Number(btn.dataset.id), btn.dataset.status);
  } catch (err) {
    toast(err.message || 'Ошибка');
  }
}

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) handleAct(btn);
});

app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target?.id === 'coach-search') {
    e.preventDefault();
    searchCoaches().catch((err) => toast(err.message || 'Ошибка'));
  }
  if (e.target?.id === 'coach-user') {
    e.preventDefault();
    findCoach().catch((err) => toast(err.message || 'Ошибка'));
  }
});

$('#modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeReportModal();
  const btn = e.target.closest('[data-act]');
  if (btn) handleAct(btn);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();

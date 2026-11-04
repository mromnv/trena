export const PB_LIST = [
  { k: '5 км', km: 5 },
  { k: '10 км', km: 10 },
  { k: '21,1 км', km: 21.0975 },
  { k: '42,2 км', km: 42.195 },
];

export const VD_DISTS = [
  { k: '1500 м', m: 1500 },
  { k: '1 миля', m: 1609.34 },
  { k: '3 км', m: 3000 },
  { k: '5 км', m: 5000 },
  { k: '10 км', m: 10000 },
  { k: '15 км', m: 15000 },
  { k: 'Полумарафон', m: 21097.5 },
  { k: 'Марафон', m: 42195 },
];

const pad = (n) => String(n).padStart(2, '0');

export function parseTime(s) {
  if (!s) return null;
  const p = s.trim().split(':').map(Number);
  if (p.length < 2 || p.length > 3 || p.some((x) => isNaN(x) || x < 0)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

export function fmtTime(t) {
  t = Math.round(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtPace(s) {
  return fmtTime(s);
}

export function vdFmt(v) {
  return v.toFixed(1).replace('.', ',');
}

export function vdotOf(m, sec) {
  const t = sec / 60;
  const v = m / t;
  return (
    (-4.6 + 0.182258 * v + 0.000104 * v * v) /
    (0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t))
  );
}

export function timeFor(vdot, m) {
  let lo = m / 9;
  let hi = m / 1.2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (vdotOf(m, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function paceAt(vdot, f) {
  const A = 0.000104;
  const B = 0.182258;
  const c = f * vdot + 4.6;
  return 60000 / ((-B + Math.sqrt(B * B + 4 * A * c)) / (2 * A));
}

export function paces(v) {
  const e1 = paceAt(v, 0.59);
  const e2 = paceAt(v, 0.74);
  return {
    E: { ru: 'Лёгкий', slow: e1, fast: e2, p: (e1 + e2) / 2, zone: 2, desc: 'База и восстановление' },
    M: { ru: 'Марафонский', p: timeFor(v, 42195) / 42.195, zone: 3, desc: 'Темп марафона' },
    T: { ru: 'Темповый', p: paceAt(v, 0.88), zone: 4, desc: 'Порог ~88% VO₂max' },
    I: { ru: 'Интервальный', p: paceAt(v, 0.975), zone: 5, desc: 'Интервалы на МПК' },
    R: { ru: 'Повторный', p: paceAt(v, 1.06), zone: 5, desc: 'Короткие повторы' },
  };
}

export function vdotFromPBs(pbs) {
  let best = null;
  PB_LIST.forEach((d) => {
    const raw = pbs?.[d.k]?.now;
    const t = parseTime(raw);
    if (t == null || t <= 0) return;
    const v = vdotOf(d.km * 1000, t);
    if (!best || v > best.v) best = { v, note: `по личному рекорду: ${d.k} ${raw}`, time: raw };
  });
  return best;
}

export function goalLabel(dossier) {
  const today = new Date().toISOString().slice(0, 10);
  const starts = (dossier?.starts || [])
    .filter((s) => s.date && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const s = starts.find((x) => x.prio === 'A') || starts[0];
  if (!s) return 'Цель не задана';
  return `${s.name}${s.goal ? ' · ' + s.goal : ''}`;
}

export const api = window.photobot;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Parse the naive local timestamp 'YYYY-MM-DDTHH:MM:SS' stored in the index. */
export function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtNum = new Intl.NumberFormat();

export const formatMonth = (s) => fmtMonth.format(parseStamp(s));
export const formatDay = (s) => fmtDay.format(parseStamp(s));
export const formatShort = (s) => fmtShort.format(parseStamp(s));
export const formatFull = (s) => fmtFull.format(parseStamp(s));
export const num = (n) => fmtNum.format(n || 0);

export function formatBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h2 = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h2 ? `${h2}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function plural(n, one, many = one + 's') {
  return `${num(n)} ${n === 1 ? one : many}`;
}

export const thumbUrl = (id, s = 320) => `pb://thumb/${id}?s=${s}`;
export const fileUrl = (id) => `pb://file/${id}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function store(key, fallback) {
  try {
    const v = localStorage.getItem('pb.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem('pb.' + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/**
 * Small modal that asks for one value, with optional autocomplete suggestions.
 * @returns {Promise<string|null>}
 */
export function ask({ title, label, placeholder = '', value = '', suggestions = [], ok = 'Save' }) {
  return new Promise((resolve) => {
    const dlg = $('#ask');
    $('#ask-title').textContent = title;
    $('#ask-label').textContent = label;
    const input = $('#ask-input');
    input.value = value;
    input.placeholder = placeholder;
    $('#ask-ok').textContent = ok;
    const dl = $('#ask-list');
    dl.innerHTML = suggestions.map((s) => `<option value="${esc(s)}"></option>`).join('');
    const done = (v) => {
      dlg.close();
      dlg.onclose = null;
      resolve(v);
    };
    $('#ask-form').onsubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      done(v || null);
    };
    $('#ask-cancel').onclick = () => done(null);
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    input.select();
  });
}

export function confirmBox({ title, message, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = message;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    const done = (v) => {
      dlg.onclose = null;
      dlg.close();
      resolve(v);
    };
    okBtn.onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

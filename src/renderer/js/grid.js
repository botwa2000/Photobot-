// Virtualised, grouped photo grid / list. Only rows near the viewport are in the DOM,
// so libraries with tens of thousands of items scroll smoothly.
import { icon } from './icons.js';
import { esc, formatMonth, formatDay, formatShort, formatDuration, formatBytes, plural, thumbUrl, fileUrl } from './util.js';

const SIZES = {
  small: { tile: 110, gap: 3, radius: 4 },
  medium: { tile: 170, gap: 6, radius: 8 },
  large: { tile: 270, gap: 8, radius: 10 },
};
const HEAD_H = 56;
const LIST_H = 56;
const failedThumbs = new Set();

export class Grid {
  /**
   * @param {HTMLElement} scroller scrolling container
   * @param {HTMLElement} host element rows are placed into
   * @param {object} cb callbacks: open(index), selectionChanged()
   */
  constructor(scroller, host, cb) {
    this.scroller = scroller;
    this.host = host;
    this.cb = cb;
    this.items = [];
    this.rows = [];
    this.rendered = new Map();
    this.selected = new Set();
    this.anchor = null;
    this.group = 'month';
    this.size = 'medium';
    this.places = {};
    this.width = 0;
    this.offsetTop = 0;
    this.raf = 0;
    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w && Math.abs(w - this.width) > 1) this.layout(true);
      else this.schedule();
    }).observe(scroller);
    host.addEventListener('click', (e) => this.onClick(e));
    // Originals shown as a fallback that can't be decoded become a neutral placeholder.
    host.addEventListener('error', (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.dataset.orig) t.outerHTML = `<span class="ph">${icon('photos', 28)}</span>`;
      else if (t instanceof HTMLVideoElement) t.outerHTML = `<span class="ph">${icon('video', 28)}</span>`;
    }, true);
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.i) this.cb.open(+e.target.dataset.i);
    });
  }

  setData(items, { group, size, places }) {
    const keep = this.scroller.scrollTop;
    const sameShape = items.length === this.items.length && group === this.group && size === this.size;
    this.items = items;
    this.group = group;
    this.size = size;
    this.places = places || {};
    this.index = new Map(items.map((it, i) => [it.id, i]));
    for (const id of [...this.selected]) if (!this.index.has(id)) this.selected.delete(id);
    this.layout(true);
    if (sameShape) this.scroller.scrollTop = keep;
  }

  groupKey(it) {
    if (this.group === 'month') return it.taken.slice(0, 7);
    if (this.group === 'day') return it.taken.slice(0, 10);
    return '';
  }

  /** Builds the row model: group headers followed by rows of tiles. */
  layout(force) {
    const width = this.host.clientWidth;
    if (!width) return;
    if (!force && width === this.width) return;
    this.width = width;
    const list = this.size === 'list';
    const cfg = SIZES[this.size] || SIZES.medium;
    const cols = list ? 1 : Math.max(1, Math.floor((width + cfg.gap) / (cfg.tile + cfg.gap)));
    const tileW = list ? width : (width - cfg.gap * (cols - 1)) / cols;
    this.cols = cols;
    this.tileW = tileW;
    this.cfg = cfg;
    const rowH = list ? LIST_H : tileW + cfg.gap;
    const rows = [];
    this.yearRow = new Map();
    let y = 0;
    let i = 0;
    const n = this.items.length;
    while (i < n) {
      const key = this.groupKey(this.items[i]);
      let j = i;
      while (j < n && this.groupKey(this.items[j]) === key) j++;
      const year = this.items[i].taken.slice(0, 4);
      if (!this.yearRow.has(year)) this.yearRow.set(year, y);
      if (this.group !== 'all') {
        rows.push({ type: 'head', key, start: i, end: j, y, h: HEAD_H });
        y += HEAD_H + (list ? 4 : 0);
      }
      for (let k = i; k < j; k += cols) {
        const end = Math.min(k + cols, j);
        const yr = this.items[k].taken.slice(0, 4);
        if (!this.yearRow.has(yr)) this.yearRow.set(yr, y);
        rows.push({ type: list ? 'list' : 'tiles', start: k, end, y, h: rowH });
        y += rowH;
      }
      i = j;
    }
    this.rows = rows;
    this.total = y;
    this.host.style.height = `${y}px`;
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.render();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    if (!this.rows.length) return;
    const top = this.scroller.scrollTop - this.host.offsetTop;
    const h = this.scroller.clientHeight;
    const lo = top - h;
    const hi = top + h * 2;
    // Binary search first visible row.
    let a = 0;
    let b = this.rows.length - 1;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.rows[m].y + this.rows[m].h < lo) a = m + 1;
      else b = m;
    }
    const want = new Set();
    for (let r = a; r < this.rows.length && this.rows[r].y < hi; r++) want.add(r);
    for (const [r, el] of this.rendered) {
      if (!want.has(r)) {
        el.remove();
        this.rendered.delete(r);
      }
    }
    for (const r of want) {
      if (this.rendered.has(r)) continue;
      const el = this.renderRow(this.rows[r]);
      this.host.appendChild(el);
      this.rendered.set(r, el);
    }
  }

  renderRow(row) {
    const el = document.createElement('div');
    el.className = 'vrow';
    el.style.top = `${row.y}px`;
    el.style.height = `${row.h}px`;
    if (row.type === 'head') {
      const first = this.items[row.start];
      const count = row.end - row.start;
      const title = this.group === 'month' ? formatMonth(first.taken) : formatDay(first.taken);
      const places = (this.places[row.key] || []).join(' · ');
      el.innerHTML = `<div class="ghead"><h2>${esc(title)}</h2><span class="meta">${places ? icon('pin', 14) + esc(places) + ' · ' : ''}${plural(count, 'item')}</span>
        <button class="btn-outline btn-sm sel-group" data-start="${row.start}" data-end="${row.end}">Select</button></div>`;
      return el;
    }
    if (row.type === 'list') {
      const it = this.items[row.start];
      el.innerHTML = this.listRow(it, row.start);
      this.wireImages(el);
      return el;
    }
    const { gap, radius } = this.cfg;
    const w = this.tileW;
    const px = Math.round(w * (window.devicePixelRatio || 1));
    const s = px > 330 ? 640 : 320;
    let html = `<div class="trow" style="gap:${gap}px;--r:${radius}px">`;
    for (let i = row.start; i < row.end; i++) html += this.tile(this.items[i], i, w, s);
    el.innerHTML = html + '</div>';
    this.wireImages(el);
    return el;
  }

  tile(it, i, w, s) {
    const sel = this.selected.has(it.id);
    const rot = it.rotation ? `style="transform:rotate(${it.rotation}deg)${it.rotation % 180 ? ' scale(1.01)' : ''}"` : '';
    const media = failedThumbs.has(it.id) ? this.fallback(it) : `<img src="${thumbUrl(it.id, s)}" alt="" decoding="async" draggable="false" data-id="${it.id}" ${rot}>`;
    const dur = it.kind === 'video' ? `<span class="vbadge">${icon('play', 10)}${esc(formatDuration(it.duration))}</span>` : '';
    const fav = it.fav ? `<span class="fav">${icon('heart', 16)}</span>` : '';
    return `<button class="tile${sel ? ' sel' : ''}" data-i="${i}" style="width:${w}px;height:${w}px" title="${esc(it.name)} · ${esc(formatShort(it.taken))}">
      ${media}${dur}${fav}<span class="chk" data-chk="1">${icon('check', 14)}</span></button>`;
  }

  fallback(it) {
    if (it.kind === 'video') return `<video src="${fileUrl(it.id)}#t=1" muted preload="metadata" tabindex="-1"></video>`;
    // No thumbnail: let this sandboxed window decode a browser-safe original, unless it's huge.
    const small = !it.width || !it.height || it.width * it.height <= 40e6;
    if (small && /^(jpe?g|jpe|jfif|png|webp|gif|bmp|avif)$/.test(it.ext)) {
      return `<img src="${fileUrl(it.id)}" alt="" loading="lazy" decoding="async" draggable="false" class="loaded" data-orig="1">`;
    }
    return `<span class="ph">${icon('photos', 28)}</span>`;
  }

  wireImages(el) {
    for (const img of el.querySelectorAll('img[data-id]')) {
      if (img.complete && img.naturalWidth) img.classList.add('loaded');
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => {
        if (img.dataset.orig) {
          img.outerHTML = `<span class="ph">${icon('photos', 28)}</span>`;
          return;
        }
        const id = +img.dataset.id;
        failedThumbs.add(id);
        const it = this.items[this.index.get(id)];
        if (it) img.outerHTML = this.fallback(it);
      }, { once: true });
    }
  }

  listRow(it, i) {
    const sel = this.selected.has(it.id) ? ' sel' : '';
    const place = [it.city, it.country].filter(Boolean).join(', ');
    const thumb = failedThumbs.has(it.id) ? this.fallback(it) : `<img src="${thumbUrl(it.id, 320)}" alt="" draggable="false" data-id="${it.id}" class="loaded">`;
    const what = it.kind === 'video' ? `Video ${formatDuration(it.duration)}` : (it.width ? `${it.width} × ${it.height}` : 'Photo');
    return `<button class="lrow${sel}" data-i="${i}">
      <span class="lt">${thumb}</span>
      <span class="c name">${esc(it.name)}</span>
      <span class="c">${esc(formatShort(it.taken))}</span>
      <span class="c">${esc(place || '—')}</span>
      <span class="c">${esc(what)}</span>
      <span class="c r">${esc(formatBytes(it.size))}</span></button>`;
  }

  onClick(e) {
    const groupBtn = e.target.closest('.sel-group');
    if (groupBtn) {
      const a = +groupBtn.dataset.start;
      const b = +groupBtn.dataset.end;
      const all = this.items.slice(a, b).every((it) => this.selected.has(it.id));
      for (let k = a; k < b; k++) {
        if (all) this.selected.delete(this.items[k].id);
        else this.selected.add(this.items[k].id);
      }
      this.refreshSelection();
      return;
    }
    const t = e.target.closest('[data-i]');
    if (!t) return;
    const i = +t.dataset.i;
    const it = this.items[i];
    const selecting = this.selected.size > 0;
    if (e.shiftKey && this.anchor != null) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      for (let k = a; k <= b; k++) this.selected.add(this.items[k].id);
      this.refreshSelection();
    } else if (e.ctrlKey || e.metaKey || e.target.closest('[data-chk]') || selecting) {
      if (this.selected.has(it.id)) this.selected.delete(it.id);
      else this.selected.add(it.id);
      this.anchor = i;
      this.refreshSelection();
    } else {
      this.anchor = i;
      this.cb.open(i);
    }
  }

  selectAll() {
    for (const it of this.items) this.selected.add(it.id);
    this.refreshSelection();
  }

  clearSelection() {
    this.selected.clear();
    this.refreshSelection();
  }

  refreshSelection() {
    for (const el of this.host.querySelectorAll('[data-i]')) {
      const it = this.items[+el.dataset.i];
      el.classList.toggle('sel', !!it && this.selected.has(it.id));
    }
    this.scroller.classList.toggle('selecting', this.selected.size > 0);
    this.cb.selectionChanged();
  }

  /** Re-render visible rows (after favorite/rotation changes). */
  refresh() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.render();
  }

  scrollToYear(year) {
    const y = this.yearRow?.get(String(year));
    if (y != null) this.scroller.scrollTop = this.host.offsetTop + y - 8;
  }

  scrollToIndex(i) {
    const row = this.rows.find((r) => r.type !== 'head' && i >= r.start && i < r.end);
    if (!row) return;
    const top = this.host.offsetTop + row.y;
    const st = this.scroller.scrollTop;
    const h = this.scroller.clientHeight;
    if (top < st || top + row.h > st + h) this.scroller.scrollTop = top - h / 3;
  }

  /** Year of the row at the top of the viewport (for the scrubber highlight). */
  currentYear() {
    const top = this.scroller.scrollTop - this.host.offsetTop;
    const row = this.rows.find((r) => r.y + r.h > top);
    return row ? this.items[row.start]?.taken.slice(0, 4) : null;
  }
}

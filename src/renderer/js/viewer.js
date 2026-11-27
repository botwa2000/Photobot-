// Full-window viewer: photo/video, zoom & pan, filmstrip, details, tags and people.
import { icon } from './icons.js';
import { api, $, esc, formatFull, formatBytes, formatDuration, thumbUrl, fileUrl, toast } from './util.js';

export class Viewer {
  constructor(root, { onChange, onFilter }) {
    this.root = root;
    this.onChange = onChange;
    this.onFilter = onFilter;
    this.items = [];
    this.i = 0;
    this.infoOpen = localStorage.getItem('pb.viewerInfo') !== '0';
    this.zoom = 1;
    this.fit = 1;
    this.pan = { x: 0, y: 0 };
    this.slideshow = null;
    this.peopleNames = [];
    this.tagNames = [];
    this.onKey = this.onKey.bind(this);
    root.addEventListener('error', (e) => {
      if (e.target.matches?.('.v-fallback img')) e.target.remove();
    }, true);
  }

  async open(items, i) {
    this.items = items;
    this.i = i;
    this.root.hidden = false;
    document.addEventListener('keydown', this.onKey, true);
    const [people, tags] = await Promise.all([api.people(), api.tags()]);
    this.peopleNames = people.map((p) => p.name);
    this.tagNames = tags.map((t) => t.name);
    this.show();
  }

  close() {
    this.stopSlideshow();
    this.root.hidden = true;
    this.root.innerHTML = '';
    document.removeEventListener('keydown', this.onKey, true);
    this.onChange?.({ closed: true, index: this.i });
  }

  get cur() {
    return this.items[this.i];
  }

  go(d) {
    const n = this.items.length;
    if (!n) return;
    const next = this.i + d;
    if (next < 0 || next >= n) {
      if (this.slideshow) this.i = (next + n) % n;
      else return;
    } else this.i = next;
    this.show();
  }

  async show() {
    const base = this.cur;
    if (!base) return this.close();
    const it = await api.item(base.id);
    if (!it) {
      this.items.splice(this.i, 1);
      if (this.i >= this.items.length) this.i = this.items.length - 1;
      return this.show();
    }
    if (this.cur?.id !== it.id) return; // user moved on
    this.it = it;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.render();
    this.preload();
  }

  preload() {
    for (const d of [1, -1, 2]) {
      const n = this.items[this.i + d];
      if (n && n.kind === 'photo') {
        const img = new Image();
        img.src = /^(jpe?g|jfif|jpe|png|webp|gif|bmp|avif)$/.test(n.ext) ? fileUrl(n.id) : thumbUrl(n.id, 2560);
      }
    }
  }

  render() {
    const it = this.it;
    const fav = !!it.fav;
    this.root.innerHTML = `
      <header class="v-top">
        <button class="v-btn" data-a="close" title="Back (Esc)">${icon('back')}Library</button>
        <div class="ttl"><b>${esc(it.name)}</b><span>${this.i + 1} of ${this.items.length}</span></div>
        <div class="acts">
          <button class="v-btn ${fav ? 'faved' : ''}" data-a="fav" aria-pressed="${fav}" title="Favorite (F)" aria-label="Favorite">${icon('heart', 20)}</button>
          ${it.kind === 'photo' ? `<button class="v-btn" data-a="rotate" title="Rotate (R)" aria-label="Rotate">${icon('rotate', 20)}</button>` : ''}
          <button class="v-btn" data-a="slideshow" aria-pressed="${!!this.slideshow}" title="Slideshow (S)" aria-label="Slideshow">${icon(this.slideshow ? 'pause' : 'slideshow', 20)}</button>
          <button class="v-btn" data-a="folder" title="Show in folder" aria-label="Show in folder">${icon('folder', 20)}</button>
          <button class="v-btn" data-a="external" title="Open with default app" aria-label="Open with default app">${icon('external', 20)}</button>
          <button class="v-btn" data-a="delete" title="Delete (Del)" aria-label="Delete">${icon('trash', 20)}</button>
          <button class="v-btn" data-a="info" aria-pressed="${this.infoOpen}" title="Info (I)">${icon('info')}Info</button>
        </div>
      </header>
      <div class="v-main">
        <div class="v-stage-wrap">
          <div class="v-stage" id="v-stage">
            ${this.mediaHtml(it)}
            <button class="v-nav prev" data-a="prev" aria-label="Previous" ${this.i === 0 ? 'hidden' : ''}>${icon('back', 22)}</button>
            <button class="v-nav next" data-a="next" aria-label="Next" ${this.i >= this.items.length - 1 ? 'hidden' : ''}>${icon('next', 22)}</button>
            ${it.kind === 'photo' ? `<div class="v-zoom"><button class="v-btn" data-a="zoomout" aria-label="Zoom out">${icon('zoomOut')}</button><span id="v-zoomlabel">Fit</span><button class="v-btn" data-a="zoomin" aria-label="Zoom in">${icon('zoomIn')}</button></div>` : ''}
          </div>
          <div class="v-strip" id="v-strip">${this.stripHtml()}</div>
        </div>
        ${this.infoOpen ? `<aside class="v-info" aria-label="Details">${this.infoHtml(it)}</aside>` : ''}
      </div>`;
    this.wire();
  }

  mediaHtml(it) {
    if (it.kind === 'video') {
      if (it.native) return `<video class="v-media" id="v-media" src="${fileUrl(it.id)}" controls autoplay></video>`;
      return this.fallbackHtml(it, "This video format can't be played inside Photobot.");
    }
    const src = it.native ? fileUrl(it.id) : thumbUrl(it.id, 2560);
    return `<img class="v-media" id="v-media" src="${src}" alt="${esc(it.name)}" draggable="false">`;
  }

  fallbackHtml(it, msg) {
    return `<div class="v-fallback"><img src="${thumbUrl(it.id, 1024)}" alt="">
      <span>${esc(msg)}</span><button class="btn-primary" data-a="external">${icon('external')}Open with default app</button></div>`;
  }

  stripHtml() {
    const a = Math.max(0, this.i - 25);
    const b = Math.min(this.items.length, this.i + 26);
    let html = '';
    for (let k = a; k < b; k++) {
      const s = this.items[k];
      html += `<button data-k="${k}" class="${k === this.i ? 'on' : ''}" style="background-image:url('${thumbUrl(s.id, 320)}')" aria-label="${esc(s.name)}"></button>`;
    }
    return html;
  }

  infoHtml(it) {
    const srcNote = { filename: ' (from file name)', file: ' (file date — no camera date)', video: '', exif: '' }[it.taken_src] || '';
    const exp = it.exposure ? (it.exposure < 1 ? `1/${Math.round(1 / it.exposure)}s` : `${it.exposure}s`) : '';
    const camBits = [it.camera, it.fnum && `f/${+it.fnum.toFixed(1)}`, exp, it.iso && `ISO ${it.iso}`, it.focal && `${Math.round(it.focal)} mm`].filter(Boolean);
    const place = [it.city, it.country].filter(Boolean).join(', ');
    const coords = it.lat != null ? `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}` : '';
    const dims = [it.width && `${it.width} × ${it.height}`, it.duration && formatDuration(it.duration), formatBytes(it.size), it.ext.toUpperCase()].filter(Boolean).join(' · ');
    const chip = (kind, x) => `<span class="v-chip"><button class="btn-ghost" style="height:auto;padding:0;font-weight:500" data-filter="${kind}" data-v="${esc(x.name)}">${esc(x.name)}</button>
      <button class="x" data-remove="${kind}" data-v="${esc(x.name)}" aria-label="Remove ${esc(x.name)}" title="${x.source === 'file' ? 'Saved in the file — removing hides it in Photobot only' : 'Remove'}">×</button></span>`;
    return `
      <section class="v-sec"><h3>Taken</h3><span class="big">${esc(formatFull(it.taken))}</span><span class="dim">${esc(srcNote.trim())}</span>
        ${camBits.length ? `<span class="dim">${esc(camBits.join(' · '))}</span>` : ''}${it.lens ? `<span class="dim">${esc(it.lens)}</span>` : ''}</section>
      <section class="v-sec"><h3>Place</h3>
        ${place ? `<button class="v-chip link" data-filter="place" data-city="${esc(it.city || '')}" data-country="${esc(it.country || '')}">${icon('pin', 14)}${esc(place)}</button>` : '<span class="dim">No location saved in this file.</span>'}
        ${coords ? `<span class="dim">${coords} · <a href="https://www.openstreetmap.org/?mlat=${+it.lat}&mlon=${+it.lon}#map=15/${+it.lat}/${+it.lon}" target="_blank" rel="noreferrer" title="Opens OpenStreetMap in your browser — this sends the location online">Open map (online)</a></span>` : ''}</section>
      <section class="v-sec"><h3>People</h3>
        <div class="v-chips">${it.people.map((p) => chip('person', p)).join('') || '<span class="dim">Nobody tagged yet.</span>'}</div>
        <label class="v-add">${icon('plus', 14)}<span class="sr-only">Add person</span><input id="v-add-person" list="v-people" placeholder="Add a person…"></label>
        <datalist id="v-people">${this.peopleNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist></section>
      <section class="v-sec"><h3>Tags</h3>
        <div class="v-chips">${it.tags.map((t) => chip('tag', t)).join('') || '<span class="dim">No tags yet.</span>'}</div>
        <label class="v-add">${icon('plus', 14)}<span class="sr-only">Add tag</span><input id="v-add-tag" list="v-tags" placeholder="Add a tag…"></label>
        <datalist id="v-tags">${this.tagNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist></section>
      <section class="v-sec"><h3>File</h3><span class="dim" style="word-break:break-all">${esc(it.path)}</span><span class="dim">${esc(dims)}</span>
        <button class="btn-outline btn-sm" style="align-self:flex-start;background:transparent;color:#E8EBEF;border-color:#333B45" data-a="folder">${icon('folder', 14)}Show in folder</button></section>`;
  }

  wire() {
    const root = this.root;
    root.onclick = (e) => {
      const k = e.target.closest('[data-k]');
      if (k) {
        this.i = +k.dataset.k;
        this.show();
        return;
      }
      const f = e.target.closest('[data-filter]');
      if (f) {
        const kind = f.dataset.filter;
        const value = kind === 'place' ? { city: f.dataset.city || null, country: f.dataset.country } : f.dataset.v;
        this.close();
        this.onFilter(kind, value);
        return;
      }
      const r = e.target.closest('[data-remove]');
      if (r) {
        this.removeLabel(r.dataset.remove, r.dataset.v);
        return;
      }
      const a = e.target.closest('[data-a]');
      if (a) this.action(a.dataset.a);
    };
    const addOn = (id, fn) => {
      const input = $(id, root);
      if (!input) return;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          fn(input.value.trim());
        }
        e.stopPropagation();
      });
    };
    addOn('#v-add-person', async (name) => {
      await api.addPerson([this.it.id], name);
      if (!this.peopleNames.includes(name)) this.peopleNames.push(name);
      await this.reload();
      $('#v-add-person', this.root)?.focus();
    });
    addOn('#v-add-tag', async (name) => {
      await api.addTag([this.it.id], name);
      if (!this.tagNames.includes(name)) this.tagNames.push(name);
      await this.reload();
      $('#v-add-tag', this.root)?.focus();
    });
    const strip = $('#v-strip', root);
    strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    this.setupMedia();
  }

  setupMedia() {
    const stage = $('#v-stage', this.root);
    const media = $('#v-media', this.root);
    if (!media) return;
    const it = this.it;
    const fitNow = () => {
      const nw = media.naturalWidth || media.videoWidth || it.width || 1600;
      const nh = media.naturalHeight || media.videoHeight || it.height || 1200;
      const turned = it.rotation % 180 !== 0;
      const bw = turned ? nh : nw;
      const bh = turned ? nw : nh;
      const sw = stage.clientWidth - 120;
      const sh = stage.clientHeight - (it.kind === 'photo' ? 70 : 20);
      this.fit = Math.min(1, sw / bw, sh / bh);
      media.style.width = `${nw}px`;
      media.style.height = `${nh}px`;
      this.apply();
    };
    this.apply = () => {
      const z = this.fit * this.zoom;
      media.style.transform = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) rotate(${it.rotation || 0}deg) scale(${z})`;
      stage.classList.toggle('zoomed', this.zoom > 1);
      const lbl = $('#v-zoomlabel', this.root);
      if (lbl) lbl.textContent = this.zoom === 1 ? 'Fit' : `${Math.round(z * 100)}%`;
    };
    if (media.tagName === 'IMG') {
      if (media.complete && media.naturalWidth) fitNow();
      else media.addEventListener('load', fitNow, { once: true });
      media.addEventListener('error', () => {
        if (it.native) {
          // e.g. a JPEG Chromium can't decode: try the system thumbnailer instead.
          it.native = false;
          media.src = thumbUrl(it.id, 2560);
        } else {
          media.outerHTML = this.fallbackHtml(it, "Photobot can't display this file. On Windows, installing the free HEIF or Raw Image Extension from the Microsoft Store adds support.");
        }
      });
      this.ro?.disconnect();
      this.ro = new ResizeObserver(fitNow);
      this.ro.observe(stage);
    } else {
      media.addEventListener('loadedmetadata', fitNow, { once: true });
      media.addEventListener('error', () => {
        media.outerHTML = this.fallbackHtml(it, "This video can't be played inside Photobot.");
      });
      fitNow();
    }

    stage.onwheel = (e) => {
      if (it.kind !== 'photo') return;
      e.preventDefault();
      const old = this.zoom;
      this.zoom = Math.min(12, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (this.zoom === 1) this.pan = { x: 0, y: 0 };
      else {
        const r = stage.getBoundingClientRect();
        const cx = e.clientX - r.left - r.width / 2;
        const cy = e.clientY - r.top - r.height / 2;
        const k = this.zoom / old;
        this.pan = { x: cx - (cx - this.pan.x) * k, y: cy - (cy - this.pan.y) * k };
      }
      this.apply();
    };
    stage.ondblclick = (e) => {
      if (it.kind !== 'photo' || e.target.closest('button')) return;
      this.setZoom(this.zoom > 1 ? 1 : Math.max(2, 1 / this.fit));
    };
    let drag = null;
    stage.onpointerdown = (e) => {
      if (this.zoom <= 1 || e.target.closest('button')) return;
      drag = { x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
    };
    stage.onpointermove = (e) => {
      if (!drag) return;
      this.pan = { x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y };
      this.apply();
    };
    stage.onpointerup = () => {
      drag = null;
      stage.classList.remove('dragging');
    };
  }

  setZoom(z) {
    this.zoom = Math.min(12, Math.max(1, z));
    if (this.zoom === 1) this.pan = { x: 0, y: 0 };
    this.apply?.();
  }

  async reload() {
    const it = await api.item(this.it.id);
    if (!it) return;
    this.it = it;
    const info = $('.v-info', this.root);
    if (info) {
      info.innerHTML = this.infoHtml(it);
      this.wire();
    }
    this.onChange?.({ changed: true });
  }

  async removeLabel(kind, name) {
    if (kind === 'person') await api.removePerson(this.it.id, name);
    else await api.removeTag(this.it.id, name);
    await this.reload();
  }

  async action(a) {
    const it = this.it;
    switch (a) {
      case 'close': return this.close();
      case 'prev': return this.go(-1);
      case 'next': return this.go(1);
      case 'zoomin': return this.setZoom(this.zoom * 1.5);
      case 'zoomout': return this.setZoom(this.zoom / 1.5);
      case 'fav': {
        const fav = !it.fav;
        await api.setFav([it.id], fav);
        it.fav = fav ? 1 : 0;
        this.cur.fav = it.fav;
        const b = this.root.querySelector('[data-a="fav"]');
        b.classList.toggle('faved', fav);
        b.setAttribute('aria-pressed', fav);
        this.onChange?.({ changed: true });
        return;
      }
      case 'rotate': {
        const rot = ((it.rotation || 0) + 90) % 360;
        await api.rotate(it.id, rot);
        it.rotation = rot;
        this.cur.rotation = rot;
        this.setupMedia();
        this.onChange?.({ changed: true });
        return;
      }
      case 'slideshow':
        if (this.slideshow) this.stopSlideshow();
        else this.slideshow = setInterval(() => this.go(1), 4000);
        return this.render();
      case 'folder': return api.showInFolder(it.id);
      case 'external': return api.openExternal(it.id);
      case 'delete': {
        const r = await api.trash([it.id]);
        if (r.deleted) {
          this.items.splice(this.i, 1);
          if (this.i >= this.items.length) this.i = this.items.length - 1;
          toast('Moved to the Recycle Bin');
          if (this.items.length) this.show();
          else this.close();
        }
        return;
      }
      case 'info':
        this.infoOpen = !this.infoOpen;
        localStorage.setItem('pb.viewerInfo', this.infoOpen ? '1' : '0');
        return this.render();
      default:
    }
  }

  stopSlideshow() {
    clearInterval(this.slideshow);
    this.slideshow = null;
  }

  onKey(e) {
    if (this.root.hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    const map = {
      Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next', f: 'fav', F: 'fav', r: 'rotate', R: 'rotate', i: 'info', I: 'info',
      s: 'slideshow', S: 'slideshow', Delete: 'delete', '+': 'zoomin', '=': 'zoomin', '-': 'zoomout',
    };
    if (e.key === '0') {
      this.setZoom(1);
    } else if (e.key === ' ' && this.it?.kind === 'video') {
      const v = $('#v-media', this.root);
      if (v && v.tagName === 'VIDEO') v.paused ? v.play() : v.pause();
    } else if (map[e.key]) {
      if (map[e.key] === 'rotate' && this.it?.kind !== 'photo') return;
      this.action(map[e.key]);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
}

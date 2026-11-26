// People, Places, Tags, Folders and Settings pages.
import { icon } from './icons.js';
import { api, esc, num, plural, thumbUrl, ask, confirmBox, toast } from './util.js';

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

const bg = (id, s = 320) => (id ? `style="background-image:url('${thumbUrl(id, s)}')"` : '');

export async function renderPeople(el, { onPick }) {
  const people = await api.people();
  el.innerHTML = `
    <div class="page-head"><h1>People</h1><span class="sub">${people.length ? plural(people.length, 'person', 'people') : ''}</span></div>
    ${people.length ? `<div class="people-grid">${people.map((p) => `
      <div class="pcard" role="button" tabindex="0" data-name="${esc(p.name)}">
        <span class="face" ${bg(p.cover)}>${p.cover ? '' : icon('person', 40)}</span>
        <b>${esc(p.name)}</b><span>${plural(p.n, 'item')}</span>
        <button class="edit" data-rename="${esc(p.name)}" aria-label="Rename ${esc(p.name)}" title="Rename or merge">${icon('pencil', 16)}</button>
      </div>`).join('')}</div>` : ''}
    <div class="info-card">
      <h2>${people.length ? 'Tag more people' : 'No people yet'}</h2>
      <p>People come from name tags already saved in your photos (by Windows Photo Gallery, Lightroom, Picasa, digiKam and others) and from names you add yourself.</p>
      <p>To tag someone: open a photo and type their name under <b>People</b>, or select several photos in the library and choose <b>Add person</b>.</p>
    </div>`;
  el.onclick = async (e) => {
    const r = e.target.closest('[data-rename]');
    if (r) {
      e.stopPropagation();
      const from = r.dataset.rename;
      const to = await ask({ title: 'Rename person', label: 'Name (use an existing name to merge)', value: from, suggestions: people.map((p) => p.name) });
      if (to && to !== from) {
        await api.renamePerson(from, to);
        toast(`Renamed to ${to}`);
        renderPeople(el, { onPick });
      }
      return;
    }
    const c = e.target.closest('[data-name]');
    if (c) onPick('person', c.dataset.name);
  };
  el.onkeydown = (e) => {
    const c = e.target.closest('[data-name]');
    if (c && e.key === 'Enter') onPick('person', c.dataset.name);
  };
}

export async function renderPlaces(el, { onPick }) {
  const rows = await api.places();
  const byCountry = new Map();
  for (const r of rows) {
    if (!byCountry.has(r.country)) byCountry.set(r.country, { n: 0, cities: [] });
    const c = byCountry.get(r.country);
    c.n += r.n;
    c.cities.push(r);
  }
  const countries = [...byCountry.entries()].sort((a, b) => b[1].n - a[1].n);
  const range = (r) => {
    const a = r.first.slice(0, 4);
    const b = r.last.slice(0, 4);
    return a === b ? a : `${a} – ${b}`;
  };
  el.innerHTML = `
    <div class="page-head"><h1>Places</h1><span class="sub">${rows.length ? `${plural(countries.length, 'country', 'countries')} · ${plural(rows.filter((r) => r.city).length, 'place')}` : ''}</span></div>
    ${countries.map(([country, c]) => `
      <section class="country">
        <h2><button class="link-btn" style="font-size:16px;color:inherit;padding:0" data-country="${esc(country)}">${esc(country)}</button><span>${plural(c.n, 'item')}</span></h2>
        <div class="place-grid">${c.cities.map((r) => `
          <button class="plcard" data-city="${esc(r.city || '')}" data-country="${esc(country)}">
            <span class="cv" ${bg(r.cover)}></span>
            <span class="t"><b>${esc(r.city || 'Other places')}</b><span>${plural(r.n, 'item')} · ${esc(range(r))}</span></span>
          </button>`).join('')}</div>
      </section>`).join('')}
    ${rows.length ? '' : `<div class="info-card"><h2>No places yet</h2>
      <p>Places come from the GPS location your phone or camera saves in each photo and video. Photos without a location won't appear here.</p></div>`}
    <p class="muted small">Place names from GeoNames (CC BY 4.0), looked up on this PC — nothing is sent online.</p>`;
  el.onclick = (e) => {
    const p = e.target.closest('[data-country]');
    if (!p) return;
    onPick('place', { city: p.dataset.city || null, country: p.dataset.country });
  };
  el.onkeydown = null;
}

export async function renderTags(el, { onPick }) {
  const tags = await api.tags();
  el.innerHTML = `
    <div class="page-head"><h1>Tags</h1><span class="sub">${tags.length ? plural(tags.length, 'tag') : ''}</span></div>
    ${tags.length ? `<div class="tag-cloud">${tags.map((t) => `<button class="chip" data-tag="${esc(t.name)}"><span>${esc(t.name)}</span><small>${num(t.n)}</small></button>`).join('')}</div>`
    : `<div class="info-card"><h2>No tags yet</h2><p>Keywords already saved in your photos are imported automatically. Add your own in the photo viewer, or select several photos and choose <b>Add tag</b>.</p></div>`}`;
  el.onclick = (e) => {
    const t = e.target.closest('[data-tag]');
    if (t) onPick('tag', t.dataset.tag);
  };
  el.onkeydown = null;
}

const TYPE_LABELS = {
  jpg: 'JPG', png: 'PNG', heic: 'HEIC / AVIF', webp: 'WEBP', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', raw: 'RAW (DNG, CR2, NEF, ARW…)',
  mp4: 'MP4', mov: 'MOV', othervideo: 'Other video (AVI, MKV, WMV…)',
};

export async function renderFolders(el, { refreshNav }) {
  const [folders, s] = await Promise.all([api.folders(), api.getSettings()]);
  const statusLabel = (f) => {
    if (f.progress && f.progress.phase !== 'done') return f.progress.phase === 'queued' ? 'Waiting' : 'Scanning';
    return { ready: 'Watching', new: 'New', scanning: 'Scanning', offline: 'Not connected' }[f.status] || f.status;
  };
  const statusClass = (f) => (f.progress && f.progress.phase !== 'done' ? 'scanning' : f.status);
  const detail = (f) => {
    const p = f.progress;
    if (p && p.phase === 'counting') return `<div class="bar indeterminate"><div class="bar-fill"></div></div><span class="muted small">Looking for photos… ${num(p.total)} found</span>`;
    if (p && p.phase === 'reading') {
      const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
      return `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div><span class="muted small">Reading ${num(p.done)} of ${num(p.total)} · ${pct}%</span>`;
    }
    if (p && p.phase === 'queued') return '<span class="muted small">Waiting for another folder to finish…</span>';
    if (f.status === 'offline') return `<span class="muted small">${plural(f.itemCount, 'item')} · drive or folder not available right now</span>`;
    return `<span class="muted small">${plural(f.itemCount, 'item')}${f.lastScan ? ` · last checked ${new Date(f.lastScan).toLocaleString()}` : ''}</span>`;
  };
  el.innerHTML = `
    <div class="page-head" style="align-items:flex-start">
      <div style="display:flex;flex-direction:column;gap:4px"><h1>Folders</h1>
        <span class="muted">Photobot scans these folders and all their subfolders. Your files are never moved or changed.</span></div>
      <button class="btn-primary" style="margin-left:auto;height:42px" data-add>${icon('plus')}Add folder</button>
    </div>
    <div class="folder-list">
      ${folders.map((f) => `
        <div class="frow" data-id="${f.id}">
          <span class="fi">${icon('folder', 22)}</span>
          <div class="fb"><b>${esc(f.path)}</b>${detail(f)}</div>
          <span class="status ${statusClass(f)}">${esc(statusLabel(f))}</span>
          <button class="btn-outline btn-sm" data-rescan="${f.id}">${icon('refresh', 14)}Rescan</button>
          <button class="btn-outline btn-sm icon-btn" data-remove="${f.id}" aria-label="Remove folder" title="Remove from Photobot">${icon('x', 16)}</button>
        </div>`).join('')}
      <button class="dropzone" data-add>${icon('plus')}Drop a folder here, or click to choose one</button>
    </div>
    <div class="cards2">
      <div class="info-card">
        <h2>What to include</h2>
        <div class="chips">${Object.entries(TYPE_LABELS).map(([k, label]) => `<button class="chip" aria-pressed="${s.types[k] !== false}" data-type="${k}"><span>${label}</span></button>`).join('')}</div>
        <p class="small">Changes apply on the next scan. Hidden and system folders are always skipped.</p>
      </div>
      <div class="info-card" style="gap:2px">
        <h2 style="margin-bottom:6px">Scanning</h2>
        <div class="switch-row"><span class="t"><b>Watch for new files</b><span>New, changed and deleted photos are picked up automatically</span></span>
          <button class="switch" role="switch" aria-checked="${s.watch}" aria-label="Watch for new files" data-opt="watch"></button></div>
        <div class="switch-row"><span class="t"><b>Skip tiny images</b><span>Ignores icons and thumbnails smaller than 20 KB</span></span>
          <button class="switch" role="switch" aria-checked="${s.skipSmall}" aria-label="Skip tiny images" data-opt="skipSmall"></button></div>
      </div>
    </div>
    <div class="note">${icon('shield')}<span><b>Private by design.</b> The photo index, tags, people and thumbnails stay on this PC. Nothing is uploaded.</span></div>`;

  el.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-add]')) {
      const added = await api.addFolders();
      if (added.length) toast(`Added ${plural(added.length, 'folder')} — scanning…`);
      refreshNav();
      return renderFolders(el, { refreshNav });
    }
    const rs = t.closest('[data-rescan]');
    if (rs) {
      await api.rescan(+rs.dataset.rescan);
      return renderFolders(el, { refreshNav });
    }
    const rm = t.closest('[data-remove]');
    if (rm) {
      const f = folders.find((x) => x.id === +rm.dataset.remove);
      const ok = await confirmBox({
        title: 'Remove folder?', ok: 'Remove', danger: true,
        message: `${f.path} and its ${num(f.itemCount)} items will be removed from Photobot. The files on your disk are not touched.`,
      });
      if (!ok) return;
      await api.removeFolder(f.id);
      refreshNav();
      return renderFolders(el, { refreshNav });
    }
    const ty = t.closest('[data-type]');
    if (ty) {
      const on = ty.getAttribute('aria-pressed') !== 'true';
      ty.setAttribute('aria-pressed', on);
      await api.setSettings({ types: { [ty.dataset.type]: on } });
      return;
    }
    const op = t.closest('[data-opt]');
    if (op) {
      const on = op.getAttribute('aria-checked') !== 'true';
      op.setAttribute('aria-checked', on);
      await api.setSettings({ [op.dataset.opt]: on });
    }
  };
  el.onkeydown = null;
}

export async function renderSettings(el) {
  const [s, info, stats] = await Promise.all([api.getSettings(), api.info(), api.stats()]);
  const themes = [['system', 'Same as Windows'], ['light', 'Light'], ['dark', 'Dark']];
  el.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="cards2">
      <div class="info-card"><h2>Appearance</h2>
        <div class="chips">${themes.map(([k, l]) => `<button class="chip" aria-pressed="${s.theme === k}" data-theme="${k}"><span>${l}</span></button>`).join('')}</div></div>
      <div class="info-card"><h2>Library</h2>
        <p>${num(stats.photos)} photos · ${num(stats.videos)} videos · ${num(stats.favorites)} favorites</p>
        <p class="small" style="word-break:break-all">Index and thumbnails are stored in ${esc(info.dataDir)}</p>
        <div><button class="btn-outline btn-sm" data-open-data>${icon('folder', 14)}Open data folder</button></div></div>
      <div class="info-card"><h2>About Photobot</h2>
        <p>Version ${esc(info.version)}</p>
        <p class="small">Keyboard: ← → next/previous · F favorite · R rotate · I info · S slideshow · Del delete · Ctrl+K search · Ctrl+A select all · Esc close</p>
        <p class="small">Place names: GeoNames, licensed CC BY 4.0.</p></div>
    </div>`;
  el.onclick = async (e) => {
    const th = e.target.closest('[data-theme]');
    if (th) {
      await api.setSettings({ theme: th.dataset.theme });
      applyTheme(th.dataset.theme);
      return renderSettings(el);
    }
    if (e.target.closest('[data-open-data]')) api.openDataDir();
  };
  el.onkeydown = null;
}

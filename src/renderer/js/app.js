import { icon } from './icons.js';
import { api, $, $$, esc, num, plural, thumbUrl, debounce, store, save, toast, ask } from './util.js';
import { Grid } from './grid.js';
import { Viewer } from './viewer.js';
import { renderPeople, renderPlaces, renderTags, renderFolders, renderSettings } from './pages.js';

const emptyFilter = () => ({ kinds: [], fav: false, tags: [], people: [], places: [], cameras: [], from: '', to: '', text: '', year: null, folderId: null });

const state = {
  route: 'library',
  base: 'all',
  group: store('group', 'month'),
  size: store('size', 'medium'),
  filtersOpen: store('filtersOpen', false),
  filter: emptyFilter(),
  folders: [],
  stats: null,
  years: [],
};

// Paint icons declared in the static markup.
for (const el of $$('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
$('#brand-mark').innerHTML = icon('logo', 18);

const scroller = $('#scroller');
const grid = new Grid(scroller, $('#vlist'), {
  open: (i) => viewer.open(grid.items.slice(), i),
  selectionChanged: updateSelbar,
});
let viewerDirty = false;
const viewer = new Viewer($('#viewer'), {
  onChange: (e) => {
    if (e.changed) viewerDirty = true;
    if (e.closed) {
      if (viewerDirty) {
        viewerDirty = false;
        loadLibrary().then(() => grid.scrollToIndex(e.index));
      } else grid.scrollToIndex(e.index);
    }
  },
  onFilter: (kind, value) => pick(kind, value),
});

// ---------------- effective filter ----------------
function effectiveFilter() {
  const f = { ...state.filter };
  if (state.base === 'videos') f.kinds = ['video'];
  if (state.base === 'favorites') f.fav = true;
  return f;
}

function activeFilterCount() {
  const f = state.filter;
  return f.kinds.length + (f.fav ? 1 : 0) + f.tags.length + f.people.length + f.places.length + f.cameras.length +
    (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.year ? 1 : 0) + (f.folderId ? 1 : 0) + (f.text ? 1 : 0);
}

/** Show only photos with this person/place/tag/camera (from People, Places, Tags pages or the viewer). */
function pick(kind, value) {
  state.filter = emptyFilter();
  if (kind === 'person') state.filter.people = [value];
  else if (kind === 'tag') state.filter.tags = [value];
  else if (kind === 'place') state.filter.places = [value];
  else if (kind === 'camera') state.filter.cameras = [value];
  else if (kind === 'year') state.filter.year = value;
  state.base = 'all';
  go('library');
}

function addToken(s) {
  const f = state.filter;
  const add = (arr, v) => {
    if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(v))) arr.push(v);
  };
  if (s.type === 'person') add(f.people, s.value);
  else if (s.type === 'tag') add(f.tags, s.value);
  else if (s.type === 'place') add(f.places, s.value);
  else if (s.type === 'camera') add(f.cameras, s.value);
  else if (s.type === 'year') f.year = s.value;
  else if (s.type === 'text') f.text = s.value;
  else if (s.type === 'folder') f.folderId = s.value;
  if (state.route !== 'library') go('library');
  else filterChanged();
}

function filterChanged() {
  renderTokens();
  renderFilters();
  loadLibrary(true);
}

// ---------------- routing ----------------
function go(route, base) {
  state.route = route;
  if (base) state.base = base;
  grid.clearSelection();
  for (const b of $$('.nav-item[data-route]')) {
    const on = b.dataset.route === route && (route !== 'library' || (b.dataset.base === state.base && !state.filter.folderId));
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const b of $$('#nav-folders .nav-item')) b.classList.toggle('active', route === 'library' && +b.dataset.folder === state.filter.folderId);
  const lib = route === 'library';
  $('#view-library').hidden = !lib;
  $('#view-page').hidden = lib;
  $('#seg-group').hidden = !lib;
  $('#seg-size').hidden = !lib;
  $('#btn-filters').hidden = !lib;
  $('#filters').hidden = !lib || !state.filtersOpen;
  renderTokens();
  if (lib) {
    renderFilters();
    loadLibrary(true);
  } else renderPage();
}

async function renderPage() {
  const el = $('#view-page');
  el.scrollTop = 0;
  const onPick = pick;
  if (state.route === 'people') await renderPeople(el, { onPick });
  else if (state.route === 'places') await renderPlaces(el, { onPick });
  else if (state.route === 'tags') await renderTags(el, { onPick });
  else if (state.route === 'folders') await renderFolders(el, { refreshNav });
  else if (state.route === 'settings') await renderSettings(el);
}

// ---------------- library ----------------
let loadSeq = 0;
async function loadLibrary(resetScroll = false) {
  if (state.route !== 'library') return;
  const seq = ++loadSeq;
  const f = effectiveFilter();
  const titles = { all: 'All photos', videos: 'Videos', favorites: 'Favorites' };
  let title = titles[state.base];
  if (state.filter.folderId) title = state.folders.find((x) => x.id === state.filter.folderId)?.path || title;
  else if (activeFilterCount()) title = 'Results';
  $('#lib-title').textContent = title;
  for (const b of $$('#seg-group button')) b.setAttribute('aria-pressed', b.dataset.group === state.group);
  for (const b of $$('#seg-size button')) b.setAttribute('aria-pressed', b.dataset.size === state.size);
  $('#seg-size').style.visibility = state.group === 'year' ? 'hidden' : '';

  if (state.group === 'year') {
    const years = await api.years(f);
    if (seq !== loadSeq) return;
    state.years = years;
    grid.setData([], { group: 'month', size: state.size });
    $('#vlist').hidden = true;
    const yEl = $('#years');
    yEl.hidden = !years.length;
    yEl.innerHTML = years.map((y) => {
      const c = y.covers;
      const cell = (k) => `<div style="background-image:url('${thumbUrl(c[k].id, k === 0 ? 640 : 320)}')"></div>`;
      const cells = c.length ? c.map((_, k) => cell(k)).join('') : `<div>${icon('photos', 34)}</div>`;
      return `<button class="ycard" data-year="${y.year}"><div class="mosaic n${c.length}">${cells}</div>
        <div class="yb"><b>${y.year}</b><span>${plural(y.count, 'item')}${y.places.length ? ' · ' + esc(y.places.join(', ')) : ''}</span></div></button>`;
    }).join('');
    const total = years.reduce((a, y) => a + y.count, 0);
    $('#lib-sub').textContent = total ? `${plural(total, 'item')} · ${plural(years.length, 'year')}` : '';
    renderScrub(years.map((y) => y.year));
    showEmpty(total === 0);
    if (resetScroll) scroller.scrollTop = 0;
    return;
  }

  const { items, places } = await api.query(f, state.group);
  if (seq !== loadSeq) return;
  $('#years').hidden = true;
  $('#vlist').hidden = false;
  if (resetScroll) scroller.scrollTop = 0;
  grid.setData(items, { group: state.group, size: state.size, places });
  const videos = items.reduce((n, it) => n + (it.kind === 'video'), 0);
  $('#lib-sub').textContent = items.length ? `${plural(items.length - videos, 'photo')} · ${plural(videos, 'video')}` : '';
  const years = [];
  for (const it of items) {
    const y = it.taken.slice(0, 4);
    if (years[years.length - 1] !== y) years.push(y);
  }
  renderScrub([...new Set(years)]);
  showEmpty(items.length === 0);
}

function showEmpty(isEmpty) {
  const el = $('#empty');
  el.hidden = !isEmpty;
  $('#lib-head').hidden = isEmpty && !state.folders.length;
  if (!isEmpty) return;
  const scanning = state.folders.some((f) => f.status === 'scanning' || f.status === 'new' || f.progress);
  if (!state.folders.length) {
    el.innerHTML = `<span class="big">${icon('photos', 34)}</span><h2>Welcome to Photobot</h2>
      <p>Add the folders where you keep your photos and videos. Photobot finds everything inside them, including all subfolders, and sorts it by date. Your files stay exactly where they are.</p>
      <button class="btn-primary" style="height:44px" data-add-folder>${icon('plus')}Add a folder</button>
      <p class="small">Tip: you can also drag folders from File Explorer onto this window.</p>`;
  } else if (scanning) {
    el.innerHTML = `<span class="big">${icon('refresh', 34)}</span><h2>Looking for photos…</h2><p>Your folders are being scanned. Photos appear here as soon as they are found.</p>`;
  } else if (activeFilterCount() || state.base !== 'all') {
    el.innerHTML = `<span class="big">${icon('search', 34)}</span><h2>Nothing found</h2><p>No photos or videos match these filters.</p>
      ${activeFilterCount() ? '<button class="btn-outline" data-clear-filters>Clear filters</button>' : ''}`;
  } else {
    el.innerHTML = `<span class="big">${icon('folder', 34)}</span><h2>No photos yet</h2><p>No photos or videos were found in your folders.</p>
      <button class="btn-outline" data-go-folders>Manage folders</button>`;
  }
}

function renderScrub(years) {
  const el = $('#scrub');
  el.hidden = years.length < 2;
  el.innerHTML = years.map((y) => `<button data-y="${y}">${y}</button>`).join('');
  highlightScrub();
}

const highlightScrub = debounce(() => {
  const y = state.group === 'year' ? null : grid.currentYear();
  for (const b of $$('#scrub button')) b.classList.toggle('on', b.dataset.y === y);
}, 60);
scroller.addEventListener('scroll', highlightScrub, { passive: true });

$('#scrub').addEventListener('click', (e) => {
  const b = e.target.closest('[data-y]');
  if (!b) return;
  if (state.group === 'year') {
    const card = $(`.ycard[data-year="${b.dataset.y}"]`);
    card?.scrollIntoView({ block: 'start' });
  } else grid.scrollToYear(b.dataset.y);
});

$('#years').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-year]');
  if (!c) return;
  state.group = 'month';
  save('group', state.group);
  await loadLibrary(true);
  grid.scrollToYear(c.dataset.year);
});

$('#empty').addEventListener('click', (e) => {
  if (e.target.closest('[data-add-folder]')) addFolders();
  if (e.target.closest('[data-clear-filters]')) {
    state.filter = emptyFilter();
    filterChanged();
  }
  if (e.target.closest('[data-go-folders]')) go('folders');
});

// ---------------- toolbar ----------------
$('#seg-group').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  state.group = b.dataset.group;
  save('group', state.group);
  loadLibrary(true);
});
$('#seg-size').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  state.size = b.dataset.size;
  save('size', state.size);
  loadLibrary();
});
$('#btn-filters').addEventListener('click', () => {
  state.filtersOpen = !state.filtersOpen;
  save('filtersOpen', state.filtersOpen);
  $('#filters').hidden = !state.filtersOpen;
  renderFilters();
});

// ---------------- search ----------------
const input = $('#search-input');
const sugEl = $('#suggest');
let sugs = [];
let sugActive = -1;

const KIND_LABEL = { person: 'Person', place: 'Place', tag: 'Tag', camera: 'Camera', year: 'Year', text: 'Text', folder: 'Folder' };

function renderTokens() {
  const f = state.filter;
  const toks = [];
  if (f.year) toks.push({ cls: '', k: 'Year', v: f.year, rm: () => (f.year = null) });
  for (const p of f.people) toks.push({ cls: 'person', k: 'Person', v: p, rm: () => (f.people = f.people.filter((x) => x !== p)) });
  for (const p of f.places) toks.push({ cls: 'place', k: 'Place', v: p.city ? p.city : p.country, rm: () => (f.places = f.places.filter((x) => x !== p)) });
  for (const t of f.tags) toks.push({ cls: '', k: 'Tag', v: t, rm: () => (f.tags = f.tags.filter((x) => x !== t)) });
  for (const c of f.cameras) toks.push({ cls: '', k: 'Camera', v: c, rm: () => (f.cameras = f.cameras.filter((x) => x !== c)) });
  if (f.folderId) {
    const fo = state.folders.find((x) => x.id === f.folderId);
    toks.push({ cls: '', k: 'Folder', v: fo ? fo.path.split(/[\\/]/).filter(Boolean).pop() : 'folder', rm: () => (f.folderId = null) });
  }
  if (f.text) toks.push({ cls: '', k: 'Text', v: `“${f.text}”`, rm: () => (f.text = '') });
  const el = $('#tokens');
  el.innerHTML = toks.map((t, i) => `<span class="token ${t.cls}"><span class="k">${t.k}:</span><span class="v">${esc(t.v)}</span><button data-tok="${i}" aria-label="Remove ${esc(t.k)} ${esc(t.v)}">×</button></span>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-tok]');
    if (!b) return;
    toks[+b.dataset.tok].rm();
    if (state.route === 'library') filterChanged();
    else renderTokens();
  };
  el._toks = toks;
  const n = activeFilterCount();
  const badge = $('#filter-count');
  badge.hidden = !n;
  badge.textContent = n;
  input.placeholder = toks.length ? 'Add more…' : 'Search people, places, tags, dates…';
}

const runSuggest = debounce(async () => {
  const q = input.value.trim();
  if (!q) {
    hideSuggest();
    return;
  }
  const res = await api.suggest(q);
  if (input.value.trim() !== q) return;
  sugs = [{ type: 'text', label: q, value: q }, ...res];
  for (const f of state.folders) {
    if (f.path.toLowerCase().includes(q.toLowerCase())) sugs.push({ type: 'folder', label: f.path, value: f.id, count: f.itemCount });
  }
  sugActive = res.length ? 1 : 0;
  renderSuggest();
}, 120);

function renderSuggest() {
  sugEl.hidden = false;
  sugEl.innerHTML = sugs.map((s, i) => {
    const sw = s.type === 'text'
      ? `<span class="sw">${icon('search', 16)}</span>`
      : `<span class="sw ${s.type === 'person' ? 'round' : ''}">${icon({ person: 'person', place: 'pin', tag: 'tag', camera: 'camera', year: 'calendar', folder: 'folder' }[s.type], 16)}</span>`;
    const sub = s.type === 'text' ? 'Search names, folders, tags and places' : `${KIND_LABEL[s.type]}${s.count != null ? ' · ' + plural(s.count, 'item') : ''}`;
    return `<button class="sug ${i === sugActive ? 'active' : ''}" role="option" data-s="${i}">${sw}<span class="t"><b>${esc(s.label)}</b><span>${esc(sub)}</span></span></button>`;
  }).join('');
}

function hideSuggest() {
  sugEl.hidden = true;
  sugs = [];
  sugActive = -1;
}

function choose(i) {
  const s = sugs[i];
  if (!s) return;
  input.value = '';
  hideSuggest();
  addToken(s);
}

input.addEventListener('input', runSuggest);
input.addEventListener('focus', () => input.value.trim() && runSuggest());
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && sugs.length) {
    sugActive = (sugActive + 1) % sugs.length;
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' && sugs.length) {
    sugActive = (sugActive - 1 + sugs.length) % sugs.length;
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (sugs.length && sugActive >= 0) choose(sugActive);
    else if (input.value.trim()) {
      addToken({ type: 'text', value: input.value.trim() });
      input.value = '';
    }
  } else if (e.key === 'Escape') {
    hideSuggest();
    input.blur();
  } else if (e.key === 'Backspace' && !input.value) {
    const toks = $('#tokens')._toks || [];
    if (toks.length) {
      toks[toks.length - 1].rm();
      filterChanged();
    }
  }
});
sugEl.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-s]');
  if (b) {
    e.preventDefault();
    choose(+b.dataset.s);
  }
});
input.addEventListener('blur', () => setTimeout(hideSuggest, 120));
$('#search').addEventListener('click', (e) => {
  if (!e.target.closest('button')) input.focus();
});

// ---------------- filter panel ----------------
let facetCache = null;
async function loadFacets() {
  const [people, places, tags, cameras] = await Promise.all([api.people(), api.places(), api.tags(), api.cameras()]);
  const countries = new Map();
  for (const p of places) countries.set(p.country, (countries.get(p.country) || 0) + p.n);
  facetCache = {
    people: people.slice(0, 14),
    cities: places.filter((p) => p.city).slice(0, 10),
    countries: [...countries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    tags: tags.slice(0, 18),
    cameras: cameras.slice(0, 8),
  };
  return facetCache;
}

async function renderFilters() {
  const el = $('#filters');
  $('#btn-filters').setAttribute('aria-pressed', state.filtersOpen);
  if (!state.filtersOpen || state.route !== 'library') return;
  const fc = facetCache || (await loadFacets());
  const f = state.filter;
  const has = (arr, v) => arr.some((x) => JSON.stringify(x) === JSON.stringify(v));
  const chip = (facet, value, label, count, on) =>
    `<button class="chip" aria-pressed="${on}" data-facet="${facet}" data-value="${esc(JSON.stringify(value))}"><span>${esc(label)}</span>${count != null ? `<small>${num(count)}</small>` : ''}</button>`;
  const section = (title, body) => (body ? `<div class="facet"><span class="facet-title">${title}</span><div class="chips">${body}</div></div>` : '');
  el.innerHTML = `
    <div class="filters-head"><h2>Filters</h2><button class="link-btn" data-clear>Clear all</button></div>
    ${section('Type', chip('kind', 'photo', 'Photos', null, f.kinds.includes('photo')) + chip('kind', 'video', 'Videos', null, f.kinds.includes('video')) + chip('fav', true, 'Favorites', null, f.fav))}
    ${section('People', fc.people.map((p) => chip('person', p.name, p.name, p.n, f.people.includes(p.name))).join(''))}
    ${section('Places', fc.cities.map((p) => chip('place', { city: p.city, country: p.country }, p.city, p.n, has(f.places, { city: p.city, country: p.country }))).join('')
      + fc.countries.map(([c, n]) => chip('place', { city: null, country: c }, c, n, has(f.places, { city: null, country: c }))).join(''))}
    ${section('Tags', fc.tags.map((t) => chip('tag', t.name, t.name, t.n, f.tags.includes(t.name))).join(''))}
    ${section('Camera', fc.cameras.map((c) => chip('camera', c.name, c.name, c.n, f.cameras.includes(c.name))).join(''))}
    <div class="facet"><span class="facet-title">Date range</span>
      <div class="date-row">
        <label class="field">From<input type="date" id="f-from" value="${esc(f.from)}"></label>
        <label class="field">To<input type="date" id="f-to" value="${esc(f.to)}"></label>
      </div></div>
    ${state.folders.length > 1 ? `<div class="facet"><span class="facet-title">Folder</span><label class="field"><span class="sr-only">Folder</span>
      <select id="f-folder"><option value="">All folders</option>${state.folders.map((x) => `<option value="${x.id}" ${x.id === f.folderId ? 'selected' : ''}>${esc(x.path)}</option>`).join('')}</select></label></div>` : ''}
    <p class="muted small">Tip: type in the search bar to find any person, place or tag.</p>`;
  el.onclick = (e) => {
    if (e.target.closest('[data-clear]')) {
      state.filter = emptyFilter();
      return filterChanged();
    }
    const c = e.target.closest('[data-facet]');
    if (!c) return;
    const v = JSON.parse(c.dataset.value);
    const toggle = (arr) => (has(arr, v) ? arr.filter((x) => JSON.stringify(x) !== JSON.stringify(v)) : [...arr, v]);
    const facet = c.dataset.facet;
    if (facet === 'kind') f.kinds = toggle(f.kinds);
    else if (facet === 'fav') f.fav = !f.fav;
    else if (facet === 'person') f.people = toggle(f.people);
    else if (facet === 'place') f.places = toggle(f.places);
    else if (facet === 'tag') f.tags = toggle(f.tags);
    else if (facet === 'camera') f.cameras = toggle(f.cameras);
    filterChanged();
  };
  el.onchange = (e) => {
    if (e.target.id === 'f-from') f.from = e.target.value;
    else if (e.target.id === 'f-to') f.to = e.target.value;
    else if (e.target.id === 'f-folder') f.folderId = e.target.value ? +e.target.value : null;
    else return;
    filterChanged();
  };
}

// ---------------- selection ----------------
function updateSelbar() {
  const n = grid.selected.size;
  $('#selbar').hidden = n === 0;
  $('#sel-count').textContent = n === 1 ? '1 selected' : `${num(n)} selected`;
}

$('#sel-clear').addEventListener('click', () => grid.clearSelection());
$('#sel-fav').addEventListener('click', async () => {
  const ids = [...grid.selected];
  const allFav = grid.items.filter((it) => grid.selected.has(it.id)).every((it) => it.fav);
  await api.setFav(ids, !allFav);
  toast(allFav ? 'Removed from favorites' : `Added ${plural(ids.length, 'item')} to favorites`);
  await loadLibrary();
});
$('#sel-tag').addEventListener('click', async () => {
  const tags = (await api.tags()).map((t) => t.name);
  const name = await ask({ title: 'Add a tag', label: `Tag for ${plural(grid.selected.size, 'item')}`, placeholder: 'e.g. holiday', suggestions: tags, ok: 'Add tag' });
  if (!name) return;
  await api.addTag([...grid.selected], name);
  toast(`Tagged ${plural(grid.selected.size, 'item')} with “${name}”`);
  facetCache = null;
  grid.clearSelection();
  renderFilters();
});
$('#sel-person').addEventListener('click', async () => {
  const people = (await api.people()).map((p) => p.name);
  const name = await ask({ title: 'Add a person', label: `Who is in these ${plural(grid.selected.size, 'item')}?`, placeholder: 'Name', suggestions: people, ok: 'Add person' });
  if (!name) return;
  await api.addPerson([...grid.selected], name);
  toast(`Added ${name} to ${plural(grid.selected.size, 'item')}`);
  facetCache = null;
  grid.clearSelection();
  renderFilters();
});
$('#sel-delete').addEventListener('click', async () => {
  const r = await api.trash([...grid.selected]);
  if (r.deleted) {
    toast(`Moved ${plural(r.deleted, 'item')} to the Recycle Bin`);
    grid.clearSelection();
    await loadLibrary();
  }
});

// ---------------- sidebar & folders ----------------
$('.sidebar').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  if (b.id === 'nav-add-folder') return addFolders();
  if (b.dataset.folder) {
    state.filter = { ...emptyFilter(), folderId: +b.dataset.folder };
    state.base = 'all';
    return go('library');
  }
  if (b.dataset.route === 'library') {
    if (state.filter.folderId) state.filter.folderId = null;
    return go('library', b.dataset.base);
  }
  if (b.dataset.route) go(b.dataset.route);
});

async function addFolders(paths) {
  const added = await api.addFolders(paths);
  if (added.length) toast(`Added ${plural(added.length, 'folder')} — scanning…`);
  await refreshNav();
  if (state.route === 'library') loadLibrary();
  else if (state.route === 'folders') renderPage();
}

async function refreshNav() {
  const [folders, stats] = await Promise.all([api.folders(), api.stats()]);
  state.folders = folders;
  state.stats = stats;
  $('#count-all').textContent = num(stats.total);
  $('#count-videos').textContent = num(stats.videos);
  $('#count-favs').textContent = num(stats.favorites);
  const short = (p) => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : p;
  };
  $('#nav-folders').innerHTML = folders.map((f) => {
    const dot = f.progress ? 'scanning' : f.status === 'offline' ? 'offline' : '';
    const on = state.route === 'library' && state.filter.folderId === f.id ? ' active' : '';
    return `<button class="nav-item small${on}" data-folder="${f.id}" title="${esc(f.path)}">${icon('folder', 16)}<span class="label">${esc(short(f.path))}</span>
      ${dot ? `<span class="dot ${dot}"></span>` : `<span class="count">${num(f.itemCount)}</span>`}</button>`;
  }).join('') + `<button class="nav-item small" data-route="folders">${icon('settings', 16)}<span>Manage folders</span></button>`;
}

// ---------------- scan progress ----------------
const scanning = new Map();
api.on('scan:progress', (p) => {
  if (p.phase === 'done' || p.phase === 'offline') scanning.delete(p.folderId);
  else scanning.set(p.folderId, p);
  updateScanCard();
  if (p.phase === 'done' || p.phase === 'offline' || p.phase === 'queued') {
    facetCache = null;
    refreshNav();
  }
  if (state.route === 'folders') refreshFoldersPage();
});
const refreshFoldersPage = debounce(() => {
  if (state.route === 'folders' && !document.querySelector('dialog[open]')) renderPage();
}, 400);

function updateScanCard() {
  const card = $('#scan-card');
  const active = [...scanning.values()].find((p) => p.phase === 'reading' || p.phase === 'counting');
  card.hidden = !active;
  if (!active) return;
  const f = state.folders.find((x) => x.id === active.folderId);
  const name = f ? f.path.split(/[\\/]/).filter(Boolean).pop() : 'folder';
  $('#scan-title').textContent = `Scanning ${name}…`;
  const bar = $('#scan-bar').parentElement;
  if (active.phase === 'counting') {
    bar.classList.add('indeterminate');
    $('#scan-pct').textContent = '';
    $('#scan-sub').textContent = `${num(active.total)} files found`;
  } else {
    bar.classList.remove('indeterminate');
    const pct = active.total ? Math.floor((active.done / active.total) * 100) : 0;
    $('#scan-bar').style.width = `${pct}%`;
    $('#scan-pct').textContent = `${pct}%`;
    $('#scan-sub').textContent = `${num(active.done)} of ${num(active.total)} · ${plural(active.found, 'new item')}`;
  }
}

api.on('library:changed', debounce(async () => {
  facetCache = null;
  await refreshNav();
  if (state.route === 'library' && viewer.root.hidden) {
    await loadLibrary();
    renderFilters();
  }
}, 400));

// ---------------- keyboard & drag-drop ----------------
document.addEventListener('keydown', (e) => {
  if (!viewer.root.hidden || document.querySelector('dialog[open]')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    input.focus();
    return;
  }
  if (typing || state.route !== 'library') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    grid.selectAll();
  } else if (e.key === 'Escape' && grid.selected.size) grid.clearSelection();
  else if (e.key === 'Delete' && grid.selected.size) $('#sel-delete').click();
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-hint').hidden = true;
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addFolders(paths);
});

// ---------------- start ----------------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

(async () => {
  applyTheme((await api.getSettings()).theme);
  await refreshNav();
  go('library', 'all');
})();

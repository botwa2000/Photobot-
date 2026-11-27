'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, Menu, session } = require('electron');
const { PhotoDb } = require('./db');
const { Scanner } = require('./scanner');
const { Thumbs, MAX_DECODE_PIXELS } = require('./thumbs');
const { BROWSER_IMAGE, BROWSER_VIDEO, kindOf } = require('./metadata');
const sec = require('./security');

const { v } = sec;

// Tests (and power users) can point Photobot at a separate data folder.
if (process.env.PHOTOBOT_DATA_DIR) app.setPath('userData', path.resolve(process.env.PHOTOBOT_DATA_DIR));

// app://  serves the UI (instead of file://, checklist item 18).
// pb://   serves thumbnails and indexed media to the UI. No fetch() support: pages
//         can only use these URLs in <img>/<video>, never read them from script.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } },
  { scheme: 'pb', privileges: { standard: true, secure: true, stream: true, corsEnabled: true } },
]);

const DEFAULT_SETTINGS = {
  theme: 'system',
  watch: true,
  skipSmall: true,
  types: { jpg: true, png: true, heic: true, webp: true, gif: true, bmp: false, tiff: true, raw: true, mp4: true, mov: true, othervideo: true },
};

let win = null;
let db = null;
let scanner = null;
let thumbs = null;

function settings() {
  const s = db.getSetting('settings', {});
  return { ...DEFAULT_SETTINGS, ...s, types: { ...DEFAULT_SETTINGS.types, ...(s.types || {}) } };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

app.on('window-all-closed', () => {
  scanner?.unwatchAll();
  thumbs?.stop();
  app.quit();
});

function start() {
  sec.hardenApp(app, session);
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  db = new PhotoDb(path.join(dataDir, 'photobot.db'));
  try {
    fs.chmodSync(path.join(dataDir, 'photobot.db'), 0o600);
  } catch {
    /* Windows: %APPDATA% is already private to the user */
  }
  thumbs = new Thumbs(path.join(dataDir, 'thumbs'), db);
  scanner = new Scanner(db, settings);
  nativeTheme.themeSource = settings().theme;

  registerProtocols();
  registerIpc();

  let changedTimer = null;
  scanner.on('progress', (p) => {
    send('scan:progress', p);
    if (p.phase === 'done') prunePrivateCache();
  });
  scanner.on('changed', () => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      send('library:changed');
    }, 800);
  });
  scanner.on('error', (e) => console.error('scan error', e.message));

  Menu.setApplicationMenu(null);
  createWindow();

  // First run: start with the default photo folder(s) if they exist on this PC.
  if (!db.getSetting('initialized', false)) {
    db.setSetting('initialized', true);
    for (const p of defaultFolders()) {
      try {
        if (fs.statSync(p).isDirectory()) db.addFolder(path.resolve(p));
      } catch {
        /* not on this PC */
      }
    }
  }

  // Catch up with anything that changed while Photobot was closed, and drop
  // thumbnails of photos that are gone.
  setTimeout(() => {
    scanner.scanAll();
    prunePrivateCache();
  }, 1500);
}

const prunePrivateCache = debounce(() => {
  thumbs.prune(db.allIds()).catch(() => {});
}, 3000);

function createWindow() {
  const bounds = sanitizeBounds(db.getSetting('window', null));
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Photobot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111418' : '#F6F7F9',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  if (db.getSetting('maximized', false)) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${sec.APP_ORIGIN}/index.html`);

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  // If the window's renderer crashes, reload it rather than leaving a blank window.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => win?.loadURL(`${sec.APP_ORIGIN}/index.html`), 500);
  });
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    db.setSetting('maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isMinimized()) db.setSetting('window', win.getBounds());
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
  });
}

function sanitizeBounds(b) {
  const ok = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!b || !ok(b.width, 900, 16000) || !ok(b.height, 600, 16000)) return { width: 1400, height: 900 };
  const out = { width: b.width, height: b.height };
  if (ok(b.x, -16000, 16000) && ok(b.y, -16000, 16000)) Object.assign(out, { x: b.x, y: b.y });
  return out;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function withHeaders(res, extra = {}) {
  const headers = new Headers(res.headers);
  for (const [k, val] of Object.entries({ ...sec.SECURITY_HEADERS, ...extra })) headers.set(k, val);
  if (extra['Access-Control-Allow-Origin']) headers.delete('Cross-Origin-Resource-Policy');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const notFound = () => new Response('not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });

function registerProtocols() {
  // The UI's own files. Anything outside src/renderer is refused (path traversal guard).
  protocol.handle('app', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    const file = sec.resolveAppFile(req.url);
    if (!file) return notFound();
    const res = await net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true }).catch(() => null);
    if (!res || !res.ok) return notFound();
    return withHeaders(res);
  });

  // pb://thumb/<id>?s=<px> → cached JPEG thumbnail
  // pb://file/<id>         → original photo/video. Only items in the index can be read, and only by
  //                          the app's own pages; there is no way to name an arbitrary path.
  protocol.handle('pb', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    if (req.initiatorOrigin !== undefined && req.initiatorOrigin !== sec.APP_ORIGIN) return new Response('forbidden', { status: 403 });
    const url = new URL(req.url);
    if (!/^\/\d{1,15}$/.test(url.pathname)) return notFound();
    const id = Number(url.pathname.slice(1));
    // CORS is granted to the app's own origin only (needed so the sandboxed thumbnailer may
    // export what it decoded); any other origin is refused above.
    const mediaHeaders = { 'Content-Security-Policy': "default-src 'none'; sandbox", 'Access-Control-Allow-Origin': sec.APP_ORIGIN, Vary: 'Origin' };
    if (url.host === 'thumb') {
      const size = Math.min(4096, Math.max(64, parseInt(url.searchParams.get('s') || '480', 10) || 480));
      const file = await thumbs.get(id, size);
      if (!file) return notFound();
      const res = await net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
      return withHeaders(res, { ...mediaHeaders, 'Content-Type': 'image/jpeg' });
    }
    if (url.host === 'file') {
      const it = db.itemPath(id);
      if (!it || !kindOf(it.path)) return notFound();
      const headers = {};
      const range = req.headers.get('range');
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range;
      const res = await net.fetch(pathToFileURL(it.path).toString(), { bypassCustomProtocolHandlers: true, headers }).catch(() => null);
      if (!res) return notFound();
      return withHeaders(res, mediaHeaders);
    }
    return notFound();
  });
}

/**
 * Every IPC handler checks that the call comes from the app's own page and validates
 * its arguments before touching the database or the file system (checklist item 17).
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!sec.isTrustedFrame(e.senderFrame, [win?.webContents])) throw new Error('untrusted sender');
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof sec.ValidationError) throw new Error(`invalid request: ${err.message}`);
      throw err;
    }
  });
}

function registerIpc() {
  handle('library:query', (filter, groupBy) => {
    const f = v.filter(filter);
    const g = v.oneOf(groupBy, ['month', 'day', 'all', 'year']);
    const items = db.query(f);
    let places = {};
    if (g === 'month') places = db.groupPlaces(f, 7);
    else if (g === 'day') places = db.groupPlaces(f, 10);
    return { items, places };
  });
  handle('library:years', (filter) => db.years(v.filter(filter)));
  handle('library:stats', () => db.stats());

  handle('item:get', (id) => {
    const it = db.item(v.id(id));
    if (!it) return null;
    it.native = it.kind === 'photo' ? BROWSER_IMAGE.has(it.ext) : BROWSER_VIDEO.has(it.ext);
    // Don't let the window decode gigantic images (pixel-flood DoS): show a preview instead.
    if (it.kind === 'photo' && it.width && it.height && it.width * it.height > MAX_DECODE_PIXELS) it.native = false;
    return it;
  });
  handle('items:setFav', (ids, fav) => {
    const list = v.ids(ids);
    const on = v.bool(fav);
    db.tx(() => list.forEach((id) => db.setFavorite(id, on)));
  });
  handle('item:rotate', (id, rotation) => db.setRotation(v.id(id), v.rotation(rotation)));
  handle('items:addTag', (ids, name) => {
    const list = v.ids(ids);
    const n = v.str(name, 60);
    db.tx(() => list.forEach((id) => db.linkTag(id, n)));
  });
  handle('item:removeTag', (id, name) => db.unlinkTag(v.id(id), v.str(name, 60)));
  handle('items:addPerson', (ids, name) => {
    const list = v.ids(ids);
    const n = v.str(name, 80);
    db.tx(() => list.forEach((id) => db.linkPerson(id, n)));
  });
  handle('item:removePerson', (id, name) => db.unlinkPerson(v.id(id), v.str(name, 80)));
  handle('person:rename', (from, to) => db.renamePerson(v.str(from, 80), v.str(to, 80)));
  handle('item:showInFolder', (id) => {
    const it = db.itemPath(v.id(id));
    if (it && !it.path.includes('\0')) shell.showItemInFolder(it.path);
  });
  handle('item:openExternal', async (id) => {
    // Opens the photo/video with the user's default app. Only indexed media files
    // (checked by extension again here) can be opened, never other file types.
    const it = db.itemPath(v.id(id));
    if (!it || it.path.includes('\0') || !kindOf(it.path)) return 'not allowed';
    return shell.openPath(it.path);
  });
  handle('app:openUrl', (url) => (sec.openExternalSafe(v.str(url, 2000)) ? 'ok' : 'blocked'));
  handle('items:trash', async (ids) => {
    const list = v.ids(ids, 10000);
    const n = list.length;
    if (!n) return { deleted: 0 };
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete',
      message: n === 1 ? 'Move this item to the Recycle Bin?' : `Move ${n} items to the Recycle Bin?`,
      detail: 'You can restore them from the Recycle Bin.',
    });
    if (response !== 0) return { deleted: 0 };
    let deleted = 0;
    const gone = [];
    for (const id of list) {
      const it = db.itemPath(id);
      if (!it || !kindOf(it.path)) continue;
      try {
        await shell.trashItem(it.path);
        db.deleteItemByPath(it.path);
        gone.push(id);
        deleted++;
      } catch (e) {
        console.error('trash failed', e.message);
      }
    }
    db.pruneOrphans();
    await thumbs.removeIds(gone);
    send('library:changed');
    return { deleted };
  });

  handle('browse:people', () => db.people());
  handle('browse:places', () => db.places());
  handle('browse:tags', () => db.tags());
  handle('browse:cameras', () => db.cameras());
  handle('search:suggest', (q) => db.suggest(v.str(q, 100, { allowEmpty: true })));

  handle('folders:list', () => {
    const status = new Map(scanner.status().map((p) => [p.folderId, p]));
    return db.listFolders().map((f) => ({ ...f, progress: status.get(f.id) || null }));
  });
  handle('folders:add', async (paths) => {
    let list;
    if (paths === undefined || paths === null || (Array.isArray(paths) && paths.length === 0)) {
      // Chosen by the user in the system dialog: network folders are allowed here.
      const r = await dialog.showOpenDialog(win, { title: 'Add a folder to Photobot', properties: ['openDirectory', 'multiSelections'] });
      if (r.canceled) return [];
      list = r.filePaths.map((p) => path.resolve(p));
    } else {
      list = v.folderPaths(paths);
    }
    const added = [];
    for (const p of list) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const norm = path.resolve(p);
      // Avoid adding a folder that is already covered by (or covers) another library folder.
      const existing = db.listFolders();
      if (existing.some((f) => isInside(norm, f.path))) continue;
      for (const f of existing) {
        if (isInside(f.path, norm)) {
          scanner.cancel(f.id);
          db.removeFolder(f.id);
        }
      }
      const f = db.addFolder(norm);
      added.push(f);
      scanner.scanFolder(f.id);
    }
    return added;
  });
  handle('folders:remove', (id) => {
    const fid = v.id(id);
    scanner.cancel(fid);
    db.removeFolder(fid);
    prunePrivateCache();
    send('library:changed');
  });
  handle('folders:rescan', (id) => (id ? scanner.scanFolder(v.id(id)) : scanner.scanAll()));

  handle('settings:get', () => settings());
  handle('settings:set', (patch) => {
    const p = v.settingsPatch(patch);
    const next = { ...settings(), ...p };
    if (p.types) next.types = { ...settings().types, ...p.types };
    db.setSetting('settings', next);
    if ('theme' in p) nativeTheme.themeSource = next.theme;
    if ('watch' in p) {
      if (next.watch) scanner.watchAll();
      else scanner.unwatchAll();
    }
    return next;
  });
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir: app.getPath('userData') }));
  handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));
  handle('app:clearCache', async () => {
    await thumbs.clear();
    return true;
  });
}

/** Folders added automatically on first start. PHOTOBOT_DEFAULT_FOLDERS (separated by ';') overrides it. */
function defaultFolders() {
  if (process.env.PHOTOBOT_DEFAULT_FOLDERS !== undefined) return process.env.PHOTOBOT_DEFAULT_FOLDERS.split(';').filter(Boolean);
  return process.platform === 'win32' ? ['D:\\Pictures'] : [];
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

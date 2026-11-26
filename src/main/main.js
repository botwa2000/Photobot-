'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, Menu } = require('electron');
const { PhotoDb } = require('./db');
const { Scanner } = require('./scanner');
const { Thumbs } = require('./thumbs');
const { BROWSER_IMAGE, BROWSER_VIDEO } = require('./metadata');

// Tests (and power users) can point Photobot at a separate data folder.
if (process.env.PHOTOBOT_DATA_DIR) app.setPath('userData', path.resolve(process.env.PHOTOBOT_DATA_DIR));

protocol.registerSchemesAsPrivileged([
  { scheme: 'pb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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
  app.quit();
});

function start() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new PhotoDb(path.join(dataDir, 'photobot.db'));
  thumbs = new Thumbs(path.join(dataDir, 'thumbs'), db);
  scanner = new Scanner(db, settings);
  nativeTheme.themeSource = settings().theme;

  registerProtocol();
  registerIpc();

  let changedTimer = null;
  scanner.on('progress', (p) => send('scan:progress', p));
  scanner.on('changed', () => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      send('library:changed');
    }, 800);
  });
  scanner.on('error', (e) => console.error('scan error', e));

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

  // Catch up with anything that changed while Photobot was closed.
  setTimeout(() => {
    scanner.scanAll();
  }, 1500);
}

function createWindow() {
  const bounds = db.getSetting('window', { width: 1400, height: 900 });
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
      spellcheck: false,
    },
  });
  if (db.getSetting('maximized', false)) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
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

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerProtocol() {
  // pb://thumb/<id>?s=<px>  -> cached JPEG thumbnail
  // pb://file/<id>          -> the original photo/video (only items in the index can be read)
  protocol.handle('pb', async (req) => {
    const url = new URL(req.url);
    const id = parseInt(url.pathname.slice(1), 10);
    if (!Number.isFinite(id)) return new Response('bad id', { status: 400 });
    if (url.host === 'thumb') {
      const size = Math.min(4096, Math.max(64, parseInt(url.searchParams.get('s') || '480', 10)));
      const file = await thumbs.get(id, size);
      if (!file) return new Response('no thumbnail', { status: 404 });
      return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    }
    if (url.host === 'file') {
      const it = db.itemPath(id);
      if (!it) return new Response('not found', { status: 404 });
      const headers = {};
      const range = req.headers.get('range');
      if (range) headers.range = range;
      return net.fetch(pathToFileURL(it.path).toString(), { bypassCustomProtocolHandlers: true, headers });
    }
    return new Response('not found', { status: 404 });
  });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

function registerIpc() {
  handle('library:query', (filter, groupBy) => {
    const items = db.query(filter);
    let places = {};
    if (groupBy === 'month') places = db.groupPlaces(filter, 7);
    else if (groupBy === 'day') places = db.groupPlaces(filter, 10);
    return { items, places };
  });
  handle('library:years', (filter) => db.years(filter));
  handle('library:stats', () => db.stats());

  handle('item:get', (id) => {
    const it = db.item(id);
    if (!it) return null;
    it.native = it.kind === 'photo' ? BROWSER_IMAGE.has(it.ext) : BROWSER_VIDEO.has(it.ext);
    return it;
  });
  handle('items:setFav', (ids, fav) => db.tx(() => ids.forEach((id) => db.setFavorite(id, fav))));
  handle('item:rotate', (id, rotation) => db.setRotation(id, rotation));
  handle('items:addTag', (ids, name) => db.tx(() => ids.forEach((id) => db.linkTag(id, name))));
  handle('item:removeTag', (id, name) => db.unlinkTag(id, name));
  handle('items:addPerson', (ids, name) => db.tx(() => ids.forEach((id) => db.linkPerson(id, name))));
  handle('item:removePerson', (id, name) => db.unlinkPerson(id, name));
  handle('person:rename', (from, to) => db.renamePerson(from, to));
  handle('item:showInFolder', (id) => {
    const it = db.itemPath(id);
    if (it) shell.showItemInFolder(it.path);
  });
  handle('item:openExternal', (id) => {
    const it = db.itemPath(id);
    if (it) return shell.openPath(it.path);
  });
  handle('items:trash', async (ids) => {
    const n = ids.length;
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
    for (const id of ids) {
      const it = db.itemPath(id);
      if (!it) continue;
      try {
        await shell.trashItem(it.path);
        db.deleteItemByPath(it.path);
        deleted++;
      } catch (e) {
        console.error('trash failed', e);
      }
    }
    db.pruneOrphans();
    send('library:changed');
    return { deleted };
  });

  handle('browse:people', () => db.people());
  handle('browse:places', () => db.places());
  handle('browse:tags', () => db.tags());
  handle('browse:cameras', () => db.cameras());
  handle('search:suggest', (q) => db.suggest(q));

  handle('folders:list', () => {
    const status = new Map(scanner.status().map((p) => [p.folderId, p]));
    return db.listFolders().map((f) => ({ ...f, progress: status.get(f.id) || null }));
  });
  handle('folders:add', async (paths) => {
    if (!paths || !paths.length) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Add a folder to Photobot',
        properties: ['openDirectory', 'multiSelections'],
      });
      if (r.canceled) return [];
      paths = r.filePaths;
    }
    const added = [];
    for (const p of paths) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const dir = st.isDirectory() ? p : path.dirname(p);
      const norm = path.resolve(dir);
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
    scanner.cancel(id);
    db.removeFolder(id);
    send('library:changed');
  });
  handle('folders:rescan', (id) => (id ? scanner.scanFolder(id) : scanner.scanAll()));

  handle('settings:get', () => settings());
  handle('settings:set', (patch) => {
    const next = { ...settings(), ...patch };
    if (patch.types) next.types = { ...settings().types, ...patch.types };
    db.setSetting('settings', next);
    if ('theme' in patch) nativeTheme.themeSource = next.theme;
    if ('watch' in patch) {
      if (next.watch) scanner.watchAll();
      else scanner.unwatchAll();
    }
    return next;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: app.getPath('userData'),
  }));
  handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));
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

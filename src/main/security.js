'use strict';
// Central security policy for Photobot. See SECURITY.md for the threat model.
const path = require('path');
const { shell } = require('electron');

const APP_ORIGIN = 'app://photobot';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// The only web pages the app may open, and only in the user's browser.
const EXTERNAL_HOSTS = new Set(['www.openstreetmap.org']);

// The UI is fully offline: these are the only URL schemes the app's pages may load.
const ALLOWED_SCHEMES = new Set(['app:', 'pb:', 'devtools:', 'chrome-extension:']);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' pb:",
  "media-src pb:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

/** IPC may only come from the app's own top-level page (checklist item 17). */
function isTrustedFrame(frame, expectedContents) {
  if (!frame) return false;
  if (frame.origin !== APP_ORIGIN) return false;
  if (frame.parent) return false;
  if (expectedContents && !expectedContents.some((wc) => wc && !wc.isDestroyed() && wc.mainFrame === frame)) return false;
  return true;
}

// ---------- input validation for IPC ----------
class ValidationError extends Error {}
const fail = (msg) => {
  throw new ValidationError(msg);
};

const v = {
  id(x) {
    if (!Number.isSafeInteger(x) || x < 1) fail('bad id');
    return x;
  },
  ids(x, max = 200000) {
    if (!Array.isArray(x) || x.length > max) fail('bad id list');
    return x.map(v.id);
  },
  bool(x) {
    if (typeof x !== 'boolean') fail('bad boolean');
    return x;
  },
  str(x, max = 200, { allowEmpty = false } = {}) {
    if (typeof x !== 'string') fail('bad string');
    if (x.includes('\0')) fail('bad string');
    const s = x.trim();
    if (s.length > max) fail('string too long');
    if (!s && !allowEmpty) fail('empty string');
    return s;
  },
  optStr(x, max = 200) {
    if (x === null || x === undefined || x === '') return null;
    return v.str(x, max);
  },
  oneOf(x, values) {
    if (!values.includes(x)) fail('bad value');
    return x;
  },
  date(x) {
    if (x === '' || x === null || x === undefined) return '';
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) fail('bad date');
    return x;
  },
  rotation(x) {
    if (![0, 90, 180, 270].includes(x)) fail('bad rotation');
    return x;
  },
  /** A library filter coming from the window. Unknown keys are dropped. */
  filter(f) {
    if (f === undefined || f === null) return {};
    if (typeof f !== 'object' || Array.isArray(f)) fail('bad filter');
    const list = (a, fn, max = 50) => {
      if (a === undefined || a === null) return [];
      if (!Array.isArray(a) || a.length > max) fail('bad filter list');
      return a.map(fn);
    };
    const place = (p) => {
      if (!p || typeof p !== 'object') fail('bad place');
      return { city: v.optStr(p.city, 200), country: v.str(p.country, 200) };
    };
    return {
      kinds: list(f.kinds, (k) => v.oneOf(k, ['photo', 'video']), 2),
      fav: f.fav === true,
      tags: list(f.tags, (t) => v.str(t, 60)),
      people: list(f.people, (t) => v.str(t, 80)),
      places: list(f.places, place),
      cameras: list(f.cameras, (t) => v.str(t, 200)),
      from: v.date(f.from),
      to: v.date(f.to),
      text: f.text ? v.str(f.text, 200) : '',
      year: f.year ? v.str(String(f.year), 4) : null,
      folderId: f.folderId ? v.id(f.folderId) : null,
      sort: f.sort === 'oldest' ? 'oldest' : 'newest',
      noPlace: f.noPlace === true,
    };
  },
  /**
   * Folder paths from drag & drop. Must be absolute local paths. UNC/network paths
   * (\\server\share) are refused here because a crafted path could make Windows send
   * the user's NTLM credentials to another machine; network folders can still be
   * added with the folder picker or through a mapped drive letter.
   */
  folderPaths(x) {
    if (!Array.isArray(x) || x.length > 50) fail('bad paths');
    return x.map((p) => {
      const s = v.str(p, 1024);
      if (isUncPath(s)) fail('network paths must be added with the folder picker');
      if (!path.isAbsolute(s)) fail('path must be absolute');
      return path.resolve(s);
    });
  },
  settingsPatch(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('bad settings');
    const out = {};
    if ('theme' in p) out.theme = v.oneOf(p.theme, ['system', 'light', 'dark']);
    if ('watch' in p) out.watch = v.bool(p.watch);
    if ('skipSmall' in p) out.skipSmall = v.bool(p.skipSmall);
    if ('types' in p) {
      const keys = ['jpg', 'png', 'heic', 'webp', 'gif', 'bmp', 'tiff', 'raw', 'mp4', 'mov', 'othervideo'];
      if (!p.types || typeof p.types !== 'object') fail('bad types');
      out.types = {};
      for (const [k, val] of Object.entries(p.types)) out.types[v.oneOf(k, keys)] = v.bool(val);
    }
    return out;
  },
};

function isUncPath(p) {
  return /^[\\/]{2}/.test(p);
}

/** Opens a web page in the user's browser, only for allow-listed https hosts (checklist item 15). */
function openExternalSafe(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !EXTERNAL_HOSTS.has(u.hostname) || u.username || u.password) return false;
  shell.openExternal(u.toString());
  return true;
}

/**
 * Locks down every web contents the app creates: no navigation, no new windows,
 * no <webview>, no permissions, no downloads, no network (checklist items 5, 13, 14).
 */
function hardenApp(app, session) {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (url !== contents.getURL()) e.preventDefault();
    });
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  if (ses.setDisplayMediaRequestHandler) ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  ses.on('will-download', (e) => e.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    let scheme = '';
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      /* invalid */
    }
    // file: is allowed only for the main process's own reads (protocol handlers), never for pages.
    const fromMain = details.webContentsId === undefined || details.webContentsId === null;
    callback({ cancel: !(ALLOWED_SCHEMES.has(scheme) || (scheme === 'file:' && fromMain)) });
  });
  // Never ask Google for spell-check dictionaries or anything else.
  if (ses.setSpellCheckerEnabled) ses.setSpellCheckerEnabled(false);
}

/** Resolves an app://photobot/… URL to a file inside the renderer folder, or null. */
function resolveAppFile(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (u.host !== 'photobot') return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(RENDERER_DIR, '.' + rel);
  const relative = path.relative(RENDERER_DIR, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

module.exports = {
  APP_ORIGIN, CSP, SECURITY_HEADERS, RENDERER_DIR, isTrustedFrame, v, ValidationError, isUncPath,
  openExternalSafe, hardenApp, resolveAppFile,
};

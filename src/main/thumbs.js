'use strict';
// Thumbnail cache.
// - Browser-native photos (JPEG, PNG, WEBP, GIF, BMP, AVIF) are decoded in a hidden,
//   sandboxed Chromium window, never in the privileged main process.
// - HEIC, RAW, TIFF and videos use the Windows shell thumbnailer (the same code
//   File Explorer runs on these files, kept up to date by Windows Update and the Store).
const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, nativeImage } = require('electron');
const { APP_ORIGIN, isTrustedFrame } = require('./security');
const { BROWSER_IMAGE } = require('./metadata');

const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const JOB_TIMEOUT_MS = 20000;
const MAX_DECODE_PIXELS = 120e6;

class SandboxedDecoder {
  constructor() {
    this.win = null;
    this.ready = null;
    this.jobs = new Map();
    this.nextId = 1;
    ipcMain.on('thumb:ready', (e) => {
      if (this.isOurs(e)) this.resolveReady?.();
    });
    ipcMain.on('thumb:done', (e, jobId, bytes) => {
      if (!this.isOurs(e)) return;
      const job = this.jobs.get(jobId);
      if (!job) return;
      const buf = bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      // Accept only a plausible JPEG of sane size.
      if (!buf || buf.length < 100 || buf.length > MAX_THUMB_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) return this.finish(jobId, null);
      this.finish(jobId, buf);
    });
    ipcMain.on('thumb:failed', (e, jobId) => {
      if (this.isOurs(e)) this.finish(jobId, null);
    });
  }

  isOurs(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents && isTrustedFrame(e.senderFrame);
  }

  start() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'thumb-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    const restart = () => {
      // The decoder crashed or hung (e.g. on a malicious image): fail its jobs and start fresh.
      for (const id of [...this.jobs.keys()]) this.finish(id, null);
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
      this.win = null;
    };
    this.win.webContents.on('render-process-gone', restart);
    this.win.webContents.on('unresponsive', restart);
    this.win.loadURL(`${APP_ORIGIN}/thumbnailer.html`);
    return this.ready;
  }

  async decode(id, size) {
    await this.start();
    const win = this.win;
    if (!win || win.isDestroyed()) return null;
    const jobId = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(jobId, null);
        // A job that never returns means the window is stuck: replace it.
        if (this.win === win && !win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
      }, JOB_TIMEOUT_MS);
      this.jobs.set(jobId, { resolve, timer });
      win.webContents.send('thumb:job', { jobId, id, size });
    });
  }

  finish(jobId, value) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    clearTimeout(job.timer);
    job.resolve(value);
  }

  stop() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

class Thumbs {
  constructor(dir, db) {
    this.dir = dir;
    this.db = db;
    fs.mkdirSync(dir, { recursive: true });
    this.inflight = new Map();
    this.active = 0;
    this.waiting = [];
    this.failed = new Set();
    this.decoder = new SandboxedDecoder();
  }

  cacheFile(id, mtime, size) {
    return path.join(this.dir, String(id % 256).padStart(3, '0'), `${id}-${mtime}-${size}.jpg`);
  }

  /** @returns {Promise<string|null>} path of a JPEG thumbnail, or null if none can be made. */
  async get(id, size) {
    const it = this.db.itemPath(id);
    if (!it) return null;
    const out = this.cacheFile(id, it.mtime, size);
    if (this.failed.has(out)) return null;
    try {
      await fs.promises.access(out);
      return out;
    } catch {
      /* not cached yet */
    }
    if (this.inflight.has(out)) return this.inflight.get(out);
    const p = this.limit(() => this.make(id, it, out, size)).then((ok) => {
      this.inflight.delete(out);
      if (!ok) this.failed.add(out);
      return ok ? out : null;
    });
    this.inflight.set(out, p);
    return p;
  }

  limit(fn) {
    return new Promise((resolve) => {
      const run = async () => {
        this.active++;
        try {
          resolve(await fn());
        } catch {
          resolve(false);
        } finally {
          this.active--;
          const next = this.waiting.shift();
          if (next) next();
        }
      };
      if (this.active < 3) run();
      else this.waiting.push(run);
    });
  }

  async make(id, it, out, size) {
    let jpeg = null;
    const tooBig = it.width && it.height && it.width * it.height > MAX_DECODE_PIXELS;
    if (it.kind === 'photo' && BROWSER_IMAGE.has(it.ext) && !tooBig) {
      jpeg = await this.decoder.decode(id, size);
    }
    if (!jpeg && process.platform === 'win32' && typeof nativeImage.createThumbnailFromPath === 'function') {
      try {
        const img = await nativeImage.createThumbnailFromPath(it.path, { width: size, height: size });
        if (img && !img.isEmpty()) jpeg = img.toJPEG(84);
      } catch {
        jpeg = null;
      }
    }
    if (!jpeg) return false;
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.writeFile(out, jpeg, { mode: 0o600 });
    return true;
  }

  /** Deletes cached thumbnails of items that are no longer in the library (privacy). */
  async prune(validIds) {
    let removed = 0;
    for (const sub of await fs.promises.readdir(this.dir).catch(() => [])) {
      const subdir = path.join(this.dir, sub);
      for (const f of await fs.promises.readdir(subdir).catch(() => [])) {
        const id = parseInt(f, 10);
        if (!validIds.has(id)) {
          await fs.promises.unlink(path.join(subdir, f)).catch(() => {});
          removed++;
        }
      }
    }
    return removed;
  }

  async removeIds(ids) {
    for (const id of ids) {
      const subdir = path.join(this.dir, String(id % 256).padStart(3, '0'));
      for (const f of await fs.promises.readdir(subdir).catch(() => [])) {
        if (f.startsWith(`${id}-`)) await fs.promises.unlink(path.join(subdir, f)).catch(() => {});
      }
    }
  }

  async clear() {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    await fs.promises.mkdir(this.dir, { recursive: true });
    this.failed.clear();
  }

  stop() {
    this.decoder.stop();
  }
}

module.exports = { Thumbs, MAX_DECODE_PIXELS };

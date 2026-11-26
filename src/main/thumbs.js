'use strict';
// Thumbnail cache. On Windows the shell's own thumbnailer is used, which
// handles JPEG, PNG, HEIC (with the free HEIF extension), RAW (with the Raw
// Image Extension) and videos. Elsewhere JPEG/PNG are resized with nativeImage.
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

class Thumbs {
  constructor(dir, db) {
    this.dir = dir;
    this.db = db;
    fs.mkdirSync(dir, { recursive: true });
    this.inflight = new Map();
    this.active = 0;
    this.waiting = [];
    this.failed = new Set();
  }

  cacheFile(id, mtime, size) {
    return path.join(this.dir, String(id % 256).padStart(3, '0'), `${id}-${mtime}-${size}.jpg`);
  }

  /** @returns {Promise<string|null>} path of a JPEG thumbnail, or null if none can be made. */
  async get(id, size) {
    const it = this.db.itemPath(id);
    if (!it) return null;
    const out = this.cacheFile(id, it.mtime, size);
    const key = out;
    if (this.failed.has(key)) return null;
    try {
      await fs.promises.access(out);
      return out;
    } catch {
      /* not cached yet */
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.limit(() => this.make(it, out, size)).then((ok) => {
      this.inflight.delete(key);
      if (!ok) this.failed.add(key);
      return ok ? out : null;
    });
    this.inflight.set(key, p);
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

  async make(it, out, size) {
    let img = null;
    if (typeof nativeImage.createThumbnailFromPath === 'function') {
      try {
        img = await nativeImage.createThumbnailFromPath(it.path, { width: size, height: size });
      } catch {
        img = null;
      }
    }
    if ((!img || img.isEmpty()) && ['jpg', 'jpeg', 'jpe', 'jfif', 'png'].includes(it.ext)) {
      const full = nativeImage.createFromPath(it.path);
      if (!full.isEmpty()) {
        const { width, height } = full.getSize();
        const scale = Math.min(1, size / Math.max(width, height));
        img = scale < 1 ? full.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : full;
      }
    }
    if (!img || img.isEmpty()) return false;
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.writeFile(out, img.toJPEG(84));
    return true;
  }

  /** Removes cached thumbnails of items that no longer exist. */
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
}

module.exports = { Thumbs };

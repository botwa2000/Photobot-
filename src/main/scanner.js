'use strict';
// Finds photos and videos in the library folders (and all their subfolders),
// reads their metadata and keeps the index up to date while files change.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { kindOf, extOf, readMetadata } = require('./metadata');
const { reverseGeocode } = require('./geo');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '@eadir', '.thumbnails',
  '$windows.~bt', '$windows.~ws', 'windows', 'appdata', '.git']);
const MIN_IMAGE_BYTES = 20 * 1024;

function shouldSkipDir(name) {
  return name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name.toLowerCase());
}

class Scanner extends EventEmitter {
  /**
   * @param {import('./db').PhotoDb} db
   * @param {() => {types: Record<string, boolean>, skipSmall: boolean, watch: boolean}} getOptions
   */
  constructor(db, getOptions) {
    super();
    this.db = db;
    this.getOptions = getOptions;
    this.queue = [];
    this.running = null;
    this.cancelled = new Set();
    this.watchers = new Map();
    this.pending = new Map();
    this.scanCounter = Date.now() % 1e9;
    this.progress = new Map();
  }

  isWanted(file, size) {
    const kind = kindOf(file);
    if (!kind) return null;
    const opts = this.getOptions();
    const ext = extOf(file);
    const group = typeGroup(ext);
    if (opts.types && opts.types[group] === false) return null;
    if (kind === 'photo' && opts.skipSmall !== false && size !== undefined && size < MIN_IMAGE_BYTES && ext !== 'gif') return null;
    return kind;
  }

  status() {
    return [...this.progress.values()];
  }

  scanFolder(folderId) {
    if (this.running?.folderId === folderId || this.queue.includes(folderId)) return;
    this.queue.push(folderId);
    this.progress.set(folderId, { folderId, phase: 'queued', done: 0, total: 0, found: 0 });
    this.emit('progress', this.progress.get(folderId));
    this.pump();
  }

  scanAll() {
    for (const f of this.db.listFolders()) this.scanFolder(f.id);
  }

  cancel(folderId) {
    this.queue = this.queue.filter((id) => id !== folderId);
    this.cancelled.add(folderId);
    this.progress.delete(folderId);
    this.unwatch(folderId);
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const folderId = this.queue.shift();
    this.running = { folderId };
    try {
      await this.runScan(folderId);
    } catch (e) {
      this.emit('error', e);
    } finally {
      this.running = null;
      this.cancelled.delete(folderId);
      setImmediate(() => this.pump());
    }
  }

  async runScan(folderId) {
    const folder = this.db.getFolder(folderId);
    if (!folder) return;
    const prog = { folderId, phase: 'counting', done: 0, total: 0, found: 0 };
    this.progress.set(folderId, prog);
    const emit = () => this.emit('progress', { ...prog });
    emit();

    if (!(await isDir(folder.path))) {
      this.db.setFolderStatus(folderId, 'offline');
      this.progress.delete(folderId);
      this.emit('progress', { folderId, phase: 'offline' });
      this.emit('changed', { folderId });
      return;
    }
    this.db.setFolderStatus(folderId, 'scanning');

    // Pass 1: list every media file (fast; only directory reads + stat).
    const files = [];
    let lastEmit = 0;
    for await (const f of walk(folder.path)) {
      if (this.cancelled.has(folderId)) return;
      files.push(f);
      if (Date.now() - lastEmit > 300) {
        prog.total = files.length;
        emit();
        lastEmit = Date.now();
      }
    }
    prog.phase = 'reading';
    prog.total = files.length;
    emit();

    // Pass 2: read metadata for new/changed files only.
    const scanId = ++this.scanCounter;
    const known = this.db.folderIndex(folderId);
    const todo = [];
    this.db.tx(() => {
      for (const f of files) {
        const k = known.get(f.path);
        if (k && k.size === f.size && k.mtime === f.mtime) this.db.touch(k.id, scanId);
        else todo.push(f);
      }
    });
    prog.done = files.length - todo.length;
    emit();

    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const recs = batch;
      batch = [];
      this.db.tx(() => {
        for (const r of recs) this.db.upsertItem(r, scanId);
      });
      this.emit('changed', { folderId });
    };
    let lastFlush = Date.now();
    await runPool(todo, 4, async (f) => {
      if (this.cancelled.has(folderId)) return;
      const rec = await this.buildRecord(folderId, f);
      if (rec) {
        batch.push(rec);
        prog.found++;
      }
      prog.done++;
      if (Date.now() - lastEmit > 250) {
        emit();
        lastEmit = Date.now();
      }
      if (batch.length >= 200 || Date.now() - lastFlush > 1500) {
        flush();
        lastFlush = Date.now();
      }
    });
    if (this.cancelled.has(folderId)) return;
    flush();
    this.db.tx(() => this.db.sweep(folderId, scanId));
    this.db.setFolderStatus(folderId, 'ready', { scanned: true });
    this.progress.delete(folderId);
    this.emit('progress', { folderId, phase: 'done', found: prog.found, total: files.length });
    this.emit('changed', { folderId });
    if (this.getOptions().watch !== false) this.watch(folderId);
  }

  async buildRecord(folderId, f) {
    const kind = this.isWanted(f.path, f.size);
    if (!kind) return null;
    let meta;
    try {
      meta = await readMetadata(f.path, f.stat);
    } catch {
      meta = { taken: null, keywords: [], people: [] };
    }
    let city = null;
    let country = null;
    if (meta.lat != null && meta.lon != null) {
      const g = reverseGeocode(meta.lat, meta.lon);
      if (g) {
        city = g.city;
        country = g.country;
      }
    }
    return {
      ...meta,
      folderId,
      path: f.path,
      name: path.basename(f.path),
      ext: extOf(f.path),
      kind,
      size: f.size,
      mtime: f.mtime,
      taken: meta.taken || '1970-01-01T00:00:00',
      city,
      country,
      fav: meta.rating >= 4 ? 1 : 0,
    };
  }

  // ---------- watching for changes ----------
  watchAll() {
    if (this.getOptions().watch === false) return;
    for (const f of this.db.listFolders()) if (f.status !== 'offline') this.watch(f.id);
  }

  unwatchAll() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  watch(folderId) {
    if (this.watchers.has(folderId)) return;
    const folder = this.db.getFolder(folderId);
    if (!folder) return;
    try {
      const w = fs.watch(folder.path, { recursive: true }, (_evt, rel) => {
        if (!rel) return;
        const full = path.join(folder.path, rel.toString());
        let set = this.pending.get(folderId);
        if (!set) this.pending.set(folderId, (set = new Set()));
        set.add(full);
        clearTimeout(this['t' + folderId]);
        this['t' + folderId] = setTimeout(() => this.applyChanges(folderId), 2000);
      });
      w.on('error', () => this.unwatch(folderId));
      this.watchers.set(folderId, w);
    } catch {
      /* recursive watching unsupported here: rely on rescans */
    }
  }

  unwatch(folderId) {
    const w = this.watchers.get(folderId);
    if (w) w.close();
    this.watchers.delete(folderId);
  }

  async applyChanges(folderId) {
    const set = this.pending.get(folderId);
    this.pending.delete(folderId);
    if (!set || !set.size) return;
    if (set.size > 500 || this.running?.folderId === folderId) {
      this.scanFolder(folderId);
      return;
    }
    const recs = [];
    const removed = [];
    for (const p of set) {
      let st = null;
      try {
        st = await fs.promises.stat(p);
      } catch {
        removed.push(p);
        continue;
      }
      if (st.isDirectory()) {
        // A new or renamed folder: scan its contents.
        for await (const f of walk(p)) {
          const r = await this.buildRecord(folderId, f);
          if (r) recs.push(r);
        }
      } else if (st.isFile() && kindOf(p)) {
        const r = await this.buildRecord(folderId, fileInfo(p, st));
        if (r) recs.push(r);
      }
    }
    const scanId = ++this.scanCounter;
    this.db.tx(() => {
      for (const r of recs) this.db.upsertItem(r, scanId);
      for (const p of removed) {
        if (this.db.deleteItemByPath(p)) continue;
        // A whole subfolder disappeared.
        const prefix = p.endsWith(path.sep) ? p : p + path.sep;
        this.db.db.prepare("DELETE FROM items WHERE folder_id = ? AND substr(path, 1, ?) = ?").run(folderId, prefix.length, prefix);
      }
      this.db.pruneOrphans();
    });
    this.db.setFolderStatus(folderId, 'ready', { scanned: true });
    this.emit('changed', { folderId });
  }
}

function typeGroup(ext) {
  if (['jpg', 'jpeg', 'jpe', 'jfif'].includes(ext)) return 'jpg';
  if (['heic', 'heif', 'avif'].includes(ext)) return 'heic';
  if (['tif', 'tiff'].includes(ext)) return 'tiff';
  if (['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef'].includes(ext)) return 'raw';
  if (['mp4', 'm4v'].includes(ext)) return 'mp4';
  if (['mov'].includes(ext)) return 'mov';
  if (['png', 'gif', 'webp', 'bmp'].includes(ext)) return ext;
  return 'othervideo';
}

function fileInfo(p, st) {
  return { path: p, size: st.size, mtime: Math.floor(st.mtimeMs), stat: st };
}

async function isDir(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively yields media files under `root`, skipping hidden/system folders. */
async function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    try {
      handle = await fs.promises.opendir(dir);
    } catch {
      continue;
    }
    for await (const ent of handle) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!shouldSkipDir(ent.name)) stack.push(full);
      } else if (ent.isFile() && kindOf(ent.name)) {
        try {
          const st = await fs.promises.stat(full);
          yield fileInfo(full, st);
        } catch {
          /* vanished or no permission */
        }
      }
    }
  }
}

async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

module.exports = { Scanner, walk, typeGroup, shouldSkipDir };

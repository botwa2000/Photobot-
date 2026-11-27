'use strict';
// The photo index: a single SQLite file in the user's app-data folder.
// Photobot never writes to the photo files themselves; tags, people,
// favorites and rotation live only here.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  added_at TEXT NOT NULL,
  last_scan TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  taken TEXT NOT NULL,
  taken_src TEXT,
  width INTEGER, height INTEGER, duration REAL,
  lat REAL, lon REAL, city TEXT, country TEXT,
  camera TEXT, lens TEXT, iso REAL, fnum REAL, exposure REAL, focal REAL,
  title TEXT,
  fav INTEGER NOT NULL DEFAULT 0,
  rotation INTEGER NOT NULL DEFAULT 0,
  scan_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_taken ON items(taken DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_folder ON items(folder_id);
CREATE INDEX IF NOT EXISTS items_place ON items(country, city);
CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag_id);
CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS item_people (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (item_id, person_id)
);
CREATE INDEX IF NOT EXISTS item_people_person ON item_people(person_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const ITEM_COLS = 'i.id, i.kind, i.ext, i.name, i.taken, i.fav, i.width, i.height, i.duration, i.rotation, i.city, i.country, i.size';

class PhotoDb {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.stmts = new Map();
  }

  close() {
    this.db.close();
  }

  st(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- settings ----------
  getSetting(key, fallback = null) {
    const row = this.st('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    this.st('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---------- folders ----------
  listFolders() {
    return this.st('SELECT id, path, added_at AS addedAt, last_scan AS lastScan, status, item_count AS itemCount FROM folders ORDER BY path').all();
  }

  getFolder(id) {
    return this.st('SELECT id, path, status FROM folders WHERE id = ?').get(id);
  }

  addFolder(p) {
    this.st('INSERT OR IGNORE INTO folders(path, added_at) VALUES(?, ?)').run(p, new Date().toISOString());
    return this.st('SELECT id, path FROM folders WHERE path = ?').get(p);
  }

  removeFolder(id) {
    this.tx(() => {
      this.st('DELETE FROM items WHERE folder_id = ?').run(id);
      this.st('DELETE FROM folders WHERE id = ?').run(id);
      this.pruneOrphans();
    });
  }

  setFolderStatus(id, status, extra = {}) {
    this.st('UPDATE folders SET status = ? WHERE id = ?').run(status, id);
    if (extra.scanned) {
      const n = this.st('SELECT COUNT(*) AS n FROM items WHERE folder_id = ?').get(id).n;
      this.st('UPDATE folders SET last_scan = ?, item_count = ? WHERE id = ?').run(new Date().toISOString(), n, id);
    }
  }

  // ---------- scanning ----------
  folderIndex(folderId) {
    const map = new Map();
    for (const r of this.st('SELECT id, path, size, mtime FROM items WHERE folder_id = ?').all(folderId)) map.set(r.path, r);
    return map;
  }

  touch(id, scanId) {
    this.st('UPDATE items SET scan_id = ? WHERE id = ?').run(scanId, id);
  }

  upsertItem(rec, scanId) {
    const existing = this.st('SELECT id FROM items WHERE path = ?').get(rec.path);
    const vals = [rec.folderId, rec.name, rec.ext, rec.kind, rec.size, rec.mtime, rec.taken, rec.takenSource ?? null,
      rec.width ?? null, rec.height ?? null, rec.duration ?? null, rec.lat ?? null, rec.lon ?? null, rec.city ?? null,
      rec.country ?? null, rec.camera ?? null, rec.lens ?? null, rec.iso ?? null, rec.fnum ?? null, rec.exposure ?? null,
      rec.focal ?? null, rec.title ?? null, scanId];
    let id;
    if (existing) {
      id = existing.id;
      this.st(`UPDATE items SET folder_id=?, name=?, ext=?, kind=?, size=?, mtime=?, taken=?, taken_src=?, width=?, height=?,
        duration=?, lat=?, lon=?, city=?, country=?, camera=?, lens=?, iso=?, fnum=?, exposure=?, focal=?, title=?, scan_id=?
        WHERE id=?`).run(...vals, id);
      this.st("DELETE FROM item_tags WHERE item_id = ? AND source = 'file'").run(id);
      this.st("DELETE FROM item_people WHERE item_id = ? AND source = 'file'").run(id);
    } else {
      const r = this.st(`INSERT INTO items(folder_id, name, ext, kind, size, mtime, taken, taken_src, width, height, duration,
        lat, lon, city, country, camera, lens, iso, fnum, exposure, focal, title, scan_id, path)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, rec.path);
      id = Number(r.lastInsertRowid);
      if (rec.fav) this.st('UPDATE items SET fav = 1 WHERE id = ?').run(id);
    }
    for (const t of rec.keywords || []) this.linkTag(id, t, 'file');
    for (const p of rec.people || []) this.linkPerson(id, p, 'file');
    return id;
  }

  /** Remove items of a folder that were not seen in scan `scanId` (deleted from disk). */
  sweep(folderId, scanId) {
    const r = this.st('DELETE FROM items WHERE folder_id = ? AND scan_id <> ?').run(folderId, scanId);
    if (r.changes) this.pruneOrphans();
    return r.changes;
  }

  deleteItemByPath(p) {
    const r = this.st('DELETE FROM items WHERE path = ?').run(p);
    return r.changes;
  }

  pruneOrphans() {
    this.st('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)').run();
    this.st('DELETE FROM people WHERE id NOT IN (SELECT person_id FROM item_people)').run();
  }

  // ---------- tags & people ----------
  linkTag(itemId, name, source = 'user') {
    name = String(name).trim().slice(0, 60);
    if (!name) return;
    this.st('INSERT OR IGNORE INTO tags(name) VALUES(?)').run(name);
    const tag = this.st('SELECT id FROM tags WHERE name = ?').get(name);
    this.st('INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES(?, ?, ?)').run(itemId, tag.id, source);
  }

  unlinkTag(itemId, name) {
    const tag = this.st('SELECT id FROM tags WHERE name = ?').get(name);
    if (!tag) return;
    this.st('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(itemId, tag.id);
    this.pruneOrphans();
  }

  linkPerson(itemId, name, source = 'user') {
    name = String(name).trim().slice(0, 80);
    if (!name) return;
    this.st('INSERT OR IGNORE INTO people(name) VALUES(?)').run(name);
    const p = this.st('SELECT id FROM people WHERE name = ?').get(name);
    this.st('INSERT OR IGNORE INTO item_people(item_id, person_id, source) VALUES(?, ?, ?)').run(itemId, p.id, source);
  }

  unlinkPerson(itemId, name) {
    const p = this.st('SELECT id FROM people WHERE name = ?').get(name);
    if (!p) return;
    this.st('DELETE FROM item_people WHERE item_id = ? AND person_id = ?').run(itemId, p.id);
    this.pruneOrphans();
  }

  renamePerson(oldName, newName) {
    newName = String(newName).trim().slice(0, 80);
    if (!newName) return;
    const from = this.st('SELECT id FROM people WHERE name = ?').get(oldName);
    if (!from) return;
    const to = this.st('SELECT id FROM people WHERE name = ?').get(newName);
    this.tx(() => {
      if (to && to.id !== from.id) {
        this.st('INSERT OR IGNORE INTO item_people(item_id, person_id, source) SELECT item_id, ?, source FROM item_people WHERE person_id = ?')
          .run(to.id, from.id);
        this.st('DELETE FROM people WHERE id = ?').run(from.id);
      } else {
        this.st('UPDATE people SET name = ? WHERE id = ?').run(newName, from.id);
      }
    });
  }

  setFavorite(id, fav) {
    this.st('UPDATE items SET fav = ? WHERE id = ?').run(fav ? 1 : 0, id);
  }

  setRotation(id, rotation) {
    this.st('UPDATE items SET rotation = ? WHERE id = ?').run(((rotation % 360) + 360) % 360, id);
  }

  // ---------- queries ----------
  /**
   * Turns a filter object into SQL. Within one facet the choices are OR'd
   * (photo OR video); tags and people are AND'd (Anna AND Max in the picture).
   */
  where(f = {}) {
    const w = [];
    const p = [];
    if (f.kinds?.length) {
      w.push(`i.kind IN (${f.kinds.map(() => '?').join(',')})`);
      p.push(...f.kinds);
    }
    if (f.fav) w.push('i.fav = 1');
    if (f.folderId) {
      w.push('i.folder_id = ?');
      p.push(f.folderId);
    }
    if (f.from) {
      w.push('i.taken >= ?');
      p.push(f.from);
    }
    if (f.to) {
      w.push('i.taken < ?');
      p.push(nextDay(f.to));
    }
    if (f.year) {
      w.push('substr(i.taken, 1, 4) = ?');
      p.push(String(f.year));
    }
    for (const t of f.tags || []) {
      w.push('EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name = ?)');
      p.push(t);
    }
    for (const n of f.people || []) {
      w.push('EXISTS (SELECT 1 FROM item_people ip JOIN people pe ON pe.id = ip.person_id WHERE ip.item_id = i.id AND pe.name = ?)');
      p.push(n);
    }
    if (f.places?.length) {
      const ors = [];
      for (const pl of f.places) {
        if (pl.city) {
          ors.push('(i.city = ? AND i.country IS ?)');
          p.push(pl.city, pl.country ?? null);
        } else {
          ors.push('(i.country = ?)');
          p.push(pl.country);
        }
      }
      w.push(`(${ors.join(' OR ')})`);
    }
    if (f.noPlace) w.push('i.country IS NULL');
    if (f.cameras?.length) {
      w.push(`i.camera IN (${f.cameras.map(() => '?').join(',')})`);
      p.push(...f.cameras);
    }
    const text = (f.text || '').trim();
    if (text) {
      for (const word of text.split(/\s+/).slice(0, 6)) {
        const like = `%${word.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
        w.push(`(i.name LIKE ? ESCAPE '\\' OR i.path LIKE ? ESCAPE '\\' OR i.city LIKE ? ESCAPE '\\' OR i.country LIKE ? ESCAPE '\\'
          OR i.camera LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.taken LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM item_people ip JOIN people pe ON pe.id = ip.person_id WHERE ip.item_id = i.id AND pe.name LIKE ? ESCAPE '\\'))`);
        p.push(like, like, like, like, like, like, like, like, like);
      }
    }
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
  }

  query(filter = {}) {
    const { sql, params } = this.where(filter);
    const order = filter.sort === 'oldest' ? 'i.taken ASC, i.id ASC' : 'i.taken DESC, i.id DESC';
    return this.db.prepare(`SELECT ${ITEM_COLS} FROM items i ${sql} ORDER BY ${order}`).all(...params);
  }

  years(filter = {}) {
    const { sql, params } = this.where(filter);
    const rows = this.db.prepare(`SELECT substr(i.taken, 1, 4) AS year, COUNT(*) AS n,
        SUM(i.kind = 'video') AS videos FROM items i ${sql} GROUP BY year ORDER BY year DESC`).all(...params);
    const coverSql = this.db.prepare(`SELECT i.id, i.kind, i.rotation FROM items i ${sql ? sql + ' AND' : 'WHERE'} substr(i.taken,1,4) = ?
        ORDER BY i.fav DESC, i.kind = 'photo' DESC, i.taken DESC LIMIT 3`);
    const placeSql = this.db.prepare(`SELECT COALESCE(i.city, i.country) AS place, COUNT(*) AS n FROM items i
        ${sql ? sql + ' AND' : 'WHERE'} substr(i.taken,1,4) = ? AND i.country IS NOT NULL GROUP BY place ORDER BY n DESC LIMIT 3`);
    return rows.map((r) => ({
      year: r.year, count: r.n, videos: r.videos,
      covers: coverSql.all(...params, r.year),
      places: placeSql.all(...params, r.year).map((x) => x.place),
    }));
  }

  /** Most common place per group key (month 'YYYY-MM' or day 'YYYY-MM-DD'). */
  groupPlaces(filter = {}, len = 7) {
    const { sql, params } = this.where(filter);
    const rows = this.db.prepare(`SELECT substr(i.taken, 1, ${len}) AS k, COALESCE(i.city, i.country) AS place, COUNT(*) AS n
      FROM items i ${sql ? sql + ' AND' : 'WHERE'} i.country IS NOT NULL GROUP BY k, place ORDER BY k, n DESC`).all(...params);
    const out = {};
    for (const r of rows) {
      (out[r.k] ||= []).length < 2 && out[r.k].push(r.place);
    }
    return out;
  }

  item(id) {
    const it = this.st(`SELECT i.*, f.path AS folder FROM items i JOIN folders f ON f.id = i.folder_id WHERE i.id = ?`).get(id);
    if (!it) return null;
    it.tags = this.st('SELECT t.name, it.source FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name').all(id);
    it.people = this.st('SELECT p.name, ip.source FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = ? ORDER BY p.name').all(id);
    return it;
  }

  itemPath(id) {
    return this.st('SELECT id, path, ext, kind, mtime, size, width, height FROM items WHERE id = ?').get(id);
  }

  tags() {
    return this.st(`SELECT t.name, COUNT(*) AS n, MAX(it.item_id) AS cover FROM tags t JOIN item_tags it ON it.tag_id = t.id
      GROUP BY t.id ORDER BY n DESC, t.name`).all();
  }

  people() {
    return this.st(`SELECT p.name, COUNT(*) AS n,
        (SELECT ip2.item_id FROM item_people ip2 JOIN items i2 ON i2.id = ip2.item_id WHERE ip2.person_id = p.id AND i2.kind = 'photo'
         ORDER BY i2.fav DESC, i2.taken DESC LIMIT 1) AS cover
      FROM people p JOIN item_people ip ON ip.person_id = p.id GROUP BY p.id ORDER BY n DESC, p.name`).all();
  }

  places() {
    return this.st(`SELECT i.country, i.city, COUNT(*) AS n, MIN(i.taken) AS first, MAX(i.taken) AS last,
        (SELECT i2.id FROM items i2 WHERE i2.country IS i.country AND i2.city IS i.city ORDER BY i2.fav DESC, i2.kind = 'photo' DESC, i2.taken DESC LIMIT 1) AS cover
      FROM items i WHERE i.country IS NOT NULL GROUP BY i.country, i.city ORDER BY n DESC`).all();
  }

  cameras() {
    return this.st('SELECT camera AS name, COUNT(*) AS n FROM items WHERE camera IS NOT NULL GROUP BY camera ORDER BY n DESC').all();
  }

  /** Autocomplete for the search box. */
  suggest(q, limit = 8) {
    q = String(q || '').trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const pre = `${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const out = [];
    for (const r of this.st(`SELECT p.name, COUNT(*) n FROM people p JOIN item_people ip ON ip.person_id = p.id
        WHERE p.name LIKE ? ESCAPE '\\' GROUP BY p.id ORDER BY (p.name LIKE ? ESCAPE '\\') DESC, n DESC LIMIT ?`).all(like, pre, limit)) {
      out.push({ type: 'person', label: r.name, value: r.name, count: r.n });
    }
    for (const r of this.st(`SELECT city, country, COUNT(*) n FROM items WHERE city LIKE ? ESCAPE '\\' GROUP BY city, country
        ORDER BY (city LIKE ? ESCAPE '\\') DESC, n DESC LIMIT ?`).all(like, pre, limit)) {
      out.push({ type: 'place', label: `${r.city}, ${r.country}`, value: { city: r.city, country: r.country }, count: r.n });
    }
    for (const r of this.st(`SELECT country, COUNT(*) n FROM items WHERE country LIKE ? ESCAPE '\\' GROUP BY country ORDER BY n DESC LIMIT ?`)
      .all(like, limit)) {
      out.push({ type: 'place', label: r.country, value: { city: null, country: r.country }, count: r.n });
    }
    for (const r of this.st(`SELECT t.name, COUNT(*) n FROM tags t JOIN item_tags it ON it.tag_id = t.id WHERE t.name LIKE ? ESCAPE '\\'
        GROUP BY t.id ORDER BY (t.name LIKE ? ESCAPE '\\') DESC, n DESC LIMIT ?`).all(like, pre, limit)) {
      out.push({ type: 'tag', label: r.name, value: r.name, count: r.n });
    }
    for (const r of this.st(`SELECT camera, COUNT(*) n FROM items WHERE camera LIKE ? ESCAPE '\\' GROUP BY camera ORDER BY n DESC LIMIT 3`)
      .all(like)) {
      out.push({ type: 'camera', label: r.camera, value: r.camera, count: r.n });
    }
    if (/^(19|20)\d{2}$/.test(q)) {
      const n = this.st('SELECT COUNT(*) n FROM items WHERE substr(taken,1,4) = ?').get(q).n;
      if (n) out.unshift({ type: 'year', label: q, value: q, count: n });
    }
    return out.slice(0, 14);
  }

  allIds() {
    return new Set(this.st('SELECT id FROM items').all().map((r) => r.id));
  }

  stats() {
    return this.st(`SELECT COUNT(*) AS total, COALESCE(SUM(kind = 'photo'), 0) AS photos, COALESCE(SUM(kind = 'video'), 0) AS videos,
      COALESCE(SUM(fav), 0) AS favorites FROM items`).get();
  }
}

function nextDay(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '9999';
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { PhotoDb };

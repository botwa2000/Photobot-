'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sec = require('../../src/main/security');
const { MetaPool } = require('../../src/main/meta-pool');
const { sanitize, findKeywords } = require('../../src/main/metadata');
const { walk } = require('../../src/main/scanner');

const { v } = sec;
const throws = (fn) => assert.throws(fn, sec.ValidationError);

test('app:// only serves files inside the renderer folder', () => {
  assert.ok(sec.resolveAppFile('app://photobot/index.html').endsWith(path.join('renderer', 'index.html')));
  assert.ok(sec.resolveAppFile('app://photobot/').endsWith('index.html'));
  // The URL parser removes dot-segments first, so this stays inside the folder.
  const inside = sec.resolveAppFile('app://photobot/%2e%2e/%2e%2e/package.json');
  assert.ok(inside.startsWith(sec.RENDERER_DIR + path.sep), inside);
  for (const bad of [
    'app://photobot/..%2F..%2Fmain%2Fmain.js',
    'app://photobot/..%5C..%5Cpackage.json',
    'app://photobot/index.html%00.png',
    'app://evil/index.html',
    'app://photobot/%E0%A4%A',
    'not a url',
  ]) assert.equal(sec.resolveAppFile(bad), null, bad);
});

test('only trusted frames may call IPC', () => {
  assert.equal(sec.isTrustedFrame(null), false);
  assert.equal(sec.isTrustedFrame({ origin: 'https://evil.example', parent: null }), false);
  assert.equal(sec.isTrustedFrame({ origin: 'file://', parent: null }), false);
  assert.equal(sec.isTrustedFrame({ origin: 'app://photobot', parent: {} }), false, 'iframes are not trusted');
  assert.equal(sec.isTrustedFrame({ origin: 'app://photobot', parent: null }), true);
});

test('IPC input validation', () => {
  assert.deepEqual(v.ids([1, 2]), [1, 2]);
  throws(() => v.ids('1'));
  throws(() => v.ids([1.5]));
  throws(() => v.ids([-1]));
  throws(() => v.ids(['1']));
  throws(() => v.str('a\0b'));
  throws(() => v.str('x'.repeat(201)));
  throws(() => v.str(''));
  throws(() => v.rotation(45));
  throws(() => v.filter({ kinds: ['exe'] }));
  throws(() => v.filter({ tags: new Array(51).fill('a') }));
  throws(() => v.filter({ from: '2024-01-01; DROP' }));
  assert.deepEqual(Object.keys(v.filter({ evil: 1, tags: ['a'] })).includes('evil'), false);
  throws(() => v.folderPaths(['\\\\attacker\\share']));
  throws(() => v.folderPaths(['//attacker/share']));
  throws(() => v.folderPaths(['relative']));
  throws(() => v.settingsPatch({ types: { exe: true } }));
  throws(() => v.settingsPatch({ theme: 'neon' }));
  assert.deepEqual(v.settingsPatch({ theme: 'dark', other: 1 }), { theme: 'dark' });
});

test('only allow-listed https pages open externally', () => {
  // shell is not available outside Electron; the check happens before it is used.
  for (const bad of ['http://www.openstreetmap.org/', 'https://evil.example/', 'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id', 'javascript:alert(1)', 'https://user:pw@www.openstreetmap.org/', 'https://www.openstreetmap.org.evil.example/']) {
    assert.equal(sec.openExternalSafe(bad), false, bad);
  }
});

test('metadata from files is sanitized', () => {
  const m = sanitize({ taken: '2024-01-01T00:00:00; DROP', lat: 500, camera: 'x'.repeat(5000), keywords: ['ok', 'x'.repeat(100), 42], people: new Array(500).fill('p'), width: 1e12, iso: NaN });
  assert.equal(m.taken, null);
  assert.equal(m.lat, null);
  assert.equal(m.camera.length, 100);
  assert.deepEqual(m.keywords, ['ok']);
  assert.equal(m.people.length, 100);
  assert.equal(m.width, null);
  assert.equal(m.iso, null);
  assert.deepEqual(findKeywords({ subject: ['&lt;b&gt;x&amp;y', '&#60;i&#x3E;'] }), ['<b>x&y', '<i>']);
});

test('a stuck metadata parser is killed and replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbpool-'));
  const hang = path.join(dir, 'hang-worker.js');
  fs.writeFileSync(hang, "require('worker_threads').parentPort.on('message', () => { for (;;) {} });");
  const pool = new MetaPool(1, { timeoutMs: 500, workerFile: hang });
  const t = Date.now();
  const r = await pool.read('/x.jpg', { mtimeMs: 0, birthtimeMs: 0 });
  assert.ok(r.failed, 'expected a failed result');
  assert.ok(Date.now() - t < 5000);
  await pool.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the folder walker ignores symlinks/junctions (no loops, nothing outside the library)', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbwalk-'));
  const lib = path.join(dir, 'lib');
  const out = path.join(dir, 'out');
  fs.mkdirSync(path.join(lib, 'a'), { recursive: true });
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(lib, 'a', 'p.jpg'), 'x');
  fs.writeFileSync(path.join(out, 'secret.jpg'), 'x');
  fs.symlinkSync(lib, path.join(lib, 'a', 'loop'));
  fs.symlinkSync(out, path.join(lib, 'out'));
  fs.symlinkSync(path.join(out, 'secret.jpg'), path.join(lib, 'link.jpg'));
  const found = [];
  for await (const f of walk(lib)) found.push(path.relative(lib, f.path));
  assert.deepEqual(found, [path.join('a', 'p.jpg')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

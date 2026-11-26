'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reverseGeocode } = require('../../src/main/geo');
const { dateFromFilename, readMetadata, kindOf, parseIso6709 } = require('../../src/main/metadata');
const { PhotoDb } = require('../../src/main/db');

const LIB = path.join(__dirname, '..', 'fixtures', 'library');

test('reverse geocoding finds cities offline', () => {
  assert.equal(reverseGeocode(38.7139, -9.1334).city, 'Lisbon');
  assert.equal(reverseGeocode(48.137, 11.575).city, 'Munich');
  assert.equal(reverseGeocode(48.137, 11.575).country, 'Germany');
  assert.equal(reverseGeocode(0, 0), null);
  assert.equal(reverseGeocode(NaN, 1), null);
});

test('dates are recognised in common file names', () => {
  assert.equal(dateFromFilename('IMG_20231225_143012.jpg'), '2023-12-25T14:30:12');
  assert.equal(dateFromFilename('PXL_20240101_080910123.jpg'), '2024-01-01T08:09:10');
  assert.equal(dateFromFilename('VID-20220315-WA0001.mp4'), '2022-03-15T12:00:00');
  assert.equal(dateFromFilename('2021-07-04 18.22.01.jpg'), '2021-07-04T18:22:01');
  assert.equal(dateFromFilename('Screenshot_2023-05-06-07-08-09.png'), '2023-05-06T07:08:09');
  assert.equal(dateFromFilename('holiday.jpg'), null);
  assert.equal(dateFromFilename('IMG_1234.jpg'), null);
  assert.equal(dateFromFilename('20231399_120000.jpg'), null);
});

test('file kinds', () => {
  assert.equal(kindOf('a.JPG'), 'photo');
  assert.equal(kindOf('a.heic'), 'photo');
  assert.equal(kindOf('a.MOV'), 'video');
  assert.equal(kindOf('a.txt'), null);
});

test('ISO 6709 locations from videos', () => {
  assert.deepEqual(parseIso6709('+48.1371+011.5753/'), { lat: 48.1371, lon: 11.5753 });
  assert.deepEqual(parseIso6709('-33.8688+151.2093+012.000/'), { lat: -33.8688, lon: 151.2093 });
  assert.equal(parseIso6709('nothing'), null);
});

test('photo metadata: date, GPS, camera, keywords and people', async () => {
  const p = path.join(LIB, '2026', 'Lisbon', 'IMG_0002.jpg');
  const m = await readMetadata(p, fs.statSync(p));
  assert.equal(m.taken, '2026-11-24T18:05:00');
  assert.equal(m.takenSource, 'exif');
  assert.ok(Math.abs(m.lat - 38.7101) < 1e-3);
  assert.equal(m.camera, 'Google Pixel 9');
  assert.deepEqual(m.keywords, ['food']);
  assert.deepEqual(m.people.sort(), ['Anna', 'Max']);
});

test('video metadata: creation time, duration, size and GPS', async () => {
  const p = path.join(LIB, '2026', 'Lisbon', 'VID_0004.mp4');
  const m = await readMetadata(p, fs.statSync(p));
  assert.equal(m.takenSource, 'video');
  assert.ok(m.duration > 1.5 && m.duration < 2.5);
  assert.equal(m.width, 320);
  assert.ok(Math.abs(m.lat - 38.7139) < 1e-3);
});

test('database: filters, groups, tags, people and places', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbdb-'));
  const db = new PhotoDb(path.join(dir, 't.db'));
  try {
    const f = db.addFolder('/photos');
    const base = { folderId: f.id, ext: 'jpg', kind: 'photo', size: 1, mtime: 1 };
    const a = db.upsertItem({ ...base, path: '/photos/a.jpg', name: 'a.jpg', taken: '2026-11-24T10:00:00', city: 'Lisbon', country: 'Portugal', keywords: ['beach'], people: ['Anna'] }, 1);
    const b = db.upsertItem({ ...base, path: '/photos/b.jpg', name: 'b.jpg', taken: '2025-01-02T10:00:00', city: 'Munich', country: 'Germany', people: ['Anna', 'Max'] }, 1);
    db.upsertItem({ ...base, path: '/photos/c.mp4', name: 'c.mp4', kind: 'video', ext: 'mp4', taken: '2024-05-01T10:00:00' }, 1);

    assert.equal(db.query({}).length, 3);
    assert.deepEqual(db.query({}).map((r) => r.name), ['a.jpg', 'b.jpg', 'c.mp4']);
    assert.equal(db.query({ kinds: ['video'] }).length, 1);
    assert.deepEqual(db.query({ people: ['Anna', 'Max'] }).map((r) => r.id), [b]);
    assert.deepEqual(db.query({ tags: ['beach'] }).map((r) => r.id), [a]);
    assert.deepEqual(db.query({ places: [{ city: null, country: 'Germany' }] }).map((r) => r.id), [b]);
    assert.deepEqual(db.query({ from: '2025-01-01', to: '2025-12-31' }).map((r) => r.id), [b]);
    assert.deepEqual(db.query({ text: 'munich' }).map((r) => r.id), [b]);
    assert.deepEqual(db.query({ text: '100%' }), []);
    assert.deepEqual(db.years({}).map((y) => [y.year, y.count]), [['2026', 1], ['2025', 1], ['2024', 1]]);

    db.linkTag(b, 'Snow');
    assert.equal(db.query({ tags: ['snow'] }).length, 1, 'tags are case-insensitive');
    db.setFavorite(a, true);
    assert.equal(db.query({ fav: true }).length, 1);

    const kinds = db.suggest('an').map((s) => s.type + ':' + s.label);
    assert.ok(kinds.includes('person:Anna'), kinds.join());
    assert.ok(db.suggest('2025').some((s) => s.type === 'year'));

    db.renamePerson('Max', 'Anna');
    assert.deepEqual(db.people().map((p) => [p.name, p.n]), [['Anna', 2]]);

    // A rescan that no longer sees c.mp4 removes it; user tags on kept files survive.
    db.touch(a, 2);
    db.touch(b, 2);
    assert.equal(db.sweep(f.id, 2), 1);
    assert.equal(db.item(b).tags.some((t) => t.name === 'Snow'), true);

    // Re-reading a file replaces tags from the file but keeps the user's.
    db.upsertItem({ ...base, path: '/photos/b.jpg', name: 'b.jpg', taken: '2025-01-02T10:00:00', keywords: ['ski'] }, 3);
    assert.deepEqual(db.item(b).tags.map((t) => t.name).sort(), ['Snow', 'ski']);

    db.removeFolder(f.id);
    assert.equal(db.stats().total, 0);
    assert.equal(db.tags().length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner finds media in subfolders and skips hidden folders and tiny files', async () => {
  const { walk, Scanner } = require('../../src/main/scanner');
  const found = [];
  for await (const f of walk(LIB)) found.push(path.relative(LIB, f.path));
  assert.ok(found.some((p) => p.includes('Lisbon')));
  assert.ok(!found.some((p) => p.includes('.hidden')));
  const s = new Scanner(null, () => ({ types: {}, skipSmall: true }));
  assert.equal(s.isWanted('x.png', 80), null);
  assert.equal(s.isWanted('x.png', 50000), 'photo');
  const s2 = new Scanner(null, () => ({ types: { raw: false }, skipSmall: true }));
  assert.equal(s2.isWanted('x.nef', 5e6), null);
});

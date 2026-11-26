// End-to-end check: starts the real app on a copy of the sample library and drives the UI.
// Usage: node test/e2e.js [--shots] [--exe path/to/Photobot.exe]
// Linux needs a display (xvfb-run -a node test/e2e.js).
const { _electron: electron } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const SHOTS = args.includes('--shots');
const exeIdx = args.indexOf('--exe');
const EXE = exeIdx >= 0 ? path.resolve(args[exeIdx + 1]) : null;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'photobot-e2e-'));
const LIB = path.join(TMP, 'library');
const DATA = path.join(TMP, 'data');
const SHOT_DIR = path.join(__dirname, '.tmp', 'shots');

fs.cpSync(path.join(__dirname, 'fixtures', 'library'), LIB, { recursive: true });
if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

let step = 0;
async function check(name, fn) {
  step++;
  const t = Date.now();
  try {
    await fn();
    console.log(`  ok ${step} - ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    console.log(`  FAIL ${step} - ${name}`);
    throw e;
  }
}

(async () => {
  const launchArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const launch = (dataDir, defaults) => {
    const env = { ...process.env, PHOTOBOT_DATA_DIR: dataDir, PHOTOBOT_DEFAULT_FOLDERS: defaults };
    return electron.launch(EXE ? { executablePath: EXE, args: launchArgs, env } : { args: [ROOT, ...launchArgs], cwd: ROOT, env });
  };
  const app = await launch(DATA, '');
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/pb:\/\/thumb.*404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.setViewportSize({ width: 1400, height: 880 }).catch(() => {});
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
  const stats = () => page.evaluate(() => window.photobot.stats());

  try {
    await check('welcome screen shows when there are no folders', async () => {
      await page.waitForSelector('#empty:not([hidden]) [data-add-folder]');
      await shot('01-welcome');
    });

    await check('adding a folder scans photos and videos in all subfolders', async () => {
      await page.evaluate((p) => window.photobot.addFolders([p]), LIB);
      let s;
      for (let i = 0; i < 100; i++) {
        s = await stats();
        const folders = await page.evaluate(() => window.photobot.folders());
        if (s.total >= 9 && folders.every((f) => f.status === 'ready')) break;
        await page.waitForTimeout(200);
      }
      // 6 JPG + 1 PNG + 2 MP4; the hidden folder and the tiny icon are skipped.
      assert.equal(s.total, 9, `expected 9 items, got ${s.total}`);
      assert.equal(s.videos, 2);
    });

    await check('library groups by month with places in the header', async () => {
      await page.click('.nav-item[data-base="all"]');
      await page.waitForSelector('.ghead');
      const heads = await page.$$eval('.ghead h2', (els) => els.map((e) => e.textContent));
      assert.ok(heads.some((h) => /November 2026/.test(h)), heads.join('|'));
      const meta = await page.$$eval('.ghead .meta', (els) => els.map((e) => e.textContent).join('|'));
      assert.match(meta, /Lisbon/);
      await page.waitForFunction(() => document.querySelectorAll('.tile img.loaded, .tile video').length >= 3, null, { timeout: 15000 });
      await shot('02-library-months');
    });

    await check('years, days, all and list/size views render', async () => {
      await page.click('[data-group="year"]');
      await page.waitForSelector('.ycard');
      const years = await page.$$eval('.ycard b', (els) => els.map((e) => e.textContent));
      assert.deepEqual(years.slice(0, 3), ['2026', '2025', '2024']);
      await shot('03-years');
      await page.click('[data-group="day"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.ghead h2')].some((h) => /24/.test(h.textContent)));
      await page.click('[data-size="large"]');
      await page.waitForSelector('.tile');
      await shot('04-days-large');
      await page.click('[data-size="list"]');
      await page.waitForSelector('.lrow');
      await shot('05-list');
      await page.click('[data-size="small"]');
      await page.click('[data-group="all"]');
      await page.waitForSelector('.tile');
      assert.equal(await page.$$eval('.ghead', (e) => e.length), 0);
      await page.click('[data-size="medium"]');
      await page.click('[data-group="month"]');
    });

    await check('search suggests people, places and tags and filters the library', async () => {
      await page.fill('#search-input', 'ann');
      await page.waitForSelector('.sug');
      const labels = await page.$$eval('.sug b', (e) => e.map((x) => x.textContent));
      assert.ok(labels.includes('Anna'), labels.join('|'));
      await page.click('.sug:has-text("Anna") >> nth=0');
      await page.waitForSelector('.token.person');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
      await page.fill('#search-input', 'lisb');
      await page.waitForSelector('.sug:has-text("Lisbon")');
      await shot('06-search');
      await page.keyboard.press('Escape');
      await page.click('.token.person button');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 9);
    });

    await check('filter panel narrows to videos and back', async () => {
      await page.click('#btn-filters');
      await page.waitForSelector('#filters .chip');
      await page.click('#filters [data-facet="kind"]:has-text("Videos")');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
      await shot('07-filters');
      await page.click('#filters [data-clear]');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 9);
      await page.click('#btn-filters');
    });

    await check('viewer opens, shows details and adds a tag', async () => {
      await page.click('.tile >> nth=0');
      await page.waitForSelector('#viewer:not([hidden]) .v-info');
      await page.waitForFunction(() => {
        const m = document.querySelector('#v-media');
        return m && ((m.tagName === 'IMG' && m.naturalWidth > 0) || (m.tagName === 'VIDEO' && m.readyState > 0));
      }, null, { timeout: 10000 });
      await page.fill('#v-add-tag', 'e2e-tag');
      await page.press('#v-add-tag', 'Enter');
      await page.waitForSelector('.v-chip:has-text("e2e-tag")');
      await shot('08-viewer');
      await page.keyboard.press('Escape'); // leaves the tag box
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => /2 of 9/.test(document.querySelector('.v-top .ttl span')?.textContent || ''));
      await page.keyboard.press('f');
      await page.waitForSelector('[data-a="fav"].faved');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#viewer[hidden]', { state: 'attached' });
      assert.equal((await stats()).favorites, 1);
    });

    await check('videos play inside the viewer', async () => {
      await page.click('.nav-item[data-base="videos"]');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
      await page.click('.tile >> nth=0');
      await page.waitForFunction(() => {
        const v = document.querySelector('video#v-media');
        return v && v.readyState >= 2 && v.duration > 1;
      }, null, { timeout: 15000 });
      await shot('09-video');
      await page.keyboard.press('Escape');
      await page.click('.nav-item[data-base="all"]');
    });

    await check('selecting photos and adding a person', async () => {
      await page.waitForSelector('.tile');
      await page.click('.tile >> nth=2', { modifiers: ['Control'] });
      await page.click('.tile >> nth=3', { modifiers: ['Control'] });
      await page.waitForSelector('#selbar:not([hidden])');
      assert.match(await page.textContent('#sel-count'), /2 selected/);
      await shot('10-selection');
      await page.click('#sel-person');
      await page.fill('#ask-input', 'Oma');
      await page.click('#ask-ok');
      await page.waitForSelector('#selbar', { state: 'hidden' });
    });

    await check('people, places and tags pages list what was found', async () => {
      await page.click('.nav-item[data-route="people"]');
      await page.waitForSelector('.pcard');
      const names = await page.$$eval('.pcard b', (e) => e.map((x) => x.textContent));
      assert.deepEqual([...names].sort(), ['Anna', 'Max', 'Oma']);
      await shot('11-people');
      await page.click('.nav-item[data-route="places"]');
      await page.waitForSelector('.plcard');
      const places = await page.$$eval('.plcard b', (e) => e.map((x) => x.textContent));
      for (const p of ['Lisbon', 'Vienna']) assert.ok(places.includes(p), places.join('|'));
      await shot('12-places');
      await page.click('.plcard:has-text("Lisbon")');
      await page.waitForSelector('.token.place');
      await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4);
      await page.click('.nav-item[data-route="tags"]');
      await page.waitForSelector('.tag-cloud .chip:has-text("e2e-tag")');
      await shot('13-tags');
    });

    await check('folders page shows the folder and settings', async () => {
      await page.click('.nav-item[data-route="folders"]');
      await page.waitForSelector('.frow .status.ready');
      await shot('14-folders');
    });

    await check('new files are picked up while the app runs', async () => {
      fs.copyFileSync(path.join(LIB, '2026', 'Como', 'DSC_1002.jpg'), path.join(LIB, '2026', 'Como', 'DSC_1003.jpg'));
      let s;
      for (let i = 0; i < 60; i++) {
        s = await stats();
        if (s.total === 10) break;
        await page.waitForTimeout(250);
      }
      assert.equal(s.total, 10, 'watcher did not pick up the new file');
      fs.rmSync(path.join(LIB, '2026', 'Como', 'DSC_1003.jpg'));
      for (let i = 0; i < 60; i++) {
        s = await stats();
        if (s.total === 9) break;
        await page.waitForTimeout(250);
      }
      assert.equal(s.total, 9, 'watcher did not notice the deleted file');
    });

    await check('dark theme', async () => {
      await page.click('.nav-item[data-route="settings"]');
      await page.click('.chip[data-theme="dark"]');
      await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(17, 20, 24)');
      await page.click('.nav-item[data-base="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.tile img.loaded, .tile video').length >= 3);
      await shot('15-dark');
      await page.click('.nav-item[data-route="settings"]');
      await page.click('.chip[data-theme="system"]');
    });

    await check('no script errors', async () => {
      assert.deepEqual(errors, []);
    });

    await check('first start adds the default folder (D:\\Pictures on Windows) automatically', async () => {
      const app2 = await launch(path.join(TMP, 'data2'), LIB);
      try {
        const p2 = await app2.firstWindow();
        await p2.waitForFunction(() => window.photobot.stats().then((s) => s.total === 9), null, { timeout: 30000, polling: 300 });
        const folders = await p2.evaluate(() => window.photobot.folders());
        assert.equal(folders.length, 1);
      } finally {
        await app2.close().catch(() => {});
      }
    });
    console.log(`\nAll ${step} checks passed.`);
  } catch (e) {
    await shot('zz-failure').catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();

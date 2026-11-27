// Security tests: runs the real app against hostile files and tries common attacks.
// Usage: node test/security-e2e.js [--exe path/to/Photobot.exe]   (Linux: xvfb-run -a …)
const { _electron: electron } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const SHOTS = args.includes('--shots');
const SHOT_DIR = path.join(__dirname, '.tmp', 'shots');
const exeIdx = args.indexOf('--exe');
const EXE = exeIdx >= 0 ? path.resolve(args[exeIdx + 1]) : null;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'photobot-sec-'));
const LIB = path.join(TMP, 'library');
const OUTSIDE = path.join(TMP, 'outside');
const DATA = path.join(TMP, 'data');
const WIN = process.platform === 'win32';
const XSS_TAG = '<img src=x onerror=window.__pwned=1>';
const XSS_PERSON = '<script>window.__pwned=2</script>Eve';

// ---------- hostile fixtures ----------
function withXmp(jpeg, xmp) {
  const ns = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
  const body = Buffer.concat([ns, Buffer.from(xmp)]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}
function png(width, height, idat) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

fs.cpSync(path.join(__dirname, 'fixtures', 'library'), LIB, { recursive: true });
const hostile = path.join(LIB, 'hostile');
fs.mkdirSync(hostile);
const base = fs.readFileSync(path.join(LIB, '2026', 'Lisbon', 'IMG_0003.jpg'));
const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
<dc:subject><rdf:Bag><rdf:li>${XSS_TAG.replace(/</g, '&lt;')}</rdf:li></rdf:Bag></dc:subject>
<Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>${XSS_PERSON.replace(/</g, '&lt;')}</rdf:li></rdf:Bag></Iptc4xmpExt:PersonInImage>
</rdf:Description></rdf:RDF></x:xmpmeta>`;
const xssName = WIN ? "x' onerror='window.__pwned=3' a='.jpg" : '<img src=x onerror=window.__pwned=3>.jpg';
fs.writeFileSync(path.join(hostile, xssName), withXmp(base, xmp));
fs.writeFileSync(path.join(hostile, 'random-bytes.jpg'), require('crypto').randomBytes(40000));
fs.writeFileSync(path.join(hostile, 'truncated.jpg'), base.subarray(0, 25000));
const bigBox = Buffer.alloc(40000);
bigBox.writeUInt32BE(0xfffffff0, 0);
bigBox.write('moov', 4);
fs.writeFileSync(path.join(hostile, 'huge-box.mp4'), bigBox);
const box64 = Buffer.alloc(40000);
box64.writeUInt32BE(1, 0);
box64.write('moov', 4);
box64.writeBigUInt64BE(0xffffffffffffn, 8);
fs.writeFileSync(path.join(hostile, 'huge-box64.mov'), box64);
// "Pixel bomb": declares 60000 × 60000 (3.6 gigapixels) in a ~30 KB file.
fs.writeFileSync(path.join(hostile, 'pixel-bomb.png'), png(60000, 60000, zlib.deflateSync(Buffer.alloc(30e6), { level: 9 })));
// Links: a loop back to the library and a link to a folder outside it.
fs.mkdirSync(OUTSIDE);
fs.copyFileSync(path.join(LIB, '2026', 'Lisbon', 'IMG_0001.jpg'), path.join(OUTSIDE, 'OUTSIDE_SECRET.jpg'));
fs.symlinkSync(LIB, path.join(hostile, 'loop'), WIN ? 'junction' : 'dir');
fs.symlinkSync(OUTSIDE, path.join(hostile, 'outside-link'), WIN ? 'junction' : 'dir');
const EXPECTED = 9 + 6; // sample library + 6 hostile media files (links are not followed)

let step = 0;
async function check(name, fn) {
  step++;
  try {
    await fn();
    console.log(`  ok ${step} - ${name}`);
  } catch (e) {
    console.log(`  FAIL ${step} - ${name}`);
    throw e;
  }
}

(async () => {
  const launchArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const env = { ...process.env, PHOTOBOT_DATA_DIR: DATA, PHOTOBOT_DEFAULT_FOLDERS: '' };
  const app = await electron.launch(EXE ? { executablePath: EXE, args: launchArgs, env } : { args: [ROOT, ...launchArgs], cwd: ROOT, env });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pwned = () => page.evaluate(() => window.__pwned);
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOT_DIR, `sec-${n}.png`) });
  const stats = () => page.evaluate(() => window.photobot.stats());
  const rejects = (fnSrc) => page.evaluate(async (src) => {
    try {
      // eslint-disable-next-line no-new-func
      await new Function('api', `return (${src})(api)`)(window.photobot);
      return false;
    } catch {
      return true;
    }
  }, fnSrc);

  try {
    await page.waitForSelector('#empty:not([hidden])');

    await check('hostile files are scanned without crashing; links out of the library and loops are not followed', async () => {
      await page.evaluate((p) => window.photobot.addFolders([p]), LIB);
      let s;
      for (let i = 0; i < 150; i++) {
        s = await stats();
        const f = await page.evaluate(() => window.photobot.folders());
        if (f.every((x) => x.status === 'ready') && s.total >= EXPECTED) break;
        await page.waitForTimeout(200);
      }
      assert.equal(s.total, EXPECTED);
      const r = await page.evaluate(() => window.photobot.query({ text: 'OUTSIDE_SECRET' }, 'all'));
      assert.equal(r.items.length, 0, 'file behind a link outside the library was indexed');
    });

    await check('the app stays responsive and normal photos still get thumbnails next to a pixel bomb', async () => {
      await page.click('.nav-item[data-base="all"]');
      await page.click('[data-group="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.tile img.loaded').length >= 5, null, { timeout: 30000 });
      await page.evaluate(() => document.querySelector('.ghead') || document.querySelector('#scroller').scrollTo(0, 0));
      await shot('1-hostile-library');
      assert.equal((await stats()).total, EXPECTED);
    });

    await check('script in file names, tags and people is shown as text, never run (XSS)', async () => {
      await page.click('.nav-item[data-route="tags"]');
      await page.waitForSelector('.tag-cloud .chip');
      const tags = await page.$$eval('.tag-cloud .chip span', (e) => e.map((x) => x.textContent));
      assert.ok(tags.includes(XSS_TAG), tags.join('|'));
      await shot('2-xss-tag-shown-as-text');
      await page.click('.nav-item[data-route="people"]');
      await page.waitForSelector('.pcard');
      const people = await page.$$eval('.pcard b', (e) => e.map((x) => x.textContent));
      assert.ok(people.includes(XSS_PERSON), people.join('|'));
      await page.fill('#search-input', 'onerror');
      await page.waitForSelector('.sug');
      await page.keyboard.press('Escape');
      await page.click('.nav-item[data-route="tags"]');
      await page.locator('.tag-cloud .chip', { hasText: 'onerror' }).click();
      await page.waitForSelector('.token');
      await page.click('[data-size="list"]');
      await page.waitForFunction(() => document.querySelectorAll('.lrow').length === 1);
      await page.click('.lrow >> nth=0');
      await page.waitForSelector('#viewer:not([hidden]) .v-info');
      const info = await page.textContent('.v-info');
      assert.ok(info.includes(XSS_TAG) && info.includes(XSS_PERSON), 'viewer should show the hostile tag and person as text');
      const title = await page.textContent('.v-top .ttl b');
      assert.ok(title.includes('onerror'), title);
      await page.waitForTimeout(500);
      await shot('3-xss-in-viewer');
      await page.keyboard.press('Escape');
      await page.click('[data-size="medium"]');
      assert.equal(await pwned(), undefined, 'injected script ran');
    });

    await check('the window has no access to Node.js or Electron internals', async () => {
      const r = await page.evaluate(() => ({
        require: typeof window.require, process: typeof window.process, module: typeof window.module, electron: typeof window.electron,
        api: Object.keys(window.photobot).sort().join(','),
        origin: location.origin,
      }));
      assert.equal(r.require, 'undefined');
      assert.equal(r.process, 'undefined');
      assert.equal(r.module, 'undefined');
      assert.equal(r.origin, 'app://photobot', 'UI must be served from app://, not file://');
      assert.ok(!/ipcRenderer|send|invoke/.test(r.api), r.api);
    });

    await check('invalid or malicious IPC requests are rejected', async () => {
      assert.ok(await rejects("(a) => a.query({ kinds: ['x'] }, 'month')"));
      assert.ok(await rejects("(a) => a.query({}, 'DROP TABLE items')"));
      assert.ok(await rejects("(a) => a.addTag([1], 'x'.repeat(5000))"));
      assert.ok(await rejects("(a) => a.addTag(['1 OR 1=1'], 'x')"));
      assert.ok(await rejects("(a) => a.setFav('all', true)"));
      assert.ok(await rejects("(a) => a.rotate(1, 45)"));
      assert.ok(await rejects("(a) => a.addFolders(['\\\\\\\\attacker.example\\\\share'])"), 'UNC path accepted');
      assert.ok(await rejects("(a) => a.addFolders(['relative/path'])"));
      assert.ok(await rejects("(a) => a.addFolders(['/tmp/x\\u0000y'])"));
      assert.ok(await rejects("(a) => a.setSettings({ theme: 'x' })"));
      assert.ok(await rejects("(a) => a.setSettings({ types: { exe: true } })"));
      // SQL-like text is just text.
      const r = await page.evaluate(() => window.photobot.query({ text: "' OR 1=1 --" }, 'all'));
      assert.equal(r.items.length, 0);
      assert.equal((await stats()).total, EXPECTED);
    });

    await check('only allow-listed https pages can be opened in the browser', async () => {
      await app.evaluate(({ shell }) => {
        global.__opened = [];
        shell.openExternal = async (u) => {
          global.__opened.push(u);
        };
        shell.openPath = async (p) => {
          global.__opened.push('path:' + p);
          return '';
        };
      });
      await page.evaluate(() => {
        window.open('https://evil.example/');
        window.open('file:///etc/passwd');
        window.open('ms-msdt:/id PCWDiagnostic');
        window.open('https://www.openstreetmap.org/?mlat=1&mlon=2');
      });
      assert.equal(await page.evaluate(() => window.photobot.openUrl('https://evil.example')), 'blocked');
      assert.equal(await page.evaluate(() => window.photobot.openUrl('javascript:alert(1)')), 'blocked');
      const opened = await app.evaluate(() => global.__opened);
      assert.deepEqual(opened, ['https://www.openstreetmap.org/?mlat=1&mlon=2']);
    });

    await check('the window cannot navigate away or load anything from the internet', async () => {
      await page.evaluate(() => {
        location.href = 'https://evil.example/';
      }).catch(() => {});
      await page.waitForTimeout(800);
      assert.ok(page.url().startsWith('app://photobot/'), page.url());
      const results = await page.evaluate(async () => {
        const load = (src) => new Promise((resolve) => {
          const i = new Image();
          i.onload = () => resolve('loaded');
          i.onerror = () => resolve('blocked');
          i.src = src;
          setTimeout(() => resolve('blocked'), 4000);
        });
        let fetchResult;
        try {
          await fetch('https://example.com/');
          fetchResult = 'loaded';
        } catch {
          fetchResult = 'blocked';
        }
        return {
          web: await load('https://example.com/favicon.ico'),
          file: await load('file:///etc/hosts'),
          traversal: await load('app://photobot/..%2F..%2Fbuild%2Ficon.png'),
          traversal2: await load('app://photobot/%2e%2e/%2e%2e/build/icon.png'),
          pbBad: await load('pb://file/..%2F..%2Fetc%2Fpasswd'),
          pbMissing: await load('pb://file/987654321'),
          fetch: fetchResult,
        };
      });
      assert.deepEqual(results, { web: 'blocked', file: 'blocked', traversal: 'blocked', traversal2: 'blocked', pbBad: 'blocked', pbMissing: 'blocked', fetch: 'blocked' });
      const status = await app.evaluate(async ({ net }) => {
        const s = async (u) => (await net.fetch(u)).status;
        return [await s('app://photobot/..%2F..%2Fmain%2Fmain.js'), await s('app://evil/index.html'), await s('app://photobot/index.html')];
      });
      assert.deepEqual(status, [404, 404, 200]);
    });

    await check('camera, microphone, location and notification permissions are denied', async () => {
      const r = await page.evaluate(async () => {
        const out = {};
        try {
          await navigator.mediaDevices.getUserMedia({ video: true });
          out.camera = 'granted';
        } catch {
          out.camera = 'denied';
        }
        out.geo = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), () => resolve('denied'), { timeout: 3000 }));
        out.notify = await Notification.requestPermission();
        return out;
      });
      assert.deepEqual(r, { camera: 'denied', geo: 'denied', notify: 'denied' });
    });

    await check('removing a folder erases its cached thumbnails (privacy)', async () => {
      const thumbDir = path.join(DATA, 'thumbs');
      const count = () => fs.readdirSync(thumbDir).flatMap((d) => fs.readdirSync(path.join(thumbDir, d))).length;
      assert.ok(count() > 0, 'expected cached thumbnails');
      const [folder] = await page.evaluate(() => window.photobot.folders());
      await page.evaluate((id) => window.photobot.removeFolder(id), folder.id);
      for (let i = 0; i < 40 && count() > 0; i++) await page.waitForTimeout(250);
      assert.equal(count(), 0, 'thumbnails left behind');
    });

    await check('no unexpected script errors', async () => {
      assert.deepEqual(pageErrors.filter((m) => !/invalid request|untrusted/.test(m)), []);
    });
    console.log(`\nAll ${step} security checks passed.`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();

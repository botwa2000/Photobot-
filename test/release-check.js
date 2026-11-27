// Checks the real, fully-fused release build (no debugger can be attached to it):
//  1. it starts and creates its index,
//  2. ELECTRON_RUN_AS_NODE does not turn it into a Node.js interpreter,
//  3. (Windows/macOS) a modified app.asar is refused by ASAR integrity validation.
// Usage: node test/release-check.js --exe dist/win-unpacked/Photobot.exe
const { spawn } = require('child_process');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = path.resolve(process.argv[process.argv.indexOf('--exe') + 1]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'photobot-rel-'));
const extraArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];

function run(exePath, { env = {}, args = [], ms = 12000 } = {}) {
  return new Promise((resolve) => {
    const data = fs.mkdtempSync(path.join(TMP, 'data-'));
    const p = spawn(exePath, [...extraArgs, ...args], {
      env: { ...process.env, PHOTOBOT_DATA_DIR: data, PHOTOBOT_DEFAULT_FOLDERS: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    let exited = null;
    p.on('exit', (code) => (exited = code));
    setTimeout(() => {
      const started = fs.existsSync(path.join(data, 'photobot.db'));
      if (exited === null) p.kill('SIGKILL');
      resolve({ started, exited, out });
    }, ms);
  });
}

(async () => {
  try {
    const normal = await run(exe);
    assert.ok(normal.started, 'release build did not start');
    console.log('  ok - release build starts');

    const asNode = await run(exe, { env: { ELECTRON_RUN_AS_NODE: '1' }, args: ['-e', "console.log('RAN_AS_NODE')"] });
    assert.ok(!asNode.out.includes('RAN_AS_NODE'), 'ELECTRON_RUN_AS_NODE was honoured');
    console.log('  ok - cannot be abused as a Node.js interpreter (runAsNode fuse off)');

    const withOptions = await run(exe, { env: { NODE_OPTIONS: '--require ./does-not-matter.js' } });
    assert.ok(withOptions.started, 'NODE_OPTIONS changed behaviour');
    console.log('  ok - NODE_OPTIONS is ignored');

    if (process.platform === 'win32' || process.platform === 'darwin') {
      const appDir = path.dirname(exe);
      const copy = path.join(TMP, 'tampered');
      fs.cpSync(appDir, copy, { recursive: true });
      const asar = path.join(copy, 'resources', 'app.asar');
      const buf = fs.readFileSync(asar);
      const marker = Buffer.from("const { PhotoDb } = require('./db');");
      const at = buf.indexOf(marker);
      assert.ok(at > 0, 'marker not found in app.asar');
      buf.write('X', at); // one changed byte inside main.js
      fs.writeFileSync(asar, buf);
      const tampered = await run(path.join(copy, path.basename(exe)));
      assert.ok(!tampered.started, 'a tampered app.asar was executed');
      console.log('  ok - a modified app.asar is refused (ASAR integrity)');
    } else {
      console.log('  skip - ASAR integrity is enforced on Windows/macOS only');
    }
    console.log('\nRelease checks passed.');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  }
})();

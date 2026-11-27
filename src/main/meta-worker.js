'use strict';
// Worker thread that parses metadata of untrusted files (EXIF/XMP/IPTC, MP4 atoms).
// It runs with its own memory limit, so a malformed or hostile file can at worst
// crash or stall this worker. The main process then restarts it.
const { parentPort } = require('worker_threads');
const { readMetadata } = require('./metadata');

parentPort.on('message', async ({ jobId, file, stat }) => {
  let meta = null;
  try {
    meta = await readMetadata(file, stat);
  } catch {
    meta = null;
  }
  parentPort.postMessage({ jobId, meta });
});

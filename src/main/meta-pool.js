'use strict';
// A small pool of resource-limited worker threads for reading file metadata.
const path = require('path');
const { Worker } = require('worker_threads');
const { fallbackDate } = require('./metadata');

const TIMEOUT_MS = 20000;
const LIMITS = { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 };

class MetaPool {
  constructor(size = 2, { timeoutMs = TIMEOUT_MS, workerFile = path.join(__dirname, 'meta-worker.js') } = {}) {
    this.size = size;
    this.timeoutMs = timeoutMs;
    this.workerFile = workerFile;
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    this.disabled = false;
  }

  spawn() {
    let w;
    try {
      w = new Worker(this.workerFile, { resourceLimits: LIMITS });
    } catch {
      // Worker threads unavailable: fail closed (never parse untrusted files in-process).
      this.disabled = true;
      return null;
    }
    const slot = { w, job: null, timer: null };
    w.on('message', ({ jobId, meta }) => {
      if (!slot.job || slot.job.jobId !== jobId) return;
      this.complete(slot, meta);
    });
    const onDeath = () => {
      if (slot.job) this.complete(slot, null, true);
      this.workers = this.workers.filter((s) => s !== slot);
      setImmediate(() => this.pump());
    };
    w.on('error', onDeath);
    w.on('exit', onDeath);
    w.unref();
    this.workers.push(slot);
    return slot;
  }

  complete(slot, meta, dead = false) {
    const job = slot.job;
    slot.job = null;
    clearTimeout(slot.timer);
    job.resolve(meta || { keywords: [], people: [], failed: true });
    if (!dead) setImmediate(() => this.pump());
  }

  /** @returns {Promise<object>} metadata; never rejects. */
  read(file, stat) {
    const s = { mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs };
    if (this.disabled) return Promise.resolve({ keywords: [], people: [], failed: true });
    return new Promise((resolve) => {
      this.queue.push({ jobId: this.nextId++, file, stat: s, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      let slot = this.workers.find((s) => !s.job);
      if (!slot && this.workers.length < this.size) slot = this.spawn();
      if (!slot) {
        if (this.disabled) {
          for (const j of this.queue.splice(0)) j.resolve({ keywords: [], people: [], failed: true });
        }
        return;
      }
      const job = this.queue.shift();
      slot.job = job;
      slot.timer = setTimeout(() => {
        // Stuck on this file: kill the worker; the file gets a fallback date.
        slot.w.terminate();
      }, this.timeoutMs);
      slot.w.postMessage({ jobId: job.jobId, file: job.file, stat: job.stat });
    }
  }

  async close() {
    await Promise.all(this.workers.map((s) => s.w.terminate()));
    this.workers = [];
  }
}

module.exports = { MetaPool, fallbackDate };

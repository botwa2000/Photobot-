'use strict';
// Bridge for the hidden, sandboxed thumbnail window. It can only receive jobs and return JPEG bytes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thumbJobs', {
  onJob: (fn) => ipcRenderer.on('thumb:job', (_e, job) => fn(job)),
  done: (jobId, bytes) => ipcRenderer.send('thumb:done', jobId, bytes),
  failed: (jobId) => ipcRenderer.send('thumb:failed', jobId),
  ready: () => ipcRenderer.send('thumb:ready'),
});

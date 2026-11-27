// Runs in a hidden, sandboxed window: photos are decoded here, inside Chromium's
// sandbox, instead of in Photobot's privileged main process. A malformed image can at
// worst crash this window, which the main process then restarts.
(() => {
  const MAX_PIXELS = 120e6;
  const api = window.thumbJobs;

  async function makeThumb(job) {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous'; // pb:// allows CORS for app://photobot only
    // 'load' fires once the header is known; pixels are decoded only later, so the
    // size check below happens before a "pixel bomb" can allocate gigabytes.
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `pb://file/${job.id}`;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h || w * h > MAX_PIXELS) throw new Error('unsupported size');
    const scale = Math.min(1, job.size / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const bmp = await createImageBitmap(img, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(tw, th);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    img.src = '';
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.84 });
    return new Uint8Array(await blob.arrayBuffer());
  }

  api.onJob(async (job) => {
    try {
      api.done(job.jobId, await makeThumb(job));
    } catch {
      api.failed(job.jobId);
    }
  });
  api.ready();
})();

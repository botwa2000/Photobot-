// Renders build/icon.png (512×512) from the SVG below. Run: node scripts/make-icon.js
const { chromium } = require('playwright');
const path = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#1D4ED8"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#g)"/>
  <rect x="96" y="148" width="320" height="236" rx="34" fill="none" stroke="#fff" stroke-width="30"/>
  <path d="M176 148l26-40h108l26 40" fill="none" stroke="#fff" stroke-width="30" stroke-linejoin="round"/>
  <circle cx="256" cy="266" r="62" fill="none" stroke="#fff" stroke-width="30"/>
  <circle cx="362" cy="196" r="12" fill="#fff"/>
</svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 512, height: 512 } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await p.screenshot({ path: path.join(__dirname, '..', 'build', 'icon.png'), omitBackground: true });
  await b.close();
})();

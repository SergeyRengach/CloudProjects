// Renders public/icon.svg to the PNG sizes iOS/PWA need. Run once: node e2e/make-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const b = await chromium.launch();
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname });
}
await b.close();

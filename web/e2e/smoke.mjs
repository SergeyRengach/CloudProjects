// End-to-end smoke test in an iPad-sized Chromium (WebKit is not installed in CI sandbox).
// Usage: npm run build && npm run test:e2e
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const PORT = 4179;
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const url = `http://localhost:${PORT}/`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Нова ідея' : undefined));

try {
  await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]');
  const items = () => page.$$eval('#list .item', (els) => els.map((e) => e.querySelector('.t').textContent));
  assert.deepEqual((await items()).sort(), ['Welcome', 'Ідеї', 'Приклад'].sort());

  // live preview: markers hidden away from the cursor, shown on the cursor line; checkbox widget toggles
  await page.click('#list .item:has-text("Welcome")');
  await page.waitForSelector('.cm-line.cm-h1');
  await page.focus('.cm-content');
  await page.keyboard.press('Control+End');
  assert.ok(!(await page.innerText('.cm-line.cm-h1')).includes('#'), 'heading marker should be hidden');
  assert.ok((await page.$$('.cm-wikilink')).length >= 2, 'wikilinks styled');
  assert.ok(!(await page.innerText('.cm-content')).includes('[['), 'wikilink brackets hidden');
  await page.keyboard.press('Control+Home');
  assert.ok((await page.innerText('.cm-line.cm-h1')).includes('# '), 'marker visible on cursor line');
  await page.keyboard.press('Control+End');
  await page.click('.cm-task');
  assert.match(await page.evaluate(() => window.graphnote.editorText()), /- \[x\] Спробуйте/);
  await page.keyboard.press('Control+z');
  assert.match(await page.evaluate(() => window.graphnote.editorText()), /- \[ \] Спробуйте/);

  // backlinks of "Ідеї": Welcome links to it and "Приклад" too
  await page.click('#list .item:has-text("Ідеї")');
  await page.waitForFunction(() => document.querySelectorAll('#backlinks .item').length === 2);

  // create a note via prompt, then link to it with [[ autocomplete
  await page.click('#btn-new');
  await page.waitForFunction(() => document.getElementById('title').value === 'Нова ідея');
  await page.click('#editor .cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nЗв\'язок: [[Ід');
  await page.waitForSelector('#suggest button:has-text("Ідеї")');
  await page.click('#suggest button:has-text("Ідеї")');
  const text = () => page.evaluate(() => window.graphnote.editorText());
  assert.match(await text(), /\[\[Ідеї\]\]/);
  await page.waitForTimeout(600);

  // backlink appears on the target
  await page.click('#list .item:has-text("Ідеї")');
  await page.waitForFunction(() => document.querySelectorAll('#backlinks .item').length === 3);

  // search
  await page.fill('#search', 'нова');
  await page.waitForFunction(() => document.querySelectorAll('#list .item').length === 1);
  await page.fill('#search', '');

  // preview + wikilink click navigates
  await page.click('#list .item:has-text("Нова ідея")');
  await page.click('#mode-view');
  await page.click('#preview a[data-wiki="Ідеї"]');
  await page.waitForFunction(() => document.getElementById('title').value === 'Ідеї');

  // rename rewrites links elsewhere
  await page.fill('#title', 'Думки');
  await page.press('#title', 'Enter');
  await page.waitForFunction(() => document.getElementById('title').value === 'Думки');
  await page.click('#list .item:has-text("Нова ідея")');
  await page.click('#mode-edit');
  assert.match(await text(), /\[\[Думки\]\]/);

  // command palette (Ctrl+P): fuzzy search -> open note
  await page.keyboard.press('Control+p');
  await page.fill('#palette input', 'прикл');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('title').value === 'Проєкти/Приклад');

  // slash menu inserts a table; # autocompletes existing tags
  await page.focus('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n/табл');
  await page.click('#suggest button:has-text("Таблиця")');
  assert.match(await text(), /\| Колонка 1 \| Колонка 2 \|\n\| --- \| --- \|\n\|  \|  \|/);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nтег #ід');
  await page.click('#suggest button:has-text("#ідея")');
  assert.match(await text(), /тег #ідея $/);

  // outline lists headings and jumps to them
  await page.waitForSelector('#outline .item:has-text("Приклад проєкту")');

  // folder tree collapses
  await page.click('.folder:has-text("Проєкти")');
  assert.equal(await page.$('#list .item:has-text("Приклад")'), null);
  await page.click('.folder:has-text("Проєкти")');
  await page.waitForSelector('#list .item:has-text("Приклад")');

  // note actions: pin, version history, trash + restore
  await page.click('#list .item:has-text("Нова ідея")');
  await page.click('#btn-more');
  await page.click('.pal-item:has-text("Закріпити")');
  await page.waitForSelector('.list-section:has-text("Закріплені")');
  await page.click('#btn-more');
  await page.click('.pal-item:has-text("Історія версій")');
  await page.waitForSelector('.pal-item'); // at least one snapshot (taken before the first edit)
  await page.keyboard.press('Escape');
  await page.click('#btn-more');
  await page.click('.pal-item:has-text("кошик")');
  await page.waitForFunction(() => ![...document.querySelectorAll('#list .item .t')].some((e) => e.textContent.includes('Нова ідея')));
  await page.click('.tabs button[data-tab="trash"]');
  await page.click('[data-restore]');
  await page.waitForFunction(() => document.getElementById('title').value === 'Нова ідея');
  assert.match(await text(), /\[\[Думки\]\]/);
  await page.click('.tabs button[data-tab="files"]');

  // ![[embed]] renders the other note inline in preview
  await page.focus('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n![[Думки]]\n');
  await page.click('#mode-view');
  await page.waitForSelector('#preview .embed h1');
  await page.click('#mode-edit');

  // graph draws something and tap opens a note
  await page.click('#mode-graph');
  await page.waitForTimeout(2500);
  const painted = await page.$eval('#graph', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  assert.ok(painted > 500, `graph painted ${painted}px`);
  await page.screenshot({ path: 'e2e/graph.png' });

  // persistence across reload
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  assert.ok((await items()).includes('Нова ідея') && (await items()).includes('Думки'));

  // zip export
  await page.click('#btn-settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-zip')]);
  assert.equal(dl.suggestedFilename(), 'graphnote-vault.zip');
  const buf = await (async () => { const s = await dl.createReadStream(); const cs = []; for await (const c of s) cs.push(c); return Buffer.concat(cs); })();
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes(Buffer.from('Проєкти/Приклад.md')));
  await page.click('#settings button[value=close]');

  // narrow (portrait) layout: drawers
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.click('#btn-left');
  await page.waitForSelector('#side.open');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'e2e/portrait.png' });

  assert.deepEqual(errors, []);
  console.log('E2E OK');
} catch (e) {
  await page.screenshot({ path: 'e2e/fail.png' }).catch(() => {});
  console.error('E2E FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.kill();
}

import './style.css';
import init, { Graphnote } from './wasm/graphnote_core.js';
import * as db from './db';
import { makeZip } from './zip';
import { createEditor, type EditorApi } from './editor';

type Info = { id: number; path: string; title: string; updated: number };
type Hit = { id: number; path: string; snippet: string };
type Back = { from: number; path: string; snippet: string };
type GNode = { id: number; title: string; path: string; degree: number; tag: string | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const J = <T>(s: string) => JSON.parse(s) as T;
const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let gn: Graphnote;
let editor: EditorApi;
let cur: number | null = null;
let mode: 'edit' | 'view' | 'graph' = 'edit';
let tab: 'files' | 'tags' = 'files';
let saveTimer = 0;

// ---------- persistence ----------
async function persist(ids: number[]) {
  const notes = ids.map((id) => J<db.StoredNote | null>(gn.get_note(id))).filter((n): n is db.StoredNote => !!n);
  await db.putMany(notes);
}
const now = () => Date.now();

// ---------- sidebar ----------
function itemHtml(n: { id: number; path: string }, sub = '') {
  const title = n.path.split('/').pop()!;
  const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
  return `<button class="item${n.id === cur ? ' cur' : ''}" data-id="${n.id}"><span class="t">${esc(title)}</span><small>${esc(sub || dir)}</small></button>`;
}

function refreshList() {
  const q = $<HTMLInputElement>('search').value.trim();
  const el = $('list');
  if (q) {
    const hits = J<Hit[]>(gn.search(q, 50));
    el.innerHTML = hits.length ? hits.map((h) => itemHtml(h, h.snippet)).join('') : '<p class="muted">Нічого не знайдено</p>';
    return;
  }
  if (tab === 'tags') {
    const tags = J<[string, number][]>(gn.tags());
    el.innerHTML = tags.length
      ? tags.map(([t, c]) => `<button class="item" data-tag="${esc(t)}"><span class="t">#${esc(t)}</span><small>${c}</small></button>`).join('')
      : '<p class="muted">Тегів ще немає. Напишіть #тег у нотатці.</p>';
    return;
  }
  const notes = J<Info[]>(gn.list_notes()).sort((a, b) => a.path.localeCompare(b.path, 'uk'));
  el.innerHTML = notes.map((n) => itemHtml(n)).join('');
}

// ---------- note actions ----------
function setMode(m: typeof mode) {
  mode = m;
  $('editor').hidden = m !== 'edit' || cur === null;
  $('preview').hidden = m !== 'view' || cur === null;
  $('graphwrap').hidden = m !== 'graph';
  $('empty').hidden = m === 'graph' || cur !== null;
  (['edit', 'view', 'graph'] as const).forEach((x) => $('mode-' + x).classList.toggle('on', x === m));
  if (m === 'view') renderPreview();
  if (m === 'graph') startGraph();
  else stopGraph();
  updateQuickbar();
}

function openNote(id: number | null, newMode?: typeof mode) {
  flushSave();
  cur = id;
  const title = $<HTMLInputElement>('title');
  if (id === null) { editor.openDoc(''); title.value = ''; title.disabled = true; }
  else {
    const n = J<db.StoredNote>(gn.get_note(id));
    editor.openDoc(n.body); title.value = n.path; title.disabled = false;
    store.set('last', String(id));
  }
  setMode(newMode ?? (mode === 'graph' ? 'edit' : mode));
  refreshList(); renderRight(); closeDrawers();
}

async function createNote(path: string, body = '', open = true) {
  const id = gn.create_note(path, body, now());
  await persist([id]);
  if (open) openNote(id, 'edit'); else { refreshList(); renderRight(); }
  return id;
}

function uniquePath(base: string) {
  let p = base, i = 2;
  const taken = new Set(J<Info[]>(gn.list_notes()).map((n) => n.path.toLowerCase()));
  while (taken.has(p.toLowerCase())) p = `${base} ${i++}`;
  return p;
}

function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = 0;
  if (cur !== null) { gn.update_note(cur, editor.getValue(), now()); void persist([cur]); }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    if (cur === null) return;
    gn.update_note(cur, editor.getValue(), now());
    void persist([cur]);
    renderRight(); if (!$<HTMLInputElement>('search').value) refreshList();
  }, 350);
}

async function openToday() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const path = `Daily/${date}`;
  const existing = J<Info[]>(gn.list_notes()).find((n) => n.path === path);
  if (existing) return openNote(existing.id, 'edit');
  const tpl = J<Info[]>(gn.list_notes()).find((n) => n.path.toLowerCase() === 'templates/daily');
  const body = tpl ? (J<db.StoredNote>(gn.get_note(tpl.id)).body.replaceAll('{{date}}', date)) : `# ${date}\n\n`;
  await createNote(path, body);
}

// ---------- right panel ----------
function renderRight() {
  const set = (id: string, html: string) => { $(id).innerHTML = html || '<span class="muted">—</span>'; };
  editor?.refresh();
  if (cur === null) { ['backlinks', 'outgoing', 'unresolved', 'mentions'].forEach((i) => set(i, '')); $('bl-count').textContent = ''; return; }
  const bl = J<Back[]>(gn.backlinks(cur));
  $('bl-count').textContent = bl.length ? `(${bl.length})` : '';
  set('backlinks', bl.map((b) => `<button class="item" data-id="${b.from}"><span class="t">${esc(b.path)}</span><small>${esc(b.snippet)}</small></button>`).join(''));
  set('outgoing', J<[number, string][]>(gn.outgoing(cur)).map(([id, p]) => itemHtml({ id, path: p })).join(''));
  set('unresolved', J<string[]>(gn.unresolved(cur)).map((t) => `<button class="item unres" data-create="${esc(t)}"><span class="t">${esc(t)}</span><small>створити</small></button>`).join(''));
  set('mentions', J<Back[]>(gn.unlinked_mentions(cur)).map((b) => `<button class="item" data-id="${b.from}"><span class="t">${esc(b.path)}</span><small>${esc(b.snippet)}</small></button>`).join(''));
  const sug = J<{ to: number }[]>(gn.link_suggestions(cur));
  if (sug.length) {
    const byId = new Map(J<Info[]>(gn.list_notes()).map((n) => [n.id, n]));
    $('suggestions').innerHTML = sug.map((s) => `<button class="item" data-id="${s.to}"><span class="t">Додати [[${esc(byId.get(s.to)?.title ?? '')}]]?</span></button>`).join('');
  } else $('suggestions').innerHTML = 'Лише локальні евристики. ШІ-пропозиції з\'являться тут.';
}

function renderPreview() {
  if (cur === null) return;
  const pv = $('preview');
  pv.innerHTML = gn.render_html(cur);
  pv.querySelectorAll<HTMLAnchorElement>('a[href^="wikilink:"]').forEach((a) => {
    const t = decodeURIComponent(a.getAttribute('href')!.slice(9));
    a.dataset.wiki = t;
    a.setAttribute('href', '#');
    if (gn.resolve(t) === undefined) a.classList.add('unresolved');
  });
  pv.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c, i) => {
    c.disabled = false;
    c.addEventListener('change', () => toggleTask(i, c.checked));
  });
}

function toggleTask(index: number, checked: boolean) {
  if (cur === null) return;
  let i = -1;
  editor.replaceAll(editor.getValue().replace(/^(\s*[-*+] )\[( |x|X)\]/gm, (m, pre) => (++i === index ? `${pre}[${checked ? 'x' : ' '}]` : m)));
}

async function followWiki(t: string) {
  const id = gn.resolve(t);
  if (id !== undefined) openNote(id, 'edit');
  else await createNote(t.trim(), `# ${t.split('/').pop()}\n\n`);
}

// ---------- editor helpers ----------
function updateSuggest() {
  const box = $('suggest');
  const m = /\[\[([^\]\n|#]*)$/.exec(editor.beforeCursor().text);
  if (!m || mode !== 'edit') { box.hidden = true; return; }
  const items = J<Info[]>(gn.suggest(m[1], 8)).filter((n) => n.id !== cur);
  const exact = m[1].trim() && !items.some((n) => n.path.toLowerCase() === m[1].trim().toLowerCase());
  box.innerHTML = items.map((n) => `<button data-pick="${esc(n.path)}">${esc(n.path)}</button>`).join('') +
    (exact ? `<button data-pick="${esc(m[1].trim())}">＋ ${esc(m[1].trim())}</button>` : '');
  box.hidden = !box.innerHTML;
}

function pickSuggestion(path: string) {
  const { text, from } = editor.beforeCursor();
  const start = from + text.lastIndexOf('[[') + 2;
  const head = from + text.length;
  const after = editor.textAfterCursor(2) === ']]' ? 2 : 0;
  editor.replace(start, head + after, path + ']]');
}

function updateQuickbar() {
  const vv = window.visualViewport;
  const bar = $('quickbar');
  bar.hidden = mode !== 'edit' || cur === null;
  if (!vv) return;
  // iOS keeps the layout viewport still when the keyboard opens: lift the bar by hand.
  const lift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const y = lift > 80 ? `translateY(${-lift}px)` : '';
  bar.style.transform = y; $('suggest').style.transform = y;
}

// ---------- graph ----------
let gRaf = 0, gIds: number[] = [], gEdges: Uint32Array = new Uint32Array(), gPos = new Float32Array(), gNodes = new Map<number, GNode>();
let gScope: 'global' | 'local' = 'global';
let view = { x: 0, y: 0, k: 1 };
let hover: number | null = null, frames = 0;

function startGraph() {
  const canvas = $<HTMLCanvasElement>('graph');
  const focus = gScope === 'local' && cur !== null ? cur : -1;
  const depth = Number($<HTMLSelectElement>('g-depth').value);
  const data = J<{ nodes: GNode[] }>(gn.graph(focus, depth));
  gNodes = new Map(data.nodes.map((n) => [n.id, n]));
  gIds = Array.from(gn.layout_init(focus, depth));
  gEdges = gn.layout_edges();
  gPos = gn.layout_step(1);
  frames = 0; view = { x: 0, y: 0, k: 1 };
  fit(canvas);
  cancelAnimationFrame(gRaf);
  const loop = () => {
    if (mode !== 'graph') return;
    if (frames < 400 && (frames < 60 || gn.layout_energy() > 0.5)) { gPos = gn.layout_step(frames < 120 ? 4 : 1); frames++; }
    if (frames === 120 || frames === 300) autoFit(canvas);
    drawGraph(canvas);
    gRaf = requestAnimationFrame(loop);
  };
  gRaf = requestAnimationFrame(loop);
}
const stopGraph = () => cancelAnimationFrame(gRaf);

function autoFit(c: HTMLCanvasElement) {
  if (!gPos.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < gPos.length; i += 2) { x0 = Math.min(x0, gPos[i]); x1 = Math.max(x1, gPos[i]); y0 = Math.min(y0, gPos[i + 1]); y1 = Math.max(y1, gPos[i + 1]); }
  const k = Math.min(2.5, Math.max(0.15, 0.8 * Math.min(c.clientWidth / Math.max(60, x1 - x0), c.clientHeight / Math.max(60, y1 - y0))));
  view = { k, x: c.clientWidth / 2 - ((x0 + x1) / 2) * k, y: c.clientHeight / 2 - ((y0 + y1) / 2) * k };
}

function fit(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  view.x = c.clientWidth / 2; view.y = c.clientHeight / 2;
}

const hue = (s: string | null) => { if (!s) return 250; let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) % 360; return h; };

function drawGraph(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg').trim(), line = css.getPropertyValue('--muted').trim(), accent = css.getPropertyValue('--accent').trim();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
  const sx = (i: number) => gPos[i * 2] * view.k + view.x, sy = (i: number) => gPos[i * 2 + 1] * view.k + view.y;
  const hideOrphans = !$<HTMLInputElement>('g-orphans').checked;
  const hi = new Set<number>();
  if (hover !== null) { hi.add(hover); for (let e = 0; e < gEdges.length; e += 2) { if (gEdges[e] === hover) hi.add(gEdges[e + 1]); if (gEdges[e + 1] === hover) hi.add(gEdges[e]); } }
  ctx.lineWidth = 1;
  for (let e = 0; e < gEdges.length; e += 2) {
    const a = gEdges[e], b = gEdges[e + 1];
    const on = hover !== null && (a === hover || b === hover);
    ctx.strokeStyle = on ? accent : line; ctx.globalAlpha = hover !== null && !on ? 0.12 : 0.55;
    ctx.beginPath(); ctx.moveTo(sx(a), sy(a)); ctx.lineTo(sx(b), sy(b)); ctx.stroke();
  }
  ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
  gIds.forEach((id, i) => {
    const n = gNodes.get(id)!;
    if (hideOrphans && n.degree === 0) return;
    const r = (4 + Math.min(10, Math.sqrt(n.degree) * 3)) * Math.min(1.6, Math.max(0.7, view.k));
    const dim = hover !== null && !hi.has(id);
    ctx.globalAlpha = dim ? 0.2 : 1;
    ctx.fillStyle = id === cur ? accent : `hsl(${hue(n.tag)} 65% 62%)`;
    ctx.beginPath(); ctx.arc(sx(i), sy(i), r, 0, Math.PI * 2); ctx.fill();
    if (id === cur) { ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
    if (view.k > 0.8 || n.degree >= 3 || hi.has(id) || id === cur) { ctx.fillStyle = fg; ctx.fillText(n.title, sx(i), sy(i) + r + 13); }
  });
  ctx.globalAlpha = 1;
}

function hitNode(px: number, py: number): number | null {
  let best: number | null = null, bd = 28 * 28;
  gIds.forEach((id, i) => {
    const d = (gPos[i * 2] * view.k + view.x - px) ** 2 + (gPos[i * 2 + 1] * view.k + view.y - py) ** 2;
    if (d < bd) { bd = d; best = id; }
  });
  return best;
}

function setupGraphGestures() {
  const c = $<HTMLCanvasElement>('graph');
  const ptrs = new Map<number, { x: number; y: number }>();
  let moved = 0, t0 = 0, pinch = 0, lp = 0;
  const pos = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pos(e)); moved = 0; t0 = performance.now();
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    const p = pos(e);
    clearTimeout(lp); lp = window.setTimeout(() => { if (moved < 6 && ptrs.size === 1) { hover = hitNode(p.x, p.y); navigator.vibrate?.(10); } }, 450);
  });
  c.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId); if (!prev) { hover = hitNode(pos(e).x, pos(e).y); return; }
    const p = pos(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 1) { view.x += p.x - prev.x; view.y += p.y - prev.y; moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y); }
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / (pinch || d)); pinch = d; moved += 10;
    }
  });
  const up = (e: PointerEvent) => {
    clearTimeout(lp);
    const wasOne = ptrs.size === 1; ptrs.delete(e.pointerId);
    if (wasOne && moved < 6 && performance.now() - t0 < 450) {
      const hit = hitNode(pos(e).x, pos(e).y);
      if (hit !== null) { hover = null; openNote(hit, 'edit'); } else hover = null;
    }
  };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); clearTimeout(lp); });
  c.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e as unknown as PointerEvent); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  const zoomAt = (px: number, py: number, f: number) => {
    const k = Math.min(6, Math.max(0.15, view.k * f)); f = k / view.k;
    view.x = px - (px - view.x) * f; view.y = py - (py - view.y) * f; view.k = k;
  };
}

// ---------- settings / backup ----------
function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = store.get('theme', 'auto');
  root.style.setProperty('--font-size', store.get('font', '17') + 'px');
  root.style.setProperty('--editor-font', store.get('mono', '0') === '1' ? 'ui-monospace, Menlo, monospace' : '-apple-system, system-ui, sans-serif');
  editor.setAutocorrect(store.get('autocorrect', '0') === '1');
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function allNotes() { return J<Info[]>(gn.list_notes()).map((i) => J<db.StoredNote>(gn.get_note(i.id))); }

async function shareOrDownload(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch { /* cancelled -> download */ } }
  download(blob, name);
}

async function importFiles(files: FileList) {
  let n = 0;
  for (const f of Array.from(files)) {
    const text = await f.text();
    if (f.name.endsWith('.json')) {
      const arr = JSON.parse(text) as db.StoredNote[];
      for (const s of arr) { const p = uniquePath(s.path); const id = gn.create_note(p, s.body, s.updated || now()); await persist([id]); n++; }
    } else {
      const path = uniquePath(f.name.replace(/\.(md|markdown|txt)$/i, ''));
      await persist([gn.create_note(path, text, now())]); n++;
    }
  }
  refreshList(); alert(`Імпортовано: ${n}`);
}

// ---------- boot ----------
async function boot() {
  await init();
  gn = new Graphnote();
  gn.load(JSON.stringify(await db.getAll()));
  editor = createEditor($('editor'), {
    onChange: () => { scheduleSave(); },
    onCursor: updateSuggest,
    onWiki: (t) => void followWiki(t),
    resolve: (t) => gn.resolve(t) !== undefined,
  });
  (window as unknown as { graphnote: unknown }).graphnote = { editorText: () => editor.getValue() };
  void db.requestPersist();
  applySettings();

  if (gn.note_count() === 0) {
    const welcome = gn.create_note('Welcome', '# Ласкаво просимо до Graphnote\n\nЦе локальний нотатник у стилі Obsidian. Усе зберігається на вашому пристрої.\n\n- Зв\'язуйте нотатки: [[Ідеї]], [[Проєкти/Приклад]]\n- Теги: #старт\n- Відкрийте **Граф**, щоб побачити зв\'язки\n- Кнопка **Сьогодні** створює щоденну нотатку\n- [ ] Спробуйте відмітити цей пункт у режимі перегляду\n', now());
    const i = gn.create_note('Ідеї', '# Ідеї\n\nПовернутися на [[Welcome]]. Тут можна думати про [[Проєкти/Приклад]].\n\n#ідея\n', now());
    const p = gn.create_note('Проєкти/Приклад', '# Приклад проєкту\n\nДив. [[Ідеї]] #проєкт\n', now());
    await persist([welcome, i, p]);
  }
  gn.take_changes();

  const last = Number(store.get('last', '0'));
  const first = J<Info[]>(gn.list_notes());
  openNote(first.some((n) => n.id === last) ? last : first[0]?.id ?? null, 'edit');

  // list / panels
  document.body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const item = t.closest<HTMLElement>('[data-id],[data-create],[data-tag],[data-pick],[data-wiki]');
    if (!item) return;
    if (item.dataset.id) openNote(Number(item.dataset.id), mode === 'graph' ? 'edit' : mode);
    else if (item.dataset.create) await createNote(item.dataset.create, `# ${item.dataset.create.split('/').pop()}\n\n`);
    else if (item.dataset.tag) {
      const notes = J<Info[]>(gn.notes_with_tag(item.dataset.tag));
      $('list').innerHTML = `<button class="item" data-back="1">← Усі теги</button>` + notes.map((n) => itemHtml(n)).join('');
    } else if (item.dataset.pick) pickSuggestion(item.dataset.pick);
    else if (item.dataset.wiki) { e.preventDefault(); await followWiki(item.dataset.wiki); }
  });
  $('list').addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-back]')) refreshList(); });
  $('preview').addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); });

  $('search').addEventListener('input', refreshList);
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab as typeof tab; $<HTMLInputElement>("search").value = "";
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); refreshList();
  }));

  $('btn-new').addEventListener('click', async () => {
    const name = prompt('Назва нотатки (можна з папкою: Папка/Назва)', '');
    if (name?.trim()) { try { await createNote(uniquePath(name.trim()), `# ${name.trim().split('/').pop()}\n\n`); } catch (er) { alert(String(er)); } }
  });
  $('btn-today').addEventListener('click', () => void openToday());

  // editor shortcuts (capture phase, so they win over CodeMirror's own bindings)
  editor.view.dom.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const snippet = ({ b: '**|**', i: '*|*', k: '[[|]]' } as Record<string, string>)[e.key];
    if (snippet) { e.preventDefault(); e.stopPropagation(); editor.insertSnippet(snippet); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setMode('view'); }
  }, true);
  $('quickbar').addEventListener('pointerdown', (e) => e.preventDefault()); // keep editor focus (and keyboard)
  $('quickbar').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    if (b.dataset.ins) editor.insertSnippet(b.dataset.ins);
    else if (b.dataset.act === 'indent') editor.insertSnippet('  ');
    else if (b.dataset.act === 'undo') editor.undo();
    else if (b.dataset.act === 'redo') editor.redo();
  });
  $('suggest').addEventListener('pointerdown', (e) => e.preventDefault());
  window.visualViewport?.addEventListener('resize', updateQuickbar);
  window.visualViewport?.addEventListener('scroll', updateQuickbar);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'o') { e.preventDefault(); $('search').focus(); openDrawer('side'); }
    if (mod && e.key === 'n') { e.preventDefault(); $('btn-new').click(); }
    if (mod && e.key === 'f') { e.preventDefault(); $('search').focus(); }
    if (e.key === 'Escape') closeDrawers();
  });

  // title -> rename
  $('title').addEventListener('change', async () => {
    if (cur === null) return;
    flushSave();
    const old = J<db.StoredNote>(gn.get_note(cur)).path;
    const v = $<HTMLInputElement>('title').value;
    try { const ids = J<number[]>(gn.rename_note(cur, v, now())); await persist(ids); }
    catch (er) { alert(String(er)); $<HTMLInputElement>('title').value = old; }
    openNote(cur);
  });

  // modes
  $('mode-edit').addEventListener('click', () => setMode('edit'));
  $('mode-view').addEventListener('click', () => { flushSave(); setMode('view'); });
  $('mode-graph').addEventListener('click', () => { flushSave(); setMode('graph'); });
  $('g-global').addEventListener('click', () => { gScope = 'global'; $('g-global').classList.add('on'); $('g-local').classList.remove('on'); startGraph(); });
  $('g-local').addEventListener('click', () => { gScope = 'local'; $('g-local').classList.add('on'); $('g-global').classList.remove('on'); startGraph(); });
  $('g-depth').addEventListener('change', startGraph);
  setupGraphGestures();
  window.addEventListener('resize', () => { if (mode === 'graph') fit($('graph') as HTMLCanvasElement); updateQuickbar(); });

  // drawers
  $('btn-left').addEventListener('click', () => openDrawer('side'));
  $('btn-right').addEventListener('click', () => openDrawer('right'));
  $('scrim').addEventListener('click', closeDrawers);

  // settings
  const dlg = $<HTMLDialogElement>('settings');
  $('btn-settings').addEventListener('click', async () => {
    $<HTMLSelectElement>('set-theme').value = store.get('theme', 'auto');
    $<HTMLInputElement>('set-font').value = store.get('font', '17');
    $<HTMLSelectElement>('set-mono').value = store.get('mono', '0');
    $<HTMLInputElement>('set-autocorrect').checked = store.get('autocorrect', '0') === '1';
    $('storage-info').textContent = await db.storageInfo();
    dlg.showModal();
  });
  const bind = (id: string, key: string, get: (el: HTMLInputElement) => string) =>
    $(id).addEventListener('input', (e) => { store.set(key, get(e.target as HTMLInputElement)); applySettings(); });
  bind('set-theme', 'theme', (e) => e.value); bind('set-font', 'font', (e) => e.value);
  bind('set-mono', 'mono', (e) => e.value); bind('set-autocorrect', 'autocorrect', (e) => (e.checked ? '1' : '0'));
  $('btn-export-zip').addEventListener('click', () => {
    flushSave();
    const files = allNotes().map((n) => ({ name: n.path + '.md', data: n.body, mtime: n.updated }));
    void shareOrDownload(makeZip(files), 'graphnote-vault.zip'); store.set('lastBackup', String(now()));
  });
  $('btn-export-json').addEventListener('click', () => {
    flushSave();
    void shareOrDownload(new Blob([JSON.stringify(allNotes(), null, 1)], { type: 'application/json' }), 'graphnote-backup.json'); store.set('lastBackup', String(now()));
  });
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) await importFiles(f); (e.target as HTMLInputElement).value = ''; });

  // unflushed edits on background / close (iOS may kill the PWA at any time)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
  window.addEventListener('pagehide', flushSave);

  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.body.dataset.ready = '1';
}

function openDrawer(which: 'side' | 'right') {
  if (!matchMedia('(max-width: 1000px)').matches) return;
  closeDrawers(); $(which).classList.add('open'); $('scrim').hidden = false;
}
function closeDrawers() { $('side').classList.remove('open'); $('right').classList.remove('open'); $('scrim').hidden = true; }

boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px">Не вдалося запустити: ${esc(String(e))}</pre>`; console.error(e); });

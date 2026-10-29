import './style.css';
import init, { Graphnote } from './wasm/graphnote_core.js';
import * as db from './db';
import { makeZip } from './zip';
import { createEditor, CARET, type EditorApi } from './editor';
import { openPalette, fuzzyScore, type Cmd } from './palette';
import { SLASH } from './slash';

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
let tab: 'files' | 'recent' | 'tags' | 'trash' = 'files';
let saveTimer = 0;

// ---------- persistence ----------
async function persist(ids: number[]) {
  const notes = ids.map((id) => J<db.StoredNote | null>(gn.get_note(id))).filter((n): n is db.StoredNote => !!n);
  await db.putMany(notes);
}
const now = () => Date.now();

// ---------- sidebar ----------
const readSet = <T>(k: string): T[] => { try { return JSON.parse(store.get(k, '[]')) as T[]; } catch { return []; } };
const getPins = () => readSet<number>('pins');
const setPins = (p: number[]) => store.set('pins', JSON.stringify(p));

function ago(t: number) {
  const m = Math.round((now() - t) / 60000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  if (m < 60 * 24) return `${Math.round(m / 60)} год тому`;
  return new Date(t).toLocaleDateString('uk');
}

/** depth >= 0 renders a tree row (indented, no folder caption). */
function itemHtml(n: { id: number; path: string }, sub = '', depth = -1) {
  const title = n.path.split('/').pop()!;
  const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
  const pin = getPins().includes(n.id) ? '<span class="pin">★</span>' : '';
  const style = depth > 0 ? ` style="padding-left:${10 + depth * 14}px"` : '';
  const small = sub || (depth >= 0 ? '' : dir);
  return `<button class="item${n.id === cur ? ' cur' : ''}" data-id="${n.id}"${style}><span class="t">${pin}${esc(title)}</span>${small ? `<small>${esc(small)}</small>` : ''}</button>`;
}

function treeHtml(notes: Info[]): string {
  type Dir = { dirs: Map<string, Dir>; notes: Info[]; count: number };
  const mk = (): Dir => ({ dirs: new Map(), notes: [], count: 0 });
  const root = mk();
  for (const n of notes) {
    const parts = n.path.split('/');
    parts.pop();
    let d = root;
    for (const p of parts) { if (!d.dirs.has(p)) d.dirs.set(p, mk()); d = d.dirs.get(p)!; d.count++; }
    d.notes.push(n);
  }
  const closed = new Set(readSet<string>('collapsed'));
  const cmp = (a: string, b: string) => a.localeCompare(b, 'uk');
  const walk = (d: Dir, prefix: string, depth: number): string => {
    let h = '';
    for (const name of [...d.dirs.keys()].sort(cmp)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const sub = d.dirs.get(name)!;
      const isClosed = closed.has(path);
      h += `<button class="folder${isClosed ? ' closed' : ''}" data-folder="${esc(path)}" style="padding-left:${10 + depth * 14}px"><span class="chev">▾</span>${esc(name)}<small>${sub.count}</small></button>`;
      if (!isClosed) h += walk(sub, path, depth + 1);
    }
    for (const n of d.notes.sort((x, y) => cmp(x.title, y.title))) h += itemHtml(n, '', depth);
    return h;
  };
  return walk(root, '', 0);
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
  if (tab === 'trash') { void renderTrash(); return; }
  const notes = J<Info[]>(gn.list_notes());
  if (tab === 'recent') {
    el.innerHTML = notes.sort((a, b) => b.updated - a.updated).slice(0, 50).map((n) => itemHtml(n, ago(n.updated))).join('');
    return;
  }
  const pins = getPins().map((id) => notes.find((n) => n.id === id)).filter((n): n is Info => !!n);
  el.innerHTML = (pins.length ? `<div class="list-section">Закріплені</div>${pins.map((n) => itemHtml(n)).join('')}<div class="list-section">Усі нотатки</div>` : '') + treeHtml(notes);
}

async function renderTrash() {
  const items = await db.trashAll();
  if (tab !== 'trash' || $<HTMLInputElement>('search').value.trim()) return;
  $('list').innerHTML = items.length
    ? `<button class="item" data-empty-trash="1"><span class="t">Очистити кошик (${items.length})</span></button>` +
      items.map((n) => `<div class="trash-row"><div class="item"><span class="t">${esc(n.path.split('/').pop()!)}</span><small>${esc(n.path)} · ${ago(n.deleted)}</small></div><button class="small" data-restore="${n.id}" title="Відновити">↺</button><button class="small" data-purge="${n.id}" title="Видалити назавжди">✕</button></div>`).join('')
    : '<p class="muted">Кошик порожній</p>';
}

function switchTab(t: typeof tab) {
  tab = t;
  $<HTMLInputElement>('search').value = '';
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
  refreshList();
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
  updateQuickbar(); updateStatus(); updateSuggest();
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

const lastSnap = new Map<number, number>();
const SNAP_EVERY = 10 * 60_000;

/** Write the editor text to the vault + IndexedDB; snapshot the previous version at most every 10 min. */
function saveCurrent() {
  if (cur === null) return;
  const text = editor.getValue();
  const prev = J<db.StoredNote>(gn.get_note(cur));
  if (prev.body === text) return;
  if (prev.body.trim() && now() - (lastSnap.get(cur) ?? 0) > SNAP_EVERY) {
    lastSnap.set(cur, now());
    void db.addSnapshot({ noteId: cur, path: prev.path, body: prev.body, at: prev.updated });
  }
  gn.update_note(cur, text, now());
  void persist([cur]);
}

function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = 0;
  saveCurrent(); updateStatus();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  updateStatus(true);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    saveCurrent(); updateStatus();
    renderRight();
    if (!$<HTMLInputElement>('search').value && (tab === 'files' || tab === 'recent')) refreshList();
  }, 350);
}

function updateStatus(dirty = false) {
  if (cur === null || mode === 'graph') { $('status').textContent = ''; return; }
  const t = editor.getValue();
  const words = (t.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  $('status').textContent = `${words} сл. · ${t.length} симв. · ~${Math.max(1, Math.round(words / 200))} хв читання · ${dirty ? '•' : '✓'}`;
}

// ---------- trash / note actions ----------
async function trashNote(id: number) {
  flushSave();
  const n = J<db.StoredNote>(gn.get_note(id));
  if (!confirm(`Перемістити «${n.path}» у кошик?`)) return;
  await db.trashPut({ ...n, deleted: now() });
  gn.delete_note(id);
  await db.del(id);
  setPins(getPins().filter((p) => p !== id));
  if (cur === id) openNote(J<Info[]>(gn.list_notes()).sort((a, b) => b.updated - a.updated)[0]?.id ?? null);
  else { refreshList(); renderRight(); }
}

async function restoreNote(tid: number) {
  const n = (await db.trashAll()).find((t) => t.id === tid);
  if (!n) return;
  const path = uniquePath(n.path);
  let id = tid;
  if (gn.get_note(tid) === 'null') gn.load(JSON.stringify([{ id, path, body: n.body, created: n.created, updated: n.updated }]));
  else id = gn.create_note(path, n.body, now());
  await persist([id]);
  await db.trashDel(tid, true);
  openNote(id, 'edit');
}

async function showHistory(id: number) {
  flushSave();
  const snaps = await db.snapshots(id);
  if (!snaps.length) { alert('Збережених версій ще немає. Попередня версія зберігається перед редагуванням, не частіше ніж раз на 10 хвилин.'); return; }
  openPalette(snaps.map((v) => ({
    label: new Date(v.at).toLocaleString('uk'),
    hint: `${v.body.length} симв. · ${v.body.slice(0, 80).replace(/\s+/g, ' ')}`,
    run: () => {
      if (cur !== id) openNote(id, 'edit');
      if (!confirm(`Відновити версію від ${new Date(v.at).toLocaleString('uk')}?\nПоточний текст можна буде повернути через «Скасувати».\n\n${v.body.slice(0, 300)}`)) return;
      setMode('edit');
      editor.replaceAll(v.body);
    },
  })), 'Історія версій');
}

function noteActions() {
  if (cur === null) return;
  const id = cur;
  const n = J<db.StoredNote>(gn.get_note(id));
  const title = n.path.split('/').pop()!;
  const pinned = getPins().includes(id);
  openPalette([
    { label: pinned ? 'Відкріпити' : 'Закріпити вгорі списку', keywords: 'pin star favorite', run: () => { setPins(pinned ? getPins().filter((p) => p !== id) : [...getPins(), id]); refreshList(); } },
    { label: 'Історія версій', keywords: 'history versions restore', run: () => showHistory(id) },
    { label: 'Дублювати', keywords: 'duplicate copy', run: async () => { flushSave(); await createNote(uniquePath(n.path + ' (копія)'), editor.getValue()); } },
    { label: 'Копіювати посилання [[…]]', keywords: 'copy link clipboard', run: async () => { try { await navigator.clipboard.writeText(`[[${title}]]`); } catch { prompt('Скопіюйте посилання', `[[${title}]]`); } } },
    { label: 'Локальний граф', keywords: 'graph local', run: () => { flushSave(); setScope('local'); setMode('graph'); } },
    { label: 'Експорт нотатки (.md)', keywords: 'export share markdown', run: () => { flushSave(); void shareOrDownload(new Blob([editor.getValue()], { type: 'text/markdown' }), title + '.md'); } },
    { label: 'Перемістити в кошик', keywords: 'delete remove trash видалити', run: () => trashNote(id) },
  ], 'Дії з нотаткою');
}

const noteItems = (): Cmd[] => J<Info[]>(gn.list_notes()).sort((a, b) => b.updated - a.updated).map((n) => ({
  label: n.title, hint: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '', keywords: n.path,
  run: () => openNote(n.id, mode === 'graph' ? 'edit' : mode),
}));

function commands(): Cmd[] {
  const list: Cmd[] = [
    { label: 'Нова нотатка', keywords: 'new create створити', hint: '⌘N', run: () => $('btn-new').click() },
    { label: 'Щоденна нотатка', keywords: 'daily today сьогодні', run: openToday },
    { label: 'Редагування', keywords: 'edit', run: () => setMode('edit') },
    { label: 'Перегляд', keywords: 'preview read view', hint: '⌘↵', run: () => { flushSave(); setMode('view'); } },
    { label: 'Граф знань', keywords: 'graph', run: () => { flushSave(); setScope('global'); setMode('graph'); } },
    { label: 'Режим фокусу', keywords: 'focus zen', hint: '⌘⇧F', run: toggleFocus },
    { label: 'Дії з нотаткою…', keywords: 'actions delete pin history видалити', run: noteActions },
    { label: 'Випадкова нотатка', keywords: 'random', run: () => { const all = J<Info[]>(gn.list_notes()); if (all.length) openNote(all[Math.floor(Math.random() * all.length)].id); } },
    { label: 'Перемкнути тему', keywords: 'theme dark light тема', run: toggleTheme },
    { label: 'Кошик', keywords: 'trash deleted', run: () => { switchTab('trash'); openDrawer('side'); } },
    { label: 'Налаштування', keywords: 'settings', run: () => $('btn-settings').click() },
    { label: 'Експорт усіх нотаток (.zip)', keywords: 'export backup', run: () => $('btn-export-zip').click() },
  ];
  return [...list.map((c) => ({ ...c, label: '› ' + c.label })), ...noteItems()];
}

function toggleFocus() {
  const on = document.body.classList.toggle('focus');
  store.set('focus', on ? '1' : '0');
  if (mode === 'graph') fit($('graph') as HTMLCanvasElement);
}

function toggleTheme() {
  const t = store.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  store.set('theme', dark ? 'light' : 'dark');
  applySettings();
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
  if (cur === null) { ['outline', 'backlinks', 'outgoing', 'unresolved', 'mentions'].forEach((i) => set(i, '')); $('bl-count').textContent = ''; return; }
  const heads = J<{ level: number; text: string; line: number }[]>(gn.outline(cur));
  set('outline', heads.map((h) => `<button class="item" data-line="${h.line}" data-level="${h.level}"><span class="t">${esc(h.text)}</span></button>`).join(''));
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
  // ![[note]] embeds, one level deep
  pv.querySelectorAll<HTMLAnchorElement>('a[href^="embed:"]').forEach((a) => {
    const t = decodeURIComponent(a.getAttribute('href')!.slice(6));
    const id = gn.resolve(t);
    if (id === undefined || id === cur) { a.setAttribute('href', 'wikilink:' + encodeURIComponent(t)); return; }
    const box = document.createElement('div');
    box.className = 'embed';
    box.innerHTML = `<div class="embed-title"><a href="wikilink:${encodeURIComponent(t)}">${esc(t)}</a></div>${gn.render_html(id)}`;
    box.querySelectorAll('a[href^="embed:"]').forEach((x) => x.setAttribute('href', 'wikilink:' + x.getAttribute('href')!.slice(6)));
    const p = a.parentElement;
    if (p?.tagName === 'P' && p.childNodes.length === 1) p.replaceWith(box); else a.replaceWith(box);
  });
  pv.querySelectorAll<HTMLAnchorElement>('a[href^="wikilink:"]').forEach((a) => {
    const t = decodeURIComponent(a.getAttribute('href')!.slice(9));
    a.dataset.wiki = t;
    a.setAttribute('href', '#');
    if (gn.resolve(t) === undefined) a.classList.add('unresolved');
  });
  [...pv.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((c) => !c.closest('.embed')).forEach((c, i) => {
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
  const before = mode === 'edit' && cur !== null ? editor.beforeCursor().text : '';
  let html = '';
  const link = /\[\[([^\]\n|#]*)$/.exec(before);
  const slash = /(?:^|\s)\/([\p{L}\p{N}]*)$/u.exec(before);
  const tag = /(?:^|\s)#([\p{L}\p{N}_\-/]+)$/u.exec(before);
  if (link) {
    const items = J<Info[]>(gn.suggest(link[1], 8)).filter((n) => n.id !== cur);
    const q = link[1].trim();
    const exact = q && !items.some((n) => n.path.toLowerCase() === q.toLowerCase());
    html = items.map((n) => `<button data-pick="${esc(n.path)}">${esc(n.path)}</button>`).join('') +
      (exact ? `<button data-pick="${esc(q)}">＋ ${esc(q)}</button>` : '');
  } else if (slash) {
    const q = slash[1];
    const cmds = SLASH.map((c, i) => ({ html: `<button data-slash="${i}">${esc(c.label)}</button>`, s: fuzzyScore(q, `${c.label} ${c.keywords}`) }));
    const tpls = J<Info[]>(gn.list_notes()).filter((n) => n.path.toLowerCase().startsWith('templates/'))
      .map((n) => ({ html: `<button data-tpl="${n.id}">Шаблон: ${esc(n.title)}</button>`, s: fuzzyScore(q, `шаблон template ${n.title}`) }));
    html = [...cmds, ...tpls].filter((x) => x.s !== null).sort((a, b) => b.s! - a.s!).slice(0, 12).map((x) => x.html).join('');
  } else if (tag) {
    const q = tag[1].toLowerCase();
    html = J<[string, number][]>(gn.tags()).filter(([t]) => t.startsWith(q) && t !== q).slice(0, 10)
      .map(([t]) => `<button data-tagpick="${esc(t)}">#${esc(t)}</button>`).join('');
  }
  box.innerHTML = html;
  box.hidden = !html;
}

function pickSuggestion(path: string) {
  const { text, from } = editor.beforeCursor();
  const start = from + text.lastIndexOf('[[') + 2;
  const head = from + text.length;
  const after = editor.textAfterCursor(2) === ']]' ? 2 : 0;
  editor.replace(start, head + after, path + ']]');
}

/** Replace the typed `/query` with a snippet. */
function applySlash(snippet: string) {
  const { text, from } = editor.beforeCursor();
  editor.replace(from + text.lastIndexOf('/'), from + text.length, '');
  editor.insertSnippet(snippet);
}

function applyTemplate(id: number) {
  const n = J<db.StoredNote>(gn.get_note(id));
  const d = new Date(), p = (x: number) => String(x).padStart(2, '0');
  const title = cur !== null ? J<db.StoredNote>(gn.get_note(cur)).path.split('/').pop()! : '';
  applySlash(n.body.replaceAll('{{date}}', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
    .replaceAll('{{time}}', `${p(d.getHours())}:${p(d.getMinutes())}`).replaceAll('{{title}}', title));
}

function pickTag(t: string) {
  const { text, from } = editor.beforeCursor();
  editor.replace(from + text.lastIndexOf('#') + 1, from + text.length, t + ' ');
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

function setScope(sc: typeof gScope) {
  gScope = sc;
  $('g-global').classList.toggle('on', sc === 'global');
  $('g-local').classList.toggle('on', sc === 'local');
}

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
  gn.reserve_ids(Math.max(0, ...(await db.trashAll()).map((t) => t.id)) + 1);
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
    const welcome = gn.create_note('Welcome', '# Ласкаво просимо до Graphnote\n\nЦе локальний нотатник у стилі Obsidian. Усе зберігається на вашому пристрої.\n\n- Зв\'язуйте нотатки: [[Ідеї]], [[Проєкти/Приклад]]\n- Теги: #старт\n- Відкрийте **Граф**, щоб побачити зв\'язки\n- Кнопка **Сьогодні** створює щоденну нотатку\n- Наберіть **/** на початку рядка — меню блоків (заголовки, таблиці, завдання, дата)\n- **⌘** у бічній панелі (або ⌘P) — пошук нотаток і команд; **⋯** — дії з нотаткою (закріпити, історія версій, кошик)\n- [ ] Спробуйте відмітити цей пункт у режимі перегляду\n', now());
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
    const item = t.closest<HTMLElement>('[data-id],[data-create],[data-tag],[data-pick],[data-wiki],[data-folder],[data-line],[data-slash],[data-tpl],[data-tagpick],[data-restore],[data-purge],[data-empty-trash]');
    if (!item || item.closest('#palette')) return;
    const ds = item.dataset;
    if (ds.folder !== undefined) {
      const c = new Set(readSet<string>('collapsed'));
      if (!c.delete(ds.folder)) c.add(ds.folder);
      store.set('collapsed', JSON.stringify([...c])); refreshList();
    } else if (ds.line) { if (mode !== 'edit') setMode('edit'); editor.gotoLine(Number(ds.line)); closeDrawers(); }
    else if (ds.slash) applySlash(SLASH[Number(ds.slash)].snippet());
    else if (ds.tpl) applyTemplate(Number(ds.tpl));
    else if (ds.tagpick) pickTag(ds.tagpick);
    else if (ds.restore) await restoreNote(Number(ds.restore));
    else if (ds.purge) { if (confirm('Видалити назавжди? Це не можна скасувати.')) { await db.trashDel(Number(ds.purge)); refreshList(); } }
    else if (ds.emptyTrash) { if (confirm('Очистити кошик назавжди?')) { await db.trashClear(); refreshList(); } }
    else if (item.dataset.id) openNote(Number(item.dataset.id), mode === 'graph' ? 'edit' : mode);
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
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab as typeof tab)));
  $('btn-palette').addEventListener('click', () => openPalette(commands(), 'Нотатка або команда…'));
  $('btn-more').addEventListener('click', noteActions);
  $('btn-focus').addEventListener('click', toggleFocus);
  if (store.get('focus', '0') === '1') document.body.classList.add('focus');

  $('btn-new').addEventListener('click', async () => {
    const name = prompt('Назва нотатки (можна з папкою: Папка/Назва)', '');
    if (name?.trim()) { try { await createNote(uniquePath(name.trim()), `# ${name.trim().split('/').pop()}\n\n`); } catch (er) { alert(String(er)); } }
  });
  $('btn-today').addEventListener('click', () => void openToday());

  // editor shortcuts (capture phase, so they win over CodeMirror's own bindings)
  editor.view.dom.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const snippet = ({ b: `**${CARET}**`, i: `*${CARET}*`, k: `[[${CARET}]]` } as Record<string, string>)[e.key];
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
    const k = e.key.toLowerCase();
    if (mod && k === 'p') { e.preventDefault(); openPalette(commands(), 'Нотатка або команда…'); }
    else if (mod && k === 'o') { e.preventDefault(); openPalette(noteItems(), 'Відкрити нотатку…'); }
    else if (mod && k === 'n') { e.preventDefault(); $('btn-new').click(); }
    else if (mod && e.shiftKey && k === 'f') { e.preventDefault(); toggleFocus(); }
    else if (mod && k === 'f') { e.preventDefault(); openDrawer('side'); $('search').focus(); }
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
  $('g-global').addEventListener('click', () => { setScope('global'); startGraph(); });
  $('g-local').addEventListener('click', () => { setScope('local'); startGraph(); });
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

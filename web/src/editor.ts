// CodeMirror 6 markdown editor with Obsidian-style live preview:
// markdown markers are hidden except on the line/element under the cursor.
import { EditorState, Compartment, StateEffect, type Range } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';

export interface EditorOptions {
  onChange(): void;
  onCursor(): void;
  onWiki(target: string): void;
  resolve(target: string): boolean;
}

export interface EditorApi {
  view: EditorView;
  getValue(): string;
  /** Replace the document and reset undo history (used when switching notes). */
  openDoc(text: string): void;
  /** Replace the whole text as an undoable edit (fires onChange). */
  replaceAll(text: string): void;
  beforeCursor(): { text: string; from: number };
  textAfterCursor(n: number): string;
  replace(from: number, to: number, text: string): void;
  insertSnippet(snippet: string): void;
  focus(): void;
  undo(): void;
  redo(): void;
  refresh(): void;
  setAutocorrect(on: boolean): void;
  /** Put the caret at the start of a 1-based line and scroll it to the top. */
  gotoLine(line: number): void;
}

/** Caret marker inside snippets (a character that never appears in markdown syntax). */
export const CARET = '‸';

const refreshEffect = StateEffect.define<null>();

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: TaskWidget) { return o.checked === this.checked; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-task' + (this.checked ? ' cm-task-done' : '');
    s.setAttribute('role', 'checkbox');
    s.setAttribute('aria-checked', String(this.checked));
    s.textContent = this.checked ? '☑' : '☐';
    return s;
  }
  ignoreEvent() { return false; }
}

const HIDE = Decoration.replace({});
const lineDeco = (cls: string) => Decoration.line({ class: cls });
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText']);

function buildDecorations(view: EditorView, resolve: (t: string) => boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.ranges;
  const out: Range<Decoration>[] = [];
  const active = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const activeLine = (from: number, to: number) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    return sel.some((r) => doc.lineAt(r.from).number <= b && doc.lineAt(r.to).number >= a);
  };
  const tree = syntaxTree(state);
  const inCode = (pos: number) => {
    for (let n: { name: string; parent: unknown } | null = tree.resolveInner(pos, 1); n; n = n.parent as typeof n) if (CODE_NODES.has(n.name)) return true;
    return false;
  };
  const lines = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from); ; l = doc.line(l.number + 1)) { out.push(lineDeco(cls).range(l.from)); if (l.to >= to || l.number >= doc.lines) break; }
  };

  // YAML front matter (leading --- block)
  let fmEnd = -1;
  if (doc.lines > 2 && doc.line(1).text === '---') {
    for (let i = 2; i <= doc.lines; i++) if (doc.line(i).text === '---') { fmEnd = doc.line(i).to; break; }
    if (fmEnd > 0) lines(0, fmEnd, 'cm-frontmatter');
  }

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (n) => {
        const name = n.name;
        const h = /^ATXHeading([1-6])$/.exec(name);
        if (h) lines(n.from, n.to, `cm-h cm-h${h[1]}`);
        else if (name === 'StrongEmphasis') out.push(Decoration.mark({ class: 'cm-strong' }).range(n.from, n.to));
        else if (name === 'Emphasis') out.push(Decoration.mark({ class: 'cm-em' }).range(n.from, n.to));
        else if (name === 'Strikethrough') out.push(Decoration.mark({ class: 'cm-strike' }).range(n.from, n.to));
        else if (name === 'InlineCode') out.push(Decoration.mark({ class: 'cm-inlinecode' }).range(n.from, n.to));
        else if (name === 'FencedCode') lines(n.from, n.to, 'cm-codeblock');
        else if (name === 'Blockquote') lines(n.from, n.to, 'cm-quote');
        else if (name === 'HorizontalRule') out.push(lineDeco('cm-hr').range(doc.lineAt(n.from).from));
        else if (name === 'ListMark') out.push(Decoration.mark({ class: 'cm-listmark' }).range(n.from, n.to));
        else if (name === 'Link') out.push(Decoration.mark({ class: 'cm-mdlink' }).range(n.from, n.to));
        else if (name === 'HeaderMark') {
          if (!activeLine(n.from, n.to)) {
            const line = doc.lineAt(n.from);
            out.push(HIDE.range(n.from, n.from === line.from ? Math.min(n.to + 1, line.to) : n.to));
          }
        } else if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark' || name === 'LinkMark' || name === 'URL') {
          const p = n.node.parent;
          if (p && (name !== 'CodeMark' || p.name === 'InlineCode') && (name !== 'URL' || p.name === 'Link') && !active(p.from, p.to)) out.push(HIDE.range(n.from, n.to));
        } else if (name === 'QuoteMark') {
          if (!activeLine(n.from, n.to)) out.push(HIDE.range(n.from, Math.min(n.to + 1, doc.lineAt(n.from).to)));
        } else if (name === 'TaskMarker') {
          if (!active(n.from, n.to)) {
            const checked = /x/i.test(doc.sliceString(n.from, n.to));
            out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(n.from, n.to));
          }
        }
      },
    });

    // [[wikilinks]] and #tags (not part of the markdown grammar)
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (fmEnd > 0 && line.from <= fmEnd) { pos = line.to + 1; continue; }
      const text = line.text;
      for (const m of text.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
        const s = line.from + m.index!, e = s + m[0].length;
        if (inCode(s)) continue;
        const inner = m[1];
        const bar = inner.indexOf('|');
        const target = (bar >= 0 ? inner.slice(0, bar) : inner).split('#')[0].trim();
        if (!target) continue;
        const act = active(s, e);
        const cls = 'cm-wikilink' + (resolve(target) ? '' : ' cm-wikilink-missing');
        out.push(Decoration.mark({ class: cls, attributes: act ? { 'data-wiki': target } : { 'data-wiki': target, 'data-live': '1' } }).range(s, e));
        if (!act) {
          out.push(HIDE.range(s, s + 2), HIDE.range(e - 2, e));
          if (bar >= 0) out.push(HIDE.range(s + 2, s + 2 + bar + 1));
        }
      }
      for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_\-/]+)/gu)) {
        if (!/\p{L}/u.test(m[2])) continue;
        const s = line.from + m.index! + m[1].length;
        if (!inCode(s)) out.push(Decoration.mark({ class: 'cm-tag' }).range(s, s + m[2].length));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

function livePreview(opts: EditorOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildDecorations(view, opts.resolve); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
          this.decorations = buildDecorations(u.view, opts.resolve);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const el = e.target as HTMLElement;
          const task = el.closest('.cm-task');
          if (task) {
            const pos = view.posAtDOM(task);
            const txt = view.state.sliceDoc(pos, pos + 3);
            if (/^\[[ xX]\]$/.test(txt)) view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: txt[1] === ' ' ? 'x' : ' ' } });
            e.preventDefault();
            return true;
          }
          const w = el.closest<HTMLElement>('[data-wiki]');
          // Rendered (not being edited) links follow on tap; Cmd/Ctrl-click always follows.
          if (w && (w.dataset.live || e.metaKey || e.ctrlKey)) { e.preventDefault(); opts.onWiki(w.dataset.wiki!); return true; }
          return false;
        },
      },
    },
  );
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: 'var(--font-size)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--editor-font)', lineHeight: '1.65', overflow: 'auto', padding: '12px 0 40vh' },
  '.cm-content': { padding: '0 max(16px, calc((100% - 760px) / 2))', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-h': { fontWeight: '700', lineHeight: '1.3' },
  '.cm-h1': { fontSize: '1.8em', paddingTop: '.4em' }, '.cm-h2': { fontSize: '1.5em', paddingTop: '.3em' }, '.cm-h3': { fontSize: '1.25em' },
  '.cm-h4, .cm-h5, .cm-h6': { fontSize: '1.1em' },
  '.cm-strong': { fontWeight: '700' }, '.cm-em': { fontStyle: 'italic' }, '.cm-strike': { textDecoration: 'line-through', opacity: '.7' },
  '.cm-inlinecode': { fontFamily: 'ui-monospace, Menlo, monospace', background: 'var(--bg2)', borderRadius: '4px', padding: '0 3px', fontSize: '.92em' },
  '.cm-codeblock': { fontFamily: 'ui-monospace, Menlo, monospace', background: 'var(--bg2)', fontSize: '.92em', padding: '0 8px' },
  '.cm-quote': { borderLeft: '3px solid var(--accent)', paddingLeft: '12px', color: 'var(--muted)' },
  '.cm-hr': { borderBottom: '1px solid var(--line)' },
  '.cm-listmark': { color: 'var(--accent)', fontWeight: '700' },
  '.cm-mdlink': { color: 'var(--accent)', textDecoration: 'underline' },
  '.cm-wikilink': { color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' },
  '.cm-wikilink-missing': { opacity: '.65', textDecorationStyle: 'dashed' },
  '.cm-tag': { color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 14%, transparent)', borderRadius: '8px', padding: '0 5px' },
  '.cm-frontmatter': { color: 'var(--muted)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.85em' },
  '.cm-task': { cursor: 'pointer', fontSize: '1.15em', color: 'var(--accent)', display: 'inline-block', minWidth: '1.4em' },
  '.cm-task-done': { opacity: '.7' },
  '.cm-activeLine': { background: 'transparent' },
});

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorApi {
  const attrs = new Compartment();
  let autocorrect = false;
  const contentAttrs = () => EditorView.contentAttributes.of({
    autocorrect: autocorrect ? 'on' : 'off', autocapitalize: autocorrect ? 'sentences' : 'off', spellcheck: String(autocorrect),
    'aria-label': 'Редактор',
  });
  const makeState = (doc: string) => EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
      markdown({ extensions: GFM }),
      EditorView.lineWrapping,
      livePreview(opts),
      theme,
      attrs.of(contentAttrs()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange();
        if (u.docChanged || u.selectionSet) opts.onCursor();
      }),
    ],
  });
  const view = new EditorView({ state: makeState(''), parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    openDoc(text) { view.setState(makeState(text)); view.scrollDOM.scrollTop = 0; },
    replaceAll(text) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); },
    beforeCursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { text: view.state.sliceDoc(line.from, head), from: line.from };
    },
    textAfterCursor(n) { const h = view.state.selection.main.head; return view.state.sliceDoc(h, h + n); },
    replace(from, to, text) { view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true }); view.focus(); },
    insertSnippet(snippet) {
      const r = view.state.selection.main;
      const selected = view.state.sliceDoc(r.from, r.to);
      const caret = snippet.indexOf(CARET);
      const text = snippet.replace(CARET, selected);
      const anchor = caret >= 0 ? r.from + caret + selected.length : r.from + text.length;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
    undo: () => { undo(view); view.focus(); },
    redo: () => { redo(view); view.focus(); },
    refresh: () => view.dispatch({ effects: refreshEffect.of(null) }),
    setAutocorrect(on) { autocorrect = on; view.dispatch({ effects: attrs.reconfigure(contentAttrs()) }); },
    gotoLine(n) {
      const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 20 }) });
      view.focus();
    },
  };
}

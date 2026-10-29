// Command palette / quick switcher: fuzzy-filtered list in a modal, works with keyboard and touch.
export interface Cmd { label: string; hint?: string; keywords?: string; run(): void | Promise<void> }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Subsequence match; higher is better, null if not all query chars occur in order. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 || /[\s/_-]/.test(t[direct - 1]) ? 200 : 0);
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 5 - (found - ti) * 0.5 + (found === 0 || /[\s/_-]/.test(t[found - 1]) ? 15 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

let dlg: HTMLDialogElement | null = null;

export function openPalette(items: Cmd[], placeholder = 'Почніть вводити…') {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'palette';
    dlg.innerHTML = '<input type="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" /><div class="pal-list" role="listbox"></div>';
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg!.close(); });
  }
  const d = dlg;
  const input = d.querySelector('input')!;
  const list = d.querySelector<HTMLElement>('.pal-list')!;
  input.placeholder = placeholder;
  input.value = '';
  let shown: Cmd[] = [];
  let sel = 0;
  const render = () => {
    const q = input.value.trim();
    shown = items
      .map((c) => ({ c, s: fuzzyScore(q, `${c.label} ${c.keywords ?? ''} ${c.hint ?? ''}`) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => b.s! - a.s!)
      .slice(0, 60)
      .map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((c, i) => `<button class="pal-item${i === sel ? ' sel' : ''}" data-i="${i}" role="option"><span>${esc(c.label)}</span>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</button>`).join('')
      : '<p class="muted">Нічого не знайдено</p>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i: number) => { const c = shown[i]; if (!c) return; d.close(); void c.run(); };
  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  };
  list.onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (b) run(Number(b.dataset.i)); };
  render();
  if (!d.open) d.showModal();
  input.focus();
}

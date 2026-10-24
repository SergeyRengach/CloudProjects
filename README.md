# Graphnote

Локальний markdown-нотатник у стилі Obsidian: Rust-ядро у WebAssembly + легкий TypeScript UI. Працює в Safari на iPad як PWA, офлайн, без бекенду. Промпт-специфікація: [PROMPT.md](PROMPT.md).

## Можливості (перший прогін)
- Markdown, `[[wikilinks]]` (`[[нотатка|псевдонім]]`, `[[нотатка#заголовок]]`), backlinks, згадки без посилань, невирішені посилання
- Автодоповнення `[[`, перейменування з автооновленням посилань
- `#теги` (вкладені `#a/b`), повнотекстовий пошук (BM25, префікс, кирилиця)
- Граф знань: force-directed розкладка у WASM, Canvas, pinch/pan/tap, long-press підсвічує сусідів, глобальний/локальний
- Щоденні нотатки (`Daily/YYYY-MM-DD`, шаблон `Templates/Daily` з `{{date}}`)
- IndexedDB, експорт `.zip`/JSON, імпорт `.md`/`.json`, запит `storage.persist()`
- ШІ-готовий шар: `KnowledgeProvider`, `get_context_bundle`, чанкування, заглушка ембедингів, журнал змін — див. [docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md)

## Запуск
```sh
rustup target add wasm32-unknown-unknown && cargo install wasm-pack
cargo test                     # тести ядра
cd web && npm install
npm run dev                    # (спершу один раз: npm run wasm)
npm run build && npm run test:e2e   # збірка + e2e (потрібен playwright)
```

## iPad
Розмістіть `web/dist` на HTTPS (GitHub Pages — workflow у `.github/workflows`), відкрийте в Safari → «Поділитися» → «На початковий екран».
**T9/автовиправлення:** Налаштування iPadOS → Загальні → Клавіатура. У самому редакторі автовиправлення вимкнено за замовчуванням (⚙︎ → перемикач).

## Відомі обмеження першого прогону
- Редактор — `<textarea>` (без live-preview і підсвітки); CodeMirror 6 — наступний крок
- Повторне перерахування backlinks/графа при кожній зміні; розкладка O(n²) (комфортно до ~1500 вузлів)
- Service worker кешує за принципом cache-first + оновлення у фоні, без версіонованого precache
- Видалення нотатки та кошик в UI ще немає (є у ядрі: `delete_note`); імпорт .zip немає
- Протестовано лише в Chromium (емуляція iPad); реальний Safari/iPad не перевірявся
- `wasm-opt` вимкнено (мережа); WASM ≈ 650 КБ

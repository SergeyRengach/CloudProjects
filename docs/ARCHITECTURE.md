# Architecture

```
core/   Rust crate (rlib + cdylib). Pure logic is DOM-free and unit-tested with `cargo test`.
  parse.rs   wikilinks, #tags, front matter (code spans/blocks ignored)
  vault.rs   notes, link/tag/search indexes, backlinks, rename-with-rewrite, graph queries
  layout.rs  force-directed layout (state persists between `step` calls)
  render.rs  markdown -> HTML; wikilinks -> `wikilink:` URLs; raw HTML escaped, unsafe URL schemes dropped
  ai.rs      KnowledgeProvider, context bundles, chunking, embedding traits, suggestions
  lib.rs     wasm-bindgen facade `Graphnote` (JSON strings + typed arrays; ids are u32)
web/    Vite + TypeScript UI, IndexedDB persistence (db.ts), store-only ZIP writer (zip.ts), PWA files in public/
```

Decisions / assumptions
- Source of truth at runtime is the in-memory `Vault` in WASM; every mutation is mirrored to IndexedDB by the UI (`persist`). The ids the vault returns as changed (e.g. after rename) are the ones persisted.
- Link resolution: exact path (case-insensitive), else unique basename (alphabetically-first on ties).
- JSON strings across the WASM boundary keep the API simple; hot paths (graph positions) use `Float32Array`.
- ids are `u32` to avoid BigInt in JS.

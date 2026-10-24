# AI integration (not wired up in v1)

The core exposes everything an agent needs, read-only, through `KnowledgeProvider` (`core/src/ai.rs`) and the `Graphnote` WASM methods:

| Need | WASM method |
|---|---|
| search | `search(query, limit)` |
| read a note | `get_note(id)` |
| graph neighbourhood | `graph(focus, depth)` |
| backlinks | `backlinks(id)` |
| prompt context within a budget | `context_bundle(id, token_budget)` → focus note, outgoing, backlinks, 2-hop neighbours, truncated to ~4 chars/token |
| chunks for embeddings | `chunks(id)` (split on headings, fences respected) |
| incremental index updates | `take_changes()` (`NoteCreated/Updated/Renamed/Deleted`) |

Embeddings: implement `EmbeddingProvider` (v1: `NoopProvider`) and store vectors via `EmbeddingStore` (`InMemoryEmbeddingStore`, cosine). Persist them in a second IndexedDB store keyed `"{noteId}#{chunk}"`.

## Connecting Claude (plan)
1. User pastes an API key; store it only in local storage, send requests only on an explicit user action.
2. Tool-use schema: `search_notes{query}`, `get_note{id}`, `get_neighbors{id,depth}`, `create_note{path,body}`, `add_link{from,to}`. Read tools call the methods above directly.
3. Write tools must **not** mutate the vault directly: they produce `Suggestion` objects shown in the "Пропозиції" panel; the user accepts or rejects each one.
4. Privacy: only the context bundle (bounded by `token_budget`) leaves the device; show it to the user before sending.

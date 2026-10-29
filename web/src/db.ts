// Minimal IndexedDB wrapper. Stores: notes (by id), trash (deleted notes), history (note snapshots).
export interface StoredNote { id: number; path: string; body: string; created: number; updated: number }
export interface TrashedNote extends StoredNote { deleted: number }
export interface Snapshot { key?: number; noteId: number; path: string; body: string; at: number }

const NAME = 'graphnote';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) {
        db.createObjectStore('history', { keyPath: 'key', autoIncrement: true }).createIndex('noteId', 'noteId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? (req.result as T) : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const getAll = async () => ((await tx<StoredNote[]>('notes', 'readonly', (s) => s.getAll())) ?? []);
export const put = async (n: StoredNote) => { await tx('notes', 'readwrite', (s) => s.put(n)); };
export const del = async (id: number) => { await tx('notes', 'readwrite', (s) => s.delete(id)); };

export async function putMany(ns: StoredNote[]) {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction('notes', 'readwrite');
    ns.forEach((n) => t.objectStore('notes').put(n));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

// ----- trash -----
export const trashAll = async () => ((await tx<TrashedNote[]>('trash', 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.deleted - a.deleted);
export const trashPut = async (n: TrashedNote) => { await tx('trash', 'readwrite', (s) => s.put(n)); };
/** Remove from trash; history goes too unless the note is being restored. */
export const trashDel = async (id: number, keepHistory = false) => { await tx('trash', 'readwrite', (s) => s.delete(id)); if (!keepHistory) await historyClear(id); };
export async function trashClear() { for (const n of await trashAll()) await trashDel(n.id); }

// ----- version history -----
export async function snapshots(noteId: number): Promise<Snapshot[]> {
  const all = (await tx<Snapshot[]>('history', 'readonly', (s) => s.index('noteId').getAll(noteId))) ?? [];
  return all.sort((a, b) => b.at - a.at);
}

/** Store a snapshot and keep only the newest `keep` per note. */
export async function addSnapshot(s: Snapshot, keep = 30) {
  await tx('history', 'readwrite', (st) => st.add(s));
  const old = (await snapshots(s.noteId)).slice(keep);
  if (old.length) await tx('history', 'readwrite', (st) => { old.forEach((o) => st.delete(o.key!)); });
}

export async function historyClear(noteId: number) {
  const keys = (await snapshots(noteId)).map((s) => s.key!);
  if (keys.length) await tx('history', 'readwrite', (st) => { keys.forEach((k) => st.delete(k)); });
}

export async function storageInfo(): Promise<string> {
  try {
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const est = await navigator.storage?.estimate?.();
    const mb = ((est?.usage ?? 0) / 1048576).toFixed(1);
    return `Сховище: ${mb} МБ · захищене від очищення: ${persisted ? 'так' : 'ні'}`;
  } catch { return ''; }
}

export async function requestPersist() {
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
}

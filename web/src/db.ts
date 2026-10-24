// Minimal IndexedDB wrapper. Notes are stored as plain objects keyed by numeric id.
export interface StoredNote { id: number; path: string; body: string; created: number; updated: number }

const NAME = 'graphnote';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction('notes', mode);
    const req = fn(t.objectStore('notes'));
    t.oncomplete = () => res(req ? (req.result as T) : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const getAll = async () => ((await tx<StoredNote[]>('readonly', (s) => s.getAll())) ?? []);
export const put = async (n: StoredNote) => { await tx('readwrite', (s) => s.put(n)); };
export const del = async (id: number) => { await tx('readwrite', (s) => s.delete(id)); };

export async function putMany(ns: StoredNote[]) {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction('notes', 'readwrite');
    ns.forEach((n) => t.objectStore('notes').put(n));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
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

// 取得した地図データを IndexedDB にキャッシュする（2回目以降の起動を速くするため）。
// プライベートブラウズなどで使えない場合は何もしない。

const DB_NAME = 'toulouse-a-velo';
const STORE = 'areas';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!value || Date.now() - value.savedAt > MAX_AGE_MS) return null;
    return value.data;
  } catch {
    return null;
  }
}

export async function cachePut(key, data) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ savedAt: Date.now(), data }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 容量不足などは無視（毎回ダウンロードになるだけ）
  }
}

export async function cacheClear() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch {
    // noop
  }
}

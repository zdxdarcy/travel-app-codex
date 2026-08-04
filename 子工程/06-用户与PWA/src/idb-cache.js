const DB_NAME = "travel-app-cache-v1";
const DB_VERSION = 1;
const STORE_NAME = "records";

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB unavailable"));
  }).catch(() => null);
  return dbPromise;
}

export async function readCache(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

export async function writeCache(key, value) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

export async function removeCache(key) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

export const cacheKeys = Object.freeze({
  catalog: "catalog",
  latestCities: "latest-cities",
  trips: "trips",
  selections: "selections"
});

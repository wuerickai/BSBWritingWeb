// Minimal in-memory stand-ins for the browser APIs that js/backup.js and
// js/store/local.js use (localStorage, IndexedDB, document events), so their
// logic can run under `node --test` with no dependencies.

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// Requests resolve on a later tick, like the real thing.
function request(fn) {
  const req = {};
  setTimeout(() => {
    try { req.result = fn(); req.onsuccess && req.onsuccess(); }
    catch (e) { req.error = e; req.onerror && req.onerror(); }
  });
  return req;
}

function fakeIndexedDB() {
  const dbs = new Map(); // name -> Map(storeName -> { keyPath, rows: Map })
  return {
    open(name) {
      const req = {};
      setTimeout(() => {
        let stores = dbs.get(name);
        const db = {
          createObjectStore(s, { keyPath }) { stores.set(s, { keyPath, rows: new Map() }); },
          transaction(s) {
            return {
              objectStore() {
                const st = stores.get(s);
                const clone = (v) => (v === undefined ? undefined : structuredClone(v));
                return {
                  put: (v) => request(() => { st.rows.set(v[st.keyPath], clone(v)); }),
                  get: (k) => request(() => clone(st.rows.get(k))),
                  delete: (k) => request(() => { st.rows.delete(k); }),
                };
              },
            };
          },
        };
        req.result = db;
        if (!stores) { stores = new Map(); dbs.set(name, stores); req.onupgradeneeded && req.onupgradeneeded(); }
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

export function installBrowserStubs() {
  globalThis.localStorage = new MemStorage();
  globalThis.indexedDB = fakeIndexedDB();
  const target = new EventTarget();
  globalThis.document = {
    dispatchEvent: (e) => target.dispatchEvent(e),
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
  };
  globalThis.window = globalThis.window || { addEventListener() {} };
}

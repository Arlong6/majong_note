// 記憶體 fake adapter，模擬 Preferences / Filesystem / localStorage。
// 放在獨立模組（非 *.test.mjs）讓各測試檔共用，避免互相 import 時把對方的測試重跑一遍。
export function makeAdapter(seed = {}) {
  const pref = new Map(Object.entries(seed.pref || {}));
  const files = new Map(Object.entries(seed.files || {}));
  const legacy = new Map(Object.entries(seed.legacy || {}));
  return {
    _pref: pref, _files: files, _legacy: legacy,
    failPrefSetOn: seed.failPrefSetOn || null,
    failLegacyGetOn: seed.failLegacyGetOn || null,
    async prefGet(k) { return pref.has(k) ? pref.get(k) : null; },
    async prefSet(k, v) { if (this.failPrefSetOn === k) throw new Error('simulated pref fail'); pref.set(k, v); },
    legacyGet(k) { if (this.failLegacyGetOn === k || this.failLegacyGetOn === '*') throw new Error('simulated legacyGet fail'); return legacy.has(k) ? legacy.get(k) : null; },
    async fileWrite(n, d) { files.set(n, d); },
    async fileRead(n) { return files.has(n) ? files.get(n) : null; },
    async fileList() { return [...files.keys()]; },
    async fileDelete(n) { files.delete(n); },
    today() { return seed.today || '2026-07-07'; },
    now() { return (seed.today || '2026-07-07') + 'T00:00:00Z'; },
  };
}

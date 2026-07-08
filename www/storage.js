(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1' };
  const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];

  function createStorage(a) {
    const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

    async function readPref() {
      const rec = parse(await a.prefGet(K.rec), null);
      if (rec === null) return null;
      return { records: rec, players: parse(await a.prefGet(K.ply), DEFAULT_PLAYERS), onboarded: (await a.prefGet(K.onb)) === 'true' };
    }

    async function load() {
      // 1) 已遷移或 pref 已有資料 → 直接用 pref
      const migrated = (await a.prefGet(K.mig)) === 'true';
      const pref = await readPref();
      if (migrated || pref) return { ...(pref || { records: [], players: DEFAULT_PLAYERS, onboarded: false }), source: 'pref' };

      // 2) 未遷移 → 看 legacy localStorage
      const legacyRec = parse(a.legacyGet(K.rec), null);
      if (legacyRec !== null) {
        const players = parse(a.legacyGet(K.ply), DEFAULT_PLAYERS);
        const onboarded = a.legacyGet(K.onb) === 'true';
        try {
          // 防線#1：遷移前先備份原始 localStorage
          await a.fileWrite('pre_migration_backup.json', JSON.stringify({ version: 1, exportedAt: a.now(), records: legacyRec, players }));
          // 複製進 pref
          await a.prefSet(K.rec, JSON.stringify(legacyRec));
          await a.prefSet(K.ply, JSON.stringify(players));
          await a.prefSet(K.onb, String(onboarded));
          // 防線#2：回讀驗證
          const back = await readPref();
          const ok = back && JSON.stringify(back.records) === JSON.stringify(legacyRec);
          if (ok) { await a.prefSet(K.mig, 'true'); return { records: legacyRec, players, onboarded, source: 'migrated' }; }
        } catch (_) { /* 落到回退 */ }
        // 防線#3/#6：驗證/寫入失敗 → 不標記，回退用 legacy（資料不消失）
        return { records: legacyRec, players, onboarded, source: 'pref' };
      }

      // 3) 反向救援：pref+legacy 皆空，試最新備份
      try {
        const b = parse(await a.fileRead('backup_latest.json'), null);
        if (b && Array.isArray(b.records) && b.records.length) {
          await a.prefSet(K.rec, JSON.stringify(b.records));
          await a.prefSet(K.ply, JSON.stringify(b.players || DEFAULT_PLAYERS));
          return { records: b.records, players: b.players || DEFAULT_PLAYERS, onboarded: true, source: 'recovered' };
        }
      } catch (_) {}

      // 4) 真的全空 → 全新用戶
      return { records: [], players: DEFAULT_PLAYERS, onboarded: false, source: 'empty' };
    }
    async function save() {}
    async function writeBackup() {}
    return { load, save, writeBackup, _K: K };
  }
  return { createStorage };
});

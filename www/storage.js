(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1' };
  const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];

  function createStorage(a) {
    const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

    async function readPref() {
      // Critical#2：任何讀取例外（原生 Preferences API 拋錯、JSON 損毀等）都視為「這個來源沒資料」，
      // 絕不讓例外往外拋，否則 load() 會整個 reject，等於用戶開 app 直接白屏兼資料遺失。
      try {
        const rec = parse(await a.prefGet(K.rec), null);
        if (rec === null) return null;
        return { records: rec, players: parse(await a.prefGet(K.ply), DEFAULT_PLAYERS), onboarded: (await a.prefGet(K.onb)) === 'true' };
      } catch (_) {
        return null;
      }
    }

    async function load() {
      // 1) pref 真的有資料（含合法空陣列 []）才直接採用。
      //    不再信任 migrated 旗標：舊邏輯是「migrated=true 就直接回傳」，一旦 pref 被清空/損毀
      //    （readPref 回 null），會誤判成「已遷移=沒事」而回傳空狀態，跳過後面救援、造成資料遺失。
      //    現在只看 pref 本身：readPref 回傳物件（哪怕 records 是合法空陣列）才代表「有資料」，
      //    回 null（key 不存在或 JSON 損毀）一律往下走 legacy/backup 救援，不管 migrated 是不是 true。
      const pref = await readPref();
      if (pref) return { ...pref, source: 'pref' };

      // 2) pref 沒資料 → 看 legacy localStorage（即使先前已標記 migrated，也重跑一次冪等遷移救援）
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
          // 防線#2：回讀驗證 —— records 和 players 都要比對，只比 records 會漏掉 players 寫壞的情況
          const back = await readPref();
          const ok = back
            && JSON.stringify(back.records) === JSON.stringify(legacyRec)
            && JSON.stringify(back.players) === JSON.stringify(players);
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
          // Minor#5：救援回來的資料代表用戶本來就用過，需持久化 onboarded，
          // 否則下次啟動仍會被當成全新用戶（走 onboarding 流程）。
          await a.prefSet(K.onb, 'true');
          return { records: b.records, players: b.players || DEFAULT_PLAYERS, onboarded: true, source: 'recovered' };
        }
      } catch (_) {}

      // 4) 真的全空 → 全新用戶
      return { records: [], players: DEFAULT_PLAYERS, onboarded: false, source: 'empty' };
    }
    async function save(d) {
      const records = d.records || [];
      const players = d.players || DEFAULT_PLAYERS;
      // Important#4：belt-and-suspenders —— 若這次要寫入空陣列、但 pref 目前存有非空資料，
      // 視為可疑覆蓋（呼叫端可能誤傳空狀態），先確保目前資料備份一份再寫，避免無法復原。
      // 合法清空仍然允許寫入，只是先留一份備份保險，不做任何攔截/拒絕。
      if (records.length === 0) {
        try {
          const current = await readPref();
          if (current && Array.isArray(current.records) && current.records.length > 0) {
            await writeBackup(current);
          }
        } catch (_) { /* 備份失敗不阻擋寫入 */ }
      }
      await a.prefSet(K.rec, JSON.stringify(records));
      await a.prefSet(K.ply, JSON.stringify(players));
      await a.prefSet(K.onb, String(!!d.onboarded));
    }

    async function writeBackup(d) {
      const payload = JSON.stringify({ version: 1, exportedAt: a.now(), records: d.records || [], players: d.players || DEFAULT_PLAYERS });
      try {
        await a.fileWrite('backup_latest.json', payload);
        await a.fileWrite('backup_' + a.today() + '.json', payload);
        // 輪替：只保留最近 7 份帶日期快照
        const snaps = (await a.fileList()).filter(n => /^backup_\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
        for (const old of snaps.slice(0, Math.max(0, snaps.length - 7))) {
          // Minor#6：單一檔案刪除失敗不該中斷整輪輪替，否則其餘該砍的舊快照會一直留著
          try { await a.fileDelete(old); } catch (_) {}
        }
      } catch (_) { /* 備份失敗不影響主流程 */ }
    }
    return { load, save, writeBackup, _K: K };
  }
  return { createStorage };
});

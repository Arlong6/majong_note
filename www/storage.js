(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1' };
  const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];

  function createStorage(a) {
    const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

    // 1.2.2-A2：legacyGet 是 load() 裡唯一沒有防護的外部呼叫。
    // localStorage 在 WKWebView 儲存被系統回收、無痕模式、企業描述檔限制下會直接 throw
    // SecurityError/QuotaError，一旦拋出就讓整個 load() reject，呼叫端的 setLoading(false)
    // 永遠不會執行 → 使用者卡在「載入中…」永久轉圈，而且後面第 3 層 backup 救援也跑不到。
    // 這裡一律吞掉例外當作「這個來源沒資料」，語意與 readPref 的防護一致。
    const legacyGet = (k) => { try { return a.legacyGet(k); } catch (_) { return null; } };

    const newId = () => {
      try { if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID(); } catch (_) {}
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    };

    // 1.2.2-A3：匯入來源是使用者自選的任意檔案。舊版只 catch JSON.parse，
    // 任何「合法 JSON 但結構不對」的檔案（{}、別的 app 的備份、amount 是字串）
    // 都會直接進 state：輕則總結算靜默算錯，重則 render 期拋錯白屏且已持久化。
    // 這裡做嚴格驗證 + 正規化，任何一筆不合法就整份拒絕（不做部分匯入，避免使用者
    // 以為匯入成功卻缺資料）。
    function validateBackup(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '這個檔案不是麻將戰績的備份檔。' };
      if (!Array.isArray(obj.records)) return { ok: false, error: '備份檔裡找不到紀錄資料。' };

      const seen = new Set();
      const records = [];
      for (let i = 0; i < obj.records.length; i++) {
        const r = obj.records[i];
        const at = '第 ' + (i + 1) + ' 筆紀錄';
        if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: at + '格式無法辨識。' };

        const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: at + '的金額無效。' };

        const t = r.date == null ? NaN : new Date(r.date).getTime();
        if (!Number.isFinite(t)) return { ok: false, error: at + '的日期無效。' };

        if (r.type !== 'win' && r.type !== 'loss') return { ok: false, error: at + '的輸贏欄位無效。' };

        let id = r.id;
        if (id == null || seen.has(id)) id = newId();
        seen.add(id);

        records.push({
          id: id,
          date: new Date(t).toISOString(),
          amount: amount,
          type: r.type,
          note: typeof r.note === 'string' ? r.note : '',
          participants: Array.isArray(r.participants) ? r.participants.filter(p => typeof p === 'string') : [],
        });
      }

      const players = Array.isArray(obj.players)
        ? obj.players.filter(p => typeof p === 'string' && p.trim() !== '')
        : [];

      return { ok: true, records: records, players: players };
    }

    async function readPref() {
      // Critical#2：任何讀取例外（原生 Preferences API 拋錯、JSON 損毀等）都視為「這個來源沒資料」，
      // 絕不讓例外往外拋，否則 load() 會整個 reject，等於用戶開 app 直接白屏兼資料遺失。
      //
      // Critical（欄位隔離）：records（主鍵）與 players/onboarded（次要欄位）必須各自獨立判斷失敗，
      // 不可綁在同一個 try/catch。理由：若三者共用一個 try/catch，次要欄位偶發讀取失敗
      // （例如 prefGet(K.ply) 拋錯）會讓整個函式回 null，被 load()/save() 誤判成「pref 完全沒資料」，
      // 進而觸發救援或用舊快照覆寫「明明是好的」records 並持久化——等於主鍵資料因次鍵故障而遺失/回退。
      // 因此：只有 records 讀取失敗或 parse 後為 null，才代表主資料不可信、readPref 回 null。
      // players/onboarded 各自獨立 try/catch，任何失敗都只 fallback 到預設值，絕不影響主鍵判斷。
      let rec;
      try {
        rec = parse(await a.prefGet(K.rec), null);
      } catch (_) {
        return null;
      }
      if (rec === null) return null;

      let players = DEFAULT_PLAYERS;
      try {
        players = parse(await a.prefGet(K.ply), DEFAULT_PLAYERS);
      } catch (_) { /* 次鍵失敗不影響主鍵，fallback 預設值 */ }

      let onboarded = false;
      try {
        onboarded = (await a.prefGet(K.onb)) === 'true';
      } catch (_) { /* 次鍵失敗不影響主鍵，fallback false */ }

      return { records: rec, players, onboarded };
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
      const legacyRec = parse(legacyGet(K.rec), null);
      if (legacyRec !== null) {
        const players = parse(legacyGet(K.ply), DEFAULT_PLAYERS);
        // 舊 app 存的是 '1'(見原 finishOnboarding),新 app 存 'true'——兩者都當已完成引導,避免遷移用戶重看引導
        const legacyOnb = legacyGet(K.onb);
        const onboarded = legacyOnb === 'true' || legacyOnb === '1';
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
      // 1.2.2-A1：舊版三個 prefSet 直接 await 且無 try/catch。呼叫端是 fire-and-forget，
      // 任何一個失敗（裝置空間不足、plist 損毀）都只會產生一個沒人接的 unhandled rejection：
      // UI 上紀錄已新增、磁碟卻沒寫進去，使用者下次開 app 才發現不見了，全程無任何提示。
      // 現在：每個欄位獨立 try/catch（主鍵失敗不阻止次鍵寫入），永不 reject，
      // 改以回傳值回報，讓呼叫端能顯示錯誤。
      const failed = [];
      try { await a.prefSet(K.rec, JSON.stringify(records)); } catch (_) { failed.push('records'); }
      try { await a.prefSet(K.ply, JSON.stringify(players)); } catch (_) { failed.push('players'); }
      try { await a.prefSet(K.onb, String(!!d.onboarded)); } catch (_) { failed.push('onboarded'); }

      // 主鍵寫不進去是最危險的情況：立刻把這份資料寫成檔案備份，
      // 讓資料至少存在於第二個物理位置，之後還能救回來。
      if (failed.includes('records')) {
        await writeBackup({ records: records, players: players });
      }

      return { ok: failed.length === 0, failed: failed };
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
    return { load, save, writeBackup, validateBackup, newId, _K: K };
  }

  function browserAdapter() {
    const P = () => window.Capacitor?.Plugins?.Preferences;
    const F = () => window.Capacitor?.Plugins?.Filesystem;
    const DIR = 'DOCUMENTS';
    const hasCap = () => !!(window.Capacitor?.isNativePlatform?.() && P() && F());
    return {
      async prefGet(k) { return hasCap() ? (await P().get({ key: k })).value : localStorage.getItem(k); },
      async prefSet(k, v) { hasCap() ? await P().set({ key: k, value: v }) : localStorage.setItem(k, v); },
      legacyGet(k) { return localStorage.getItem(k); },
      async fileWrite(n, d) { if (F()) await F().writeFile({ path: n, data: d, directory: DIR, encoding: 'utf8' }); },
      async fileRead(n) { try { return F() ? (await F().readFile({ path: n, directory: DIR, encoding: 'utf8' })).data : null; } catch { return null; } },
      async fileList() { try { return F() ? (await F().readdir({ path: '', directory: DIR })).files.map(f => f.name ?? f) : []; } catch { return []; } },
      async fileDelete(n) { try { if (F()) await F().deleteFile({ path: n, directory: DIR }); } catch {} },
      today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
      now() { return new Date().toISOString(); },
    };
  }

  const api = { createStorage, browserAdapter };
  if (typeof window !== 'undefined') window.mahjongStore = createStorage(browserAdapter());
  return api;
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1', exp: 'mahjong_last_export', hwm: 'mahjong_high_water' };
  // R7：以參考回傳，呼叫端一次 players.push() 就污染整個模組的預設值，
  // 連之後新建的 createStorage 實例都會拿到被改過的預設牌友。
  const DEFAULT_PLAYERS = Object.freeze(['阿明', '小華', '大強', '林小姐']);
  const defaultPlayers = () => DEFAULT_PLAYERS.slice();

  const BACKUP_LATEST = 'backup_latest.json';
  const PRE_MIGRATION = 'pre_migration_backup.json';
  const SNAPSHOT_RE = /^backup_\d{4}-\d{2}-\d{2}\.json$/;
  const KEEP_SNAPSHOTS = 7;
  // S1：每日快照是按「寫入日」輪替的，擋不住時間。使用者某天誤刪一半紀錄卻沒發現，
  // 之後每天正常使用，7 天後所有快照都是刪過的版本，backup_latest 也早被覆蓋。
  // 保險檔只在偵測到破壞性變更時寫，不參與 7 天輪替，讓「過很久才發現」還有得救。
  const SAFETY_RE = /^safety_[0-9T-]+\.json$/;
  const KEEP_SAFETY = 5;

  function createStorage(a) {
    const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

    // T1：原生 Preferences/Filesystem bridge 在 App 被背景化時可能「掛住」——不 reject、
    // 只是永遠不回應。舊版所有防護都只擋 throw，擋不住 never-settle：一旦某次寫入卡住，
    // 後面每一筆 save 都排在同一條 chain 後面永遠不執行，而且連回報失敗的 .then 也卡在鏈上，
    // 紅色警告列永遠不會亮。使用者看到一個完全正常的 App，資料其實只活在記憶體裡。
    const WRITE_TIMEOUT_MS = (a && a.writeTimeoutMs) || 8000;
    const LOAD_TIMEOUT_MS = (a && a.loadTimeoutMs) || 10000;

    function withTimeout(promise, ms, onTimeout) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { resolve(onTimeout()); } catch (e) { reject(e); }
        }, ms);
        Promise.resolve(promise).then(
          (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
          (e) => { if (!settled) { settled = true; clearTimeout(timer); try { resolve(onTimeout(e)); } catch (e2) { reject(e2); } } }
        );
      });
    }

    // R2：持久層讀回來的東西和使用者匯入的檔案一樣不可信——它同樣可能被外力破壞
    // （這正是這次改版的前提）。舊版只判斷 !== null，於是任何合法 JSON（物件、數字、字串）
    // 都會被當成 records 寫進 pref；之後 readPref 永遠回非 null，救援路徑再也不會觸發，
    // 每次開 app 都在 render 期拋錯白屏，且無法自癒。型別不對一律當「這個來源沒資料」。
    const asRecords = (v) => (Array.isArray(v) ? v : null);
    const asPlayers = (v) => (Array.isArray(v) ? v.filter(p => typeof p === 'string') : null);

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
    // lenient：救援專用的寬鬆模式。使用者手動匯入時「一筆不合法就整份拒絕」是對的
    // （他可以換一個檔案）；但自動救援是最後手段，為了一筆壞紀錄放棄整份備份等於
    // 把能救的 99% 也一起丟掉。寬鬆模式跳過壞紀錄、保留其餘，並回報跳過幾筆。
    function validateBackup(obj, opts) {
      const lenient = !!(opts && opts.lenient);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '這個檔案不是麻將戰績的備份檔。' };
      if (!Array.isArray(obj.records)) return { ok: false, error: '備份檔裡找不到紀錄資料。' };

      const seen = new Set();
      const records = [];
      let skipped = 0;
      for (let i = 0; i < obj.records.length; i++) {
        const r = obj.records[i];
        const at = '第 ' + (i + 1) + ' 筆紀錄';
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          if (lenient) { skipped++; continue; }
          return { ok: false, error: at + '格式無法辨識。' };
        }

        const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          if (lenient) { skipped++; continue; }
          return { ok: false, error: at + '的金額無效。' };
        }

        const t = r.date == null ? NaN : new Date(r.date).getTime();
        if (!Number.isFinite(t)) {
          if (lenient) { skipped++; continue; }
          return { ok: false, error: at + '的日期無效。' };
        }

        if (r.type !== 'win' && r.type !== 'loss') {
          if (lenient) { skipped++; continue; }
          return { ok: false, error: at + '的輸贏欄位無效。' };
        }

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

      return { ok: true, records: records, players: players, skipped: skipped };
    }

    async function readPref() {
      // Critical#2：任何讀取例外（原生 Preferences API 拋錯、JSON 損毀等）都視為「這個來源沒資料」，
      // 絕不讓例外往外拋，否則 load() 會整個 reject，等於用戶開 app 直接白屏兼資料遺失。
      //
      // Critical（欄位隔離）：records（主鍵）與 players/onboarded（次要欄位）必須各自獨立判斷失敗，
      // 不可綁在同一個 try/catch。理由：若三者共用一個 try/catch，次要欄位偶發讀取失敗
      // （例如 prefGet(K.ply) 拋錯）會讓整個函式回 null，被 load()/save() 誤判成「pref 完全沒資料」，
      // 進而觸發救援或用舊快照覆寫「明明是好的」records 並持久化——等於主鍵資料因次鍵故障而遺失/回退。
      // 因此：只有 records 讀取失敗或型別不對，才代表主資料不可信、readPref 回 null。
      // players/onboarded 各自獨立 try/catch，任何失敗都只 fallback 到預設值，絕不影響主鍵判斷。
      let rec;
      try {
        rec = asRecords(parse(await a.prefGet(K.rec), null));
      } catch (_) {
        return null;
      }
      if (rec === null) return null;

      let players = defaultPlayers();
      try {
        const p = asPlayers(parse(await a.prefGet(K.ply), null));
        if (p) players = p;
      } catch (_) { /* 次鍵失敗不影響主鍵，fallback 預設值 */ }

      let onboarded = false;
      try {
        onboarded = (await a.prefGet(K.onb)) === 'true';
      } catch (_) { /* 次鍵失敗不影響主鍵，fallback false */ }

      let lastExportAt = null;
      try {
        const v = await a.prefGet(K.exp);
        if (typeof v === 'string' && v) lastExportAt = v;
      } catch (_) { /* 次鍵失敗不影響主鍵 */ }

      return { records: rec, players, onboarded, lastExportAt };
    }

    // T2：load() 同樣可能 never-settle（prefGet 掛住），症狀是 setLoading(false) 永遠不執行，
    // 使用者卡在「載入中…」無限轉圈，連 RescueScreen 這個唯一的「把資料匯出去」出口都進不了。
    // 這裡刻意讓逾時 reject —— 呼叫端的 catch 會設 loadError，那條路徑會進救援畫面，
    // 而且存檔 effect 的 loadError 守衛會擋住「用空狀態覆蓋」。回傳空狀態反而危險。
    function load() {
      return withTimeout(loadInner(), LOAD_TIMEOUT_MS, () => {
        throw new Error('讀取儲存逾時，請重開 App 再試一次。');
      });
    }

    async function loadInner() {
      // 1) pref 真的有資料（含合法空陣列 []）才直接採用。
      //    不再信任 migrated 旗標：舊邏輯是「migrated=true 就直接回傳」，一旦 pref 被清空/損毀
      //    （readPref 回 null），會誤判成「已遷移=沒事」而回傳空狀態，跳過後面救援、造成資料遺失。
      const pref = await readPref();
      if (pref) return { ...pref, source: 'pref' };

      // 2) pref 沒資料 → 看 legacy localStorage（即使先前已標記 migrated，也重跑一次冪等遷移救援）
      const legacyRec = asRecords(parse(legacyGet(K.rec), null));
      if (legacyRec !== null) {
        const players = asPlayers(parse(legacyGet(K.ply), null)) || defaultPlayers();
        // 舊 app 存的是 '1'(見原 finishOnboarding),新 app 存 'true'——兩者都當已完成引導,避免遷移用戶重看引導
        const legacyOnb = legacyGet(K.onb);
        const onboarded = legacyOnb === 'true' || legacyOnb === '1';

        // 防線#1：遷移前先備份原始 localStorage。
        // R5：遷移失敗會在下次啟動重跑，舊版每跑一次就覆寫一次——等於這份「最初狀態」
        // 會被後續失敗的遷移結果蓋掉。只在不存在時寫，並且寫失敗不阻擋遷移本身。
        try {
          let existing = null;
          try { existing = await a.fileRead(PRE_MIGRATION); } catch (_) {}
          if (!existing) {
            await a.fileWrite(PRE_MIGRATION, backupPayload({ records: legacyRec, players }));
          }
        } catch (_) { /* 備份失敗不阻擋遷移 */ }

        try {
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

        // 防線#3/#6：驗證/寫入失敗 → 不標記，回退用 legacy（資料不消失）。
        // R6：舊版在這裡回報 source:'pref'，等於主動抹掉「這次遷移沒成功、資料目前只在
        // localStorage 裡、下次系統清資料就真的沒了」這個關鍵訊號。誠實回報，讓 UI 能提示使用者匯出。
        return { records: legacyRec, players, onboarded, source: 'legacy-fallback' };
      }

      // 3) 反向救援
      return await recover();
    }

    // R1：舊版只讀 backup_latest.json，辛苦輪替的 7 份每日快照和遷移前備份
    // 全 repo 零處讀取——單一檔案損毀就讓所有備份形同虛設。
    // 依序：最新備份 → 每日快照（新到舊）→ 遷移前原始備份。
    async function recoveryCandidates() {
      const names = [BACKUP_LATEST];
      try {
        const all = await a.fileList();
        const snaps = all.filter(n => SNAPSHOT_RE.test(n)).sort().reverse();
        for (const n of snaps) if (names.indexOf(n) === -1) names.push(n);
        const safeties = all.filter(n => SAFETY_RE.test(n)).sort().reverse();
        for (const n of safeties) if (names.indexOf(n) === -1) names.push(n);
      } catch (_) {}
      if (names.indexOf(PRE_MIGRATION) === -1) names.push(PRE_MIGRATION);
      return names;
    }

    async function recover() {
      // R13：舊版把 backup_latest 硬編成第一優先，只要它能讀就採用。但 writeBackup 是
      // 「先寫當日快照、最後寫 latest」，App 在兩次寫入之間被系統收掉時，latest 會是舊的那份。
      // 於是救援可能挑到 3 筆的 latest，而旁邊躺著 240 筆的快照——而且採用後立刻寫回 pref，
      // 連 save() 的大幅刪除防護都失去比對基準（它比對的是已被污染的 pref）。
      // 現在：讀完所有候選，挑 exportedAt 最新的；筆數更多的另一份會回報給 UI 提示使用者。
      //
      // R14：驗證也跟手動還原對齊。舊版只做 Array.isArray，一份含 null 或壞欄位的備份會被
      // 寫進 pref，之後每次開 App 都在 render 期拋錯進 RescueScreen，且無法自癒。
      const candidates = [];
      let sawFile = false;
      for (const name of await recoveryCandidates()) {
        let raw = null;
        try { raw = await a.fileRead(name); } catch (_) { continue; }
        if (!raw) continue;
        sawFile = true;

        const b = parse(raw, null);
        if (!b || typeof b !== 'object') continue;              // 截斷或損毀
        if (typeof b.count === 'number' && Array.isArray(b.records) && b.count !== b.records.length) continue;

        const v = validateBackup(b, { lenient: true });          // 與 readBackup 同一條信任邊界，但不因單筆壞資料放棄整份
        if (!v.ok || !v.records.length) continue;

        candidates.push({
          name: name,
          records: v.records,
          players: v.players.length ? v.players : defaultPlayers(),
          skipped: v.skipped || 0,
          exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
        });
      }

      if (candidates.length) {
        // 最新優先；時間相同或缺時間時，筆數多的優先
        candidates.sort((x, y) => (
          String(y.exportedAt).localeCompare(String(x.exportedAt)) ||
          (y.records.length - x.records.length)
        ));
        const best = candidates[0];
        const largest = candidates.reduce((m, c) => Math.max(m, c.records.length), 0);

        let persisted = true;
        try {
          await a.prefSet(K.rec, JSON.stringify(best.records));
          await a.prefSet(K.ply, JSON.stringify(best.players));
          await a.prefSet(K.onb, 'true');
        } catch (_) { persisted = false; }

        return {
          records: best.records, players: best.players, onboarded: true,
          source: 'recovered', recoveredFrom: best.name, persisted: persisted,
          // 挑到的不是筆數最多的那份時要讓使用者知道，否則他會以為資料已經全回來了
          hasLargerBackup: best.records.length < largest,
          largestCount: largest,
          skippedRecords: best.skipped,   // 這份備份裡有幾筆壞掉、救不回來
        };
      }

      // 4) 真的全空 → 全新用戶。
      // R4：但「備份檔存在、卻一份都讀不出來」是強烈的異常訊號，不能默默當成新用戶——
      // 使用者看到一個乾淨的空 app 會以為資料沒了而開始亂操作。回報 suspicious 讓 UI 示警。
      return { records: [], players: defaultPlayers(), onboarded: false, source: 'empty', suspicious: sawFile };
    }

    // R8：多個 save() 同時在飛時，三個 prefSet 會彼此交錯——實測會落地成
    // 「records 是先發的舊值、players 是後發的新值」這種撕裂狀態（使用者刪一筆再新增一筆，
    // 可能持久化成刪除前的樣子）。所有寫入排進同一條 chain，保證後發的那份完整覆蓋先發的。
    let writeChain = Promise.resolve();
    function serialize(fn) {
      // 逾時後放行讓鏈繼續走（卡住的那個 promise 留在背景自生自滅），
      // 並把 timedOut 如實回報上去，UI 才有機會告訴使用者「這筆沒寫進去」。
      const guarded = () => withTimeout(
        Promise.resolve().then(fn), WRITE_TIMEOUT_MS,
        () => ({ ok: false, failed: ['timeout'], timedOut: true, backupOk: false })
      );
      const run = writeChain.then(guarded, guarded);
      writeChain = run.then(() => {}, () => {});
      return run;
    }

    function backupPayload(d) {
      const records = asRecords(d && d.records) || [];
      const players = asPlayers(d && d.players) || defaultPlayers();
      return JSON.stringify({ version: 1, exportedAt: a.now(), count: records.length, records, players });
    }

    async function writeBackupInner(d, opts) {
      const allowEmpty = !!(opts && opts.allowEmpty);
      const records = asRecords(d && d.records) || [];

      // R9：save() 有空覆蓋防線，但 writeBackup 是 public API，被 UI 的 1500ms debounce 與
      // pagehide flush 直接呼叫，完全繞過那道防線。載入失敗時 UI 會帶著初始空狀態打進來，
      // 把唯一的救援檔清成 []。清空備份必須是明確的動作（allowEmpty），不能由背景 effect 代勞。
      if (!records.length && !allowEmpty) {
        // T10：舊版只看 backup_latest。它一旦損毀，parse 回 null 就被當成「沒有現存備份」放行，
        // 於是空狀態把當日那份好好的快照也就地覆寫掉。改成兩份都看，而且「存在但讀不出來」
        // 要保守拒絕——讀不出來不代表沒價值，可能只是這一次讀失敗。
        for (const name of [BACKUP_LATEST, 'backup_' + a.today() + '.json']) {
          try {
            const raw = await a.fileRead(name);
            if (!raw) continue;
            const existing = parse(raw, null);
            if (!existing) return { ok: false, skipped: 'existing-unreadable' };
            if (Array.isArray(existing.records) && existing.records.length) {
              return { ok: false, skipped: 'would-empty-backup' };
            }
          } catch (_) { /* 這個檔讀不到就看下一個 */ }
        }
      }

      // R10：stringify 原本在 try 之外，records 若含循環參照會讓 save() 直接 reject，
      // 違反它自己「永不 reject」的契約。
      let payload;
      try { payload = backupPayload({ records, players: d && d.players }); }
      catch (_) { return { ok: false, skipped: 'unserializable' }; }

      try {
        // R11：先寫當日快照、最後才寫 backup_latest，讓 latest 成為 commit point。
        // fileWrite 是就地覆寫，寫到一半被系統收掉（背景切換時很常見）就是一個截斷的半檔——
        // 舊版的順序是先毀掉最重要的那份。
        const todayName = 'backup_' + a.today() + '.json';
        await a.fileWrite(todayName, payload);
        await a.fileWrite(BACKUP_LATEST, payload);
        // 輪替：只保留最近 7 份帶日期快照。
        // T8：排除本次剛寫的那份——使用者把手機時間往回調時(換時區/手動校時/系統時間未同步)，
        // 新檔名會排到字典序最前面，變成「最舊的」而被自己這一輪刪掉，卻還回報 ok:true。
        const snaps = (await a.fileList()).filter(n => SNAPSHOT_RE.test(n) && n !== todayName).sort();
        for (const old of snaps.slice(0, Math.max(0, snaps.length - (KEEP_SNAPSHOTS - 1)))) {
          // Minor#6：單一檔案刪除失敗不該中斷整輪輪替，否則其餘該砍的舊快照會一直留著
          try { await a.fileDelete(old); } catch (_) {}
        }
        return { ok: true };
      } catch (_) {
        return { ok: false, skipped: 'write-failed' };
      }
    }

    function safetyName() {
      return 'safety_' + String(a.now()).replace(/[:.]/g, '').replace('Z', '') + '.json';
    }

    async function writeSafetySnapshot(d) {
      const records = asRecords(d && d.records) || [];
      if (!records.length) return { ok: false, skipped: 'empty' };   // 空的沒有保存價值
      let payload;
      try { payload = backupPayload({ records, players: d && d.players }); }
      catch (_) { return { ok: false, skipped: 'unserializable' }; }

      // T7：還原一次會同時從兩條路徑各寫一份內容相同的保險檔，兩份各佔一個名額。
      // 連做兩次還原就把歷史保險檔清光——剛好摧毀「不參與輪替」這個設計的唯一價值。
      let existing = [];
      try { existing = (await a.fileList()).filter(n => SAFETY_RE.test(n)).sort(); } catch (_) {}
      if (existing.length) {
        try {
          const last = parse(await a.fileRead(existing[existing.length - 1]), null);
          if (last && Array.isArray(last.records) && last.records.length === records.length
              && JSON.stringify(last.records) === JSON.stringify(records)) {
            return { ok: true, skipped: 'duplicate' };
          }
        } catch (_) { /* 讀不到就照常寫 */ }
      }

      const name = safetyName();
      try {
        await a.fileWrite(name, payload);
        // T8：同樣排除本次剛寫的那份
        const snaps = (await a.fileList()).filter(n => SAFETY_RE.test(n) && n !== name).sort();
        for (const old of snaps.slice(0, Math.max(0, snaps.length - (KEEP_SAFETY - 1)))) {
          try { await a.fileDelete(old); } catch (_) {}
        }
        return { ok: true, name: name };
      } catch (_) { return { ok: false, skipped: 'write-failed' }; }
    }

    // 逐筆刪除時 pref 裡的「現況」已經所剩無幾，把它存成保險檔沒有意義。
    // 真正該保住的是備份裡筆數最多的那一份。
    async function largestBackup() {
      let best = null;
      for (const name of await recoveryCandidates()) {
        try {
          const raw = await a.fileRead(name);
          if (!raw) continue;
          const b = parse(raw, null);
          if (!b || typeof b !== 'object') continue;
          const v = validateBackup(b, { lenient: true });
          if (!v.ok || !v.records.length) continue;
          if (!best || v.records.length > best.records.length) {
            best = { records: v.records, players: v.players.length ? v.players : defaultPlayers() };
          }
        } catch (_) {}
      }
      return best;
    }

    // S2：自動救援只在主儲存整個讀不出來時觸發。誤刪的情境下主儲存是好的（只是資料少了），
    // 自動救援永遠不會跑——所以備份必須有一個使用者拿得到的出口，否則保險檔等於不存在。
    async function listBackups() {
      let names = [];
      try { names = await a.fileList(); } catch (_) { return []; }
      const out = [];
      for (const name of names) {
        const isKnown = name === BACKUP_LATEST || name === PRE_MIGRATION || SNAPSHOT_RE.test(name) || SAFETY_RE.test(name);
        if (!isKnown) continue;
        let raw = null;
        try { raw = await a.fileRead(name); } catch (_) { continue; }
        const b = parse(raw, null);
        if (!b || typeof b !== 'object') continue;
        const records = asRecords(b.records);
        if (!records || !records.length) continue;   // 0 筆的備份不該出現在還原清單
        out.push({
          name: name,
          count: records.length,
          exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : null,
          kind: name === BACKUP_LATEST ? 'latest'
              : name === PRE_MIGRATION ? 'pre-migration'
              : SAFETY_RE.test(name) ? 'safety' : 'daily',
        });
      }
      out.sort((x, y) => String(y.exportedAt || '').localeCompare(String(x.exportedAt || '')));
      return out;
    }

    async function readBackup(name) {
      let raw = null;
      try { raw = await a.fileRead(name); } catch (_) { return { ok: false, error: '讀不到這份備份。' }; }
      if (!raw) return { ok: false, error: '這份備份已經不存在。' };
      const b = parse(raw, null);
      if (!b) return { ok: false, error: '這份備份已損毀，無法讀取。' };
      return validateBackup(b);   // 走和使用者匯入同一條信任邊界
    }

    async function saveInner(d) {
      const records = asRecords(d.records) || [];
      const players = asPlayers(d.players) || defaultPlayers();

      // Important#4：belt-and-suspenders —— 若這次要寫入空陣列、但 pref 目前存有非空資料，
      // 視為可疑覆蓋，先確保目前資料備份一份再寫，避免無法復原。不做任何攔截/拒絕。
      // R12：舊版只擋「歸零」。200 筆變成 1 筆（某個 filter 寫錯、state 被局部覆蓋）在實務上
      // 比全空更常見也更難察覺，同樣納入保險範圍。
      try {
        const current = await readPref();
        const before = current && Array.isArray(current.records) ? current.records.length : 0;
        const now = records.length;

        // T6：舊版只比對「這一次」的落差，對逐筆刪除完全無效——一筆一筆刪掉 200 筆，
        // 每次只差 1 筆都不觸發，等到 1→0 才寫出一份「1 筆」的保險檔。
        // 高水位記錄使用者曾經有過的最大筆數，累積縮水到七成就示警並保住最完整的那份備份。
        let hwm = 0;
        try { hwm = parseInt(await a.prefGet(K.hwm), 10) || 0; } catch (_) {}
        if (now > hwm) {
          hwm = now;
          try { await a.prefSet(K.hwm, String(now)); } catch (_) {}
        }

        const bigDrop = before > 0 && (now === 0 || now * 2 < before);
        const belowWaterMark = hwm > 0 && now < Math.ceil(hwm * 0.7);
        if (bigDrop || belowWaterMark) {
          if (before > 0) await writeBackupInner(current);
          // 存備份裡最完整的那份，而不是已經被刪到剩沒幾筆的現況
          const src = await largestBackup();
          const keep = (src && src.records.length > now) ? src : (before > now ? current : null);
          if (keep) await writeSafetySnapshot(keep);
          // 重設高水位，否則之後每一次 save 都會重複觸發
          try { await a.prefSet(K.hwm, String(now)); } catch (_) {}
        }
      } catch (_) { /* 備份失敗不阻擋寫入 */ }

      // 1.2.2-A1：每個欄位獨立 try/catch（主鍵失敗不阻止次鍵寫入），永不 reject，
      // 改以回傳值回報，讓呼叫端能顯示錯誤。
      const failed = [];
      try { await a.prefSet(K.rec, JSON.stringify(records)); } catch (_) { failed.push('records'); }
      try { await a.prefSet(K.ply, JSON.stringify(players)); } catch (_) { failed.push('players'); }
      try { await a.prefSet(K.onb, String(!!d.onboarded)); } catch (_) { failed.push('onboarded'); }

      // 主鍵寫不進去是最危險的情況：立刻把這份資料寫成檔案備份，
      // 讓資料至少存在於第二個物理位置，之後還能救回來。
      // R10：呼叫端必須能區分「pref 寫失敗但緊急備份成功（資料還在）」與
      // 「兩邊都失敗（資料只在記憶體，關 app 就沒了）」——這兩者該顯示的訊息完全不同。
      let backupOk = null;
      if (failed.indexOf('records') !== -1) {
        try { backupOk = (await writeBackupInner({ records, players })).ok; }
        catch (_) { backupOk = false; }
      }

      return { ok: failed.length === 0, failed: failed, backupOk: backupOk };
    }

    function save(d) { return serialize(() => saveInner(d)); }
    function writeBackup(d, opts) { return serialize(() => writeBackupInner(d, opts)); }

    // snapshot：還原/匯入這類會整批取代現有資料的動作，動手前先留一份保險檔。
    // 不能用 writeBackup，那會覆蓋 backup_latest；保險檔要的就是「不被後續寫入蓋掉」。
    function snapshot(d) { return serialize(() => writeSafetySnapshot(d)); }

    // 備份檔會被使用者存進「檔案」App 或傳給自己。打開看到的若是一堆 "type":"win"、
    // "amount":500 這種英文欄位，一般人不會知道這是什麼、能不能刪——而一份不被信任的備份
    // 等於沒有備份。這幾個中文欄位放在檔案最前面，讓第一眼就是人話，並且讓使用者能拿
    // 筆數與總結算跟 App 裡的數字對照，確認這份備份是完整的。
    // validateBackup 只讀 records/players，多這幾個欄位不影響匯入，新舊版本互相都讀得到。
    function backupSummary(records) {
      const list = asRecords(records) || [];
      const balance = list.reduce((sum, r) => {
        const amt = Number(r && r.amount);
        if (!Number.isFinite(amt)) return sum;
        return sum + (r && r.type === 'win' ? amt : -amt);
      }, 0);
      const d = new Date(a.now());
      const p2 = (n) => String(n).padStart(2, '0');
      const when = Number.isFinite(d.getTime())
        ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
        : '';
      return {
        '說明': '這是「麻將戰績」App 的備份檔。要還原資料，請打開 App → 牌友 → 匯入備份 → 選擇這個檔案。請不要手動修改內容。',
        '匯出時間': when,
        '紀錄筆數': list.length,
        '總結算': `${balance >= 0 ? '+' : '−'}${Math.abs(balance).toLocaleString()} 元`,
      };
    }

    // 手動匯出是唯一能讓資料離開這支手機的一層。記下時間，讓使用者看得到自己多久沒備份。
    async function markExported() {
      const at = a.now();
      try { await a.prefSet(K.exp, at); return { ok: true, at: at }; }
      catch (_) { return { ok: false, at: at }; }
    }

    return { load, save, writeBackup, snapshot, markExported, validateBackup, listBackups, readBackup, backupSummary, newId, _K: K };
  }

  function browserAdapter() {
    const P = () => window.Capacitor?.Plugins?.Preferences;
    const F = () => window.Capacitor?.Plugins?.Filesystem;
    // 備份寫在 DOCUMENTS 時，只要 Info.plist 有 UIFileSharingEnabled +
    // LSSupportsOpeningDocumentsInPlace，「檔案」App 的「我的 iPhone」就會出現一個
    // 「麻將戰績」資料夾，使用者看到十幾個看不懂的 json 很可能整包刪掉——正好把
    // 多層備份的意義抵銷掉。改寫到 LIBRARY：一樣會進 iCloud 備份（換機還原不受影響），
    // 但不對使用者曝露。舊版寫在 DOCUMENTS 的備份維持可讀，不做搬移，避免遷移風險。
    const DIR = 'LIBRARY';
    const LEGACY_DIR = 'DOCUMENTS';
    const DIRS = [DIR, LEGACY_DIR];
    const hasCap = () => !!(window.Capacitor?.isNativePlatform?.() && P() && F());
    return {
      async prefGet(k) { return hasCap() ? (await P().get({ key: k })).value : localStorage.getItem(k); },
      async prefSet(k, v) { hasCap() ? await P().set({ key: k, value: v }) : localStorage.setItem(k, v); },
      legacyGet(k) { return localStorage.getItem(k); },
      // T3：舊版沒有 Filesystem 時直接 resolve，於是 writeBackup/snapshot 一路回報 ok:true，
      // 連 save() 在 pref 全寫失敗時都會回 backupOk:true（語意是「資料已在第二個物理位置」），
      // 實際上一個 byte 都沒寫。網頁版就是這個情況——整套多層備份完全沒運作卻回報正常。
      async fileWrite(n, d) {
        const fs = F();
        if (!fs) throw new Error('filesystem-unavailable');
        await fs.writeFile({ path: n, data: d, directory: DIR, encoding: 'utf8' });
      },
      async fileRead(n) {
        if (!F()) return null;
        for (const dir of DIRS) {   // 新位置優先，讀不到才回頭找舊版寫的那份
          try { return (await F().readFile({ path: n, directory: dir, encoding: 'utf8' })).data; } catch (_) {}
        }
        return null;
      },
      async fileList() {
        if (!F()) return [];
        const names = new Set();
        for (const dir of DIRS) {
          try { for (const f of (await F().readdir({ path: '', directory: dir })).files) names.add(f.name ?? f); } catch (_) {}
        }
        return [...names];
      },
      async fileDelete(n) {
        if (!F()) return;
        for (const dir of DIRS) { try { await F().deleteFile({ path: n, directory: dir }); } catch (_) {} }
      },
      today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
      now() { return new Date().toISOString(); },
    };
  }

  const api = { createStorage, browserAdapter };
  if (typeof window !== 'undefined') window.mahjongStore = createStorage(browserAdapter());
  return api;
});

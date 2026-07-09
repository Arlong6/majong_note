import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStorage } = require('./storage.js');

// 記憶體 fake adapter，模擬 Preferences / Filesystem / localStorage
export function makeAdapter(seed = {}) {
  const pref = new Map(Object.entries(seed.pref || {}));
  const files = new Map(Object.entries(seed.files || {}));
  const legacy = new Map(Object.entries(seed.legacy || {}));
  return {
    _pref: pref, _files: files, _legacy: legacy,
    failPrefSetOn: seed.failPrefSetOn || null,
    async prefGet(k) { return pref.has(k) ? pref.get(k) : null; },
    async prefSet(k, v) { if (this.failPrefSetOn === k) throw new Error('simulated pref fail'); pref.set(k, v); },
    legacyGet(k) { return legacy.has(k) ? legacy.get(k) : null; },
    async fileWrite(n, d) { files.set(n, d); },
    async fileRead(n) { return files.has(n) ? files.get(n) : null; },
    async fileList() { return [...files.keys()]; },
    async fileDelete(n) { files.delete(n); },
    today() { return seed.today || '2026-07-07'; },
    now() { return (seed.today || '2026-07-07') + 'T00:00:00Z'; },
  };
}

test('createStorage 回傳 load/save/writeBackup', () => {
  const s = createStorage(makeAdapter());
  assert.equal(typeof s.load, 'function');
  assert.equal(typeof s.save, 'function');
  assert.equal(typeof s.writeBackup, 'function');
});

const K = createStorage(makeAdapter())._K;
const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];
const R = [{ id: 1, amount: 100 }, { id: 2, amount: -50 }];

test('全新用戶：空 → 回預設空狀態，不報錯', async () => {
  const s = createStorage(makeAdapter());
  const d = await s.load();
  assert.deepEqual(d.records, []);
  assert.deepEqual(d.players, DEFAULT_PLAYERS);
  assert.equal(d.source, 'empty');
});

test('已遷移用戶：讀 Preferences', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A']), [K.mig]: 'true' } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.source, 'pref');
});

test('遷移：localStorage 有資料 → 複製進 Preferences + 回讀驗證 + 標記', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A', 'B']), [K.onb]: 'true' } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.source, 'migrated');
  assert.equal(await a.prefGet(K.mig), 'true');                 // 已標記
  assert.equal(await a.prefGet(K.rec), JSON.stringify(R));      // 已寫進 pref
  assert.equal(a._files.has('pre_migration_backup.json'), true); // 防線#1 遷移前備份
});

test('遷移冪等：已標記 migrated 不再讀 localStorage、不覆蓋', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R), [K.mig]: 'true' }, legacy: { [K.rec]: JSON.stringify([{ id: 9 }]) } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);                              // 用 pref 不用 legacy
});

test('遷移不覆蓋非空 Preferences', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R) }, legacy: { [K.rec]: JSON.stringify([{ id: 9 }]) } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
});

test('遷移失敗（prefSet 爆）→ 不標記、回退 localStorage、資料不消失', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R) }, failPrefSetOn: K.rec });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);                              // 仍拿得到資料
  assert.equal(await a.prefGet(K.mig), null);                  // 未標記 → 下次重試
});

test('反向救援：pref+legacy 皆空但備份有 → 用備份還原', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': JSON.stringify({ version: 1, records: R, players: ['A'] }) } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.source, 'recovered');
});

test('防線#4：遷移後 localStorage 來源仍在（永不刪）', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R) } });
  await createStorage(a).load();
  assert.equal(a._legacy.get(K.rec), JSON.stringify(R));   // 來源未被刪
});

test('不變量：遷移失敗後三處不同時全空（至少 legacy 有）', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R) }, failPrefSetOn: K.rec });
  const d = await createStorage(a).load();
  const legacyHas = a._legacy.get(K.rec) !== undefined;
  const memHas = d.records.length > 0;
  assert.ok(legacyHas && memHas);   // 記憶體有值 + 來源仍在 → 未全空
});

test('save 寫進 Preferences', async () => {
  const a = makeAdapter();
  await createStorage(a).save({ records: R, players: ['A'], onboarded: true });
  assert.equal(await a.prefGet(K.rec), JSON.stringify(R));
  assert.equal(await a.prefGet(K.onb), 'true');
});

test('writeBackup 產生 latest + 當日快照', async () => {
  const a = makeAdapter({ today: '2026-07-07' });
  await createStorage(a).writeBackup({ records: R, players: ['A'] });
  assert.equal(a._files.has('backup_latest.json'), true);
  assert.equal(a._files.has('backup_2026-07-07.json'), true);
  const snap = JSON.parse(a._files.get('backup_2026-07-07.json'));
  assert.deepEqual(snap.records, R);
});

test('每日快照只保留最近 7 份', async () => {
  const files = {};
  for (const d of ['2026-06-28','2026-06-29','2026-06-30','2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05'])
    files['backup_' + d + '.json'] = '{}';
  const a = makeAdapter({ today: '2026-07-07', files });
  await createStorage(a).writeBackup({ records: R, players: [] });
  const snaps = [...a._files.keys()].filter(n => /^backup_\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  assert.equal(snaps.length, 7);                      // 8 舊 + 今日 = 9 → 砍到 7
  assert.equal(snaps.includes('backup_2026-06-28.json'), false); // 最舊被砍
  assert.equal(snaps.includes('backup_2026-07-07.json'), true);  // 今日在
});

// ===== 回歸測試：資料安全修復 (fix/storage-migration) =====

test('[Critical#1] migrated=true 但 pref records 損毀、legacy 有資料 → load 回傳 legacy 資料（非空）', async () => {
  const a = makeAdapter({
    pref: { [K.mig]: 'true', [K.rec]: 'not-valid-json{' },
    legacy: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['X', 'Y']) },
  });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.ok(d.records.length > 0);
});

test('[Critical#1] migrated=true、pref 缺失、legacy 皆無，backup 有 → 回傳 backup 資料', async () => {
  const a = makeAdapter({
    pref: { [K.mig]: 'true' },
    files: { 'backup_latest.json': JSON.stringify({ version: 1, records: R, players: ['Z'] }) },
  });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.source, 'recovered');
});

test('[Critical#1] 合法空：pref records="[]" → 回傳空、不觸發救援（不復活備份）', async () => {
  const a = makeAdapter({
    pref: { [K.rec]: '[]' },
    legacy: { [K.rec]: JSON.stringify(R) },
    files: { 'backup_latest.json': JSON.stringify({ version: 1, records: R, players: ['Z'] }) },
  });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, []);
  assert.equal(d.source, 'pref');
  assert.equal(await a.prefGet(K.rec), '[]'); // 沒被舊資料覆蓋回去
});

test('[Critical#2] prefGet 拋例外 → load 不 throw、走救援、回傳有資料', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A']) } });
  a.prefGet = async () => { throw new Error('simulated prefGet crash'); };
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.ok(d.records.length > 0);
});

test('[Important#3] 遷移時 players 寫入損毀 → 不標記 migrated', async () => {
  const players = ['A', 'B']; // 非預設值，才能與損毀後 fallback 到 DEFAULT_PLAYERS 的情況區分
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(players) } });
  const origSet = a.prefSet.bind(a);
  a.prefSet = async (k, v) => {
    if (k === K.ply) return origSet(k, 'corrupted-not-json{'); // 模擬寫入時損毀
    return origSet(k, v);
  };
  const d = await createStorage(a).load();
  assert.equal(await a.prefGet(K.mig), null);   // 未標記 migrated
  assert.deepEqual(d.records, R);               // 資料仍拿得到（回退 legacy）
  assert.deepEqual(d.players, players);         // 拿到的是正確 players，不是損毀後的 fallback 值
});

test('[Important#4] save 空覆蓋非空 pref → 覆蓋前 backup_latest 已存有原本非空資料', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A']) } });
  await createStorage(a).save({ records: [], players: [], onboarded: false });
  assert.equal(a._files.has('backup_latest.json'), true);
  const backup = JSON.parse(a._files.get('backup_latest.json'));
  assert.deepEqual(backup.records, R);                       // 備份的是「覆蓋前」的非空資料
  assert.equal(await a.prefGet(K.rec), JSON.stringify([]));  // 合法空寫入仍照常執行，不擋
});

test('[Minor#5] 反向救援後 onboarded 有被寫入 pref', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': JSON.stringify({ version: 1, records: R, players: ['A'] }) } });
  await createStorage(a).load();
  assert.equal(await a.prefGet(K.onb), 'true');
});

test('[Minor#6] 輪替刪除：單一 fileDelete 失敗不中斷其餘刪除', async () => {
  const files = {};
  for (const d of ['2026-06-28','2026-06-29','2026-06-30','2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05'])
    files['backup_' + d + '.json'] = '{}';
  const a = makeAdapter({ today: '2026-07-07', files });
  const origDelete = a.fileDelete.bind(a);
  a.fileDelete = async (n) => {
    if (n === 'backup_2026-06-28.json') throw new Error('simulated delete fail'); // 最舊的那份故意失敗
    return origDelete(n);
  };
  await createStorage(a).writeBackup({ records: R, players: [] });
  // 8 舊 + 今日 = 9 → 該砍到 7；即使最舊的那份刪除失敗，第二舊的仍應被刪除
  assert.equal(a._files.has('backup_2026-06-29.json'), false);
});

// ===== 回歸測試：readPref 欄位隔離 (新 Critical，fix/storage-migration) =====
// Bug: readPref() 把 records/players/onboarded 三個 prefGet 綁在同一個 try/catch。
// 次要欄位（players/onboarded）偶發讀取失敗會讓整個 readPref 回 null，
// load() 誤判成「pref 完全沒資料」而觸發救援，用舊快照覆寫良好的 records 並持久化。
// 修法：records 獨立判斷是否回 null；players/onboarded 各自 try/catch，失敗只 fallback，不影響主鍵判斷。

test('[Critical#新] records 有效但 prefGet(K.ply) 拋例外 → records 仍完整保留、players fallback、不觸發救援', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R) } });
  const origGet = a.prefGet.bind(a);
  a.prefGet = async (k) => {
    if (k === K.ply) throw new Error('simulated players read crash');
    return origGet(k);
  };
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);              // 主鍵沒丟
  assert.equal(d.source, 'pref');               // 沒有落到 migrated/recovered（代表沒觸發救援）
  assert.deepEqual(d.players, DEFAULT_PLAYERS); // 次鍵 fallback
  assert.equal(await a.prefGet(K.rec), JSON.stringify(R)); // pref 沒被覆寫
});

test('[Critical#新] records 有效但 prefGet(K.onb) 拋例外 → records 完整、onboarded=false、不遺失', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A']) } });
  const origGet = a.prefGet.bind(a);
  a.prefGet = async (k) => {
    if (k === K.onb) throw new Error('simulated onboarded read crash');
    return origGet(k);
  };
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.source, 'pref');
  assert.equal(d.onboarded, false);
  assert.equal(await a.prefGet(K.rec), JSON.stringify(R));
});

test('[Critical#新] save 空覆蓋檢查時即使 players 讀取 glitch，current 仍正確判為非空、備份防線正常運作', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['A']) } });
  const origGet = a.prefGet.bind(a);
  a.prefGet = async (k) => {
    if (k === K.ply) throw new Error('simulated players read crash');
    return origGet(k);
  };
  await createStorage(a).save({ records: [], players: [], onboarded: false });
  assert.equal(a._files.has('backup_latest.json'), true); // 備份防線沒被略過
  const backup = JSON.parse(a._files.get('backup_latest.json'));
  assert.deepEqual(backup.records, R);                    // 備份的是覆蓋前的非空 records
  assert.equal(await a.prefGet(K.rec), JSON.stringify([])); // 合法空寫入仍照常執行
});

test('[Critical#新] 回歸防護：records 本身損毀仍要回 null 走救援（不能被欄位隔離改壞）', async () => {
  const a = makeAdapter({
    pref: { [K.rec]: 'not-valid-json{', [K.ply]: JSON.stringify(['A']) },
    legacy: { [K.rec]: JSON.stringify(R), [K.ply]: JSON.stringify(['X', 'Y']) },
  });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);   // 走 legacy 救援
  assert.equal(d.source, 'migrated');
});

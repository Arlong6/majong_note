// 救援路徑與並行寫入測試。對應這一輪修掉的 R1–R12：
// 舊版的 41 個測試把「已經修過的 bug」守得很牢，但下面每一條當時都是活的破口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeAdapter } from './adapter.mjs';
const require = createRequire(import.meta.url);
const { createStorage } = require('../www/storage.js');

const K = createStorage(makeAdapter())._K;
const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];
// 真實紀錄的樣子：App 產生的每一筆都有 date/type/正數金額。
// 舊的簡化假資料（缺 date/type、金額是負的）測不到走驗證的救援路徑。
const R = [
  { id: 1, date: '2026-09-01T12:00:00.000Z', amount: 100, type: 'win', note: '', participants: [] },
  { id: 2, date: '2026-09-02T12:00:00.000Z', amount: 50, type: 'loss', note: '', participants: [] },
];
const backup = (records, extra = {}) => JSON.stringify({
  version: 1, exportedAt: '2026-07-07T00:00:00Z', count: records.length, records, players: ['A'], ...extra,
});

// ---------- R9：writeBackup 的空覆蓋防護 ----------

test('[R9] writeBackup 不得用空 records 蓋掉現有的非空備份', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': backup(R) } });
  const s = createStorage(a);
  const r = await s.writeBackup({ records: [], players: [] });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'would-empty-backup');
  assert.deepEqual(JSON.parse(a._files.get('backup_latest.json')).records, R);
});

test('[R9] 明確 allowEmpty 時才允許寫空備份', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': backup(R) } });
  const r = await createStorage(a).writeBackup({ records: [] }, { allowEmpty: true });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(a._files.get('backup_latest.json')).records, []);
});

test('[R9] 沒有現存備份時，寫空備份不受阻擋（全新用戶的正常路徑）', async () => {
  const a = makeAdapter();
  const r = await createStorage(a).writeBackup({ records: [] });
  assert.equal(r.ok, true);
});

// ---------- R1：多候選救援 ----------

test('[R1] backup_latest 截斷損毀 → 改用完好的每日快照', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': '{"version":1,"records":[{"id":1,',   // 寫到一半被系統收掉
    'backup_2026-07-05.json': backup([{ id: 9, date: '2026-09-05T12:00:00.000Z', amount: 5, type: 'win', note: '', participants: [] }]),
    'backup_2026-07-06.json': backup(R),
  } });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'recovered');
  assert.equal(d.recoveredFrom, 'backup_2026-07-06.json');       // 取最新那份
  assert.deepEqual(d.records, R);
});

test('[R1] 多份快照時取最新的一份', async () => {
  const a = makeAdapter({ files: {
    'backup_2026-07-01.json': backup([{ id: 'old', date: '2026-09-01T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
    'backup_2026-07-09.json': backup([{ id: 'new', date: '2026-09-09T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
    'backup_2026-07-04.json': backup([{ id: 'mid', date: '2026-09-04T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
  } });
  const d = await createStorage(a).load();
  assert.equal(d.recoveredFrom, 'backup_2026-07-09.json');
  assert.equal(d.records[0].id, 'new');
});

test('[R1/R5] 只剩遷移前備份時仍救得回來', async () => {
  const a = makeAdapter({ files: { 'pre_migration_backup.json': backup(R) } });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'recovered');
  assert.equal(d.recoveredFrom, 'pre_migration_backup.json');
  assert.deepEqual(d.records, R);
});

test('[R1] count 與實際筆數不符的備份視為不完整，跳到下一個候選', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': backup(R, { count: 99 }),
    'backup_2026-07-06.json': backup([{ id: 'good', date: '2026-09-06T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
  } });
  const d = await createStorage(a).load();
  assert.equal(d.recoveredFrom, 'backup_2026-07-06.json');
});

// ---------- R3：救援時持久化失敗仍須回傳資料 ----------

test('[R3] 救援途中 prefSet 失敗 → 仍回傳備份裡的資料，並標記 persisted:false', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': backup(R) }, failPrefSetOn: K.rec });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'recovered');
  assert.equal(d.persisted, false);
  assert.deepEqual(d.records, R);                                 // 舊版這裡回的是 []
});

// ---------- R2：型別驗證，不讓非陣列毒化 pref ----------

for (const [label, raw] of [['物件', '{"corrupt":true}'], ['數字', '5'], ['字串', '"str"']]) {
  test(`[R2] pref 的 records 是${label} → 視為損毀走救援，不得回傳非陣列`, async () => {
    const a = makeAdapter({
      pref: { [K.rec]: raw },
      files: { 'backup_latest.json': backup(R) },
    });
    const d = await createStorage(a).load();
    assert.ok(Array.isArray(d.records));
    assert.equal(d.source, 'recovered');
    assert.deepEqual(d.records, R);
  });
}

test('[R2] legacy 的 records 是非陣列 → 不得被遷移進 pref', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: '{"corrupt":true}' } });
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, []);
  assert.equal(d.source, 'empty');
  assert.equal(a._pref.has(K.rec), false);                        // 沒有毒化
});

// ---------- R5：遷移前備份只保存最初那份 ----------

test('[R5] 重跑遷移不得覆寫已存在的遷移前備份', async () => {
  const original = backup([{ id: 'original', amount: 1 }]);
  const a = makeAdapter({
    files: { 'pre_migration_backup.json': original },
    legacy: { [K.rec]: JSON.stringify(R) },
  });
  await createStorage(a).load();
  assert.equal(a._files.get('pre_migration_backup.json'), original);
});

// ---------- R6：遷移失敗誠實回報 ----------

test('[R6] 遷移回讀驗證失敗 → source 為 legacy-fallback 而非謊稱 pref', async () => {
  const a = makeAdapter({ legacy: { [K.rec]: JSON.stringify(R) }, failPrefSetOn: K.rec });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'legacy-fallback');
  assert.deepEqual(d.records, R);
});

// ---------- R4：備份存在卻全讀不出來 = 異常訊號 ----------

test('[R4] 有備份檔但全部損毀 → 回 empty 且標記 suspicious', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': '{broken' } });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'empty');
  assert.equal(d.suspicious, true);
});

test('[R4] 真正的全新用戶不得被標記 suspicious', async () => {
  const d = await createStorage(makeAdapter()).load();
  assert.equal(d.source, 'empty');
  assert.equal(d.suspicious, false);
});

// ---------- R8：並行寫入序列化 ----------

test('[R8] 並行 save() 不得撕裂，最終落地必須是後發那份的完整三欄位', async () => {
  const a = makeAdapter();
  // 人為讓每次 prefSet 都讓出一次 microtask，放大交錯的機會
  const origSet = a.prefSet.bind(a);
  a.prefSet = async (k, v) => { await new Promise(r => setTimeout(r, 1)); return origSet(k, v); };

  const s = createStorage(a);
  const pA = s.save({ records: [{ id: 'A' }], players: ['pa'], onboarded: true });
  const pB = s.save({ records: [{ id: 'B' }], players: ['pb'], onboarded: true });
  await Promise.all([pA, pB]);

  assert.deepEqual(JSON.parse(a._pref.get(K.rec)), [{ id: 'B' }]);
  assert.deepEqual(JSON.parse(a._pref.get(K.ply)), ['pb']);
});

// ---------- R10：save 永不 reject，且回報緊急備份成敗 ----------

test('[R10] records 不可序列化時 save() 不得 reject', async () => {
  const cyclic = [{ id: 1 }];
  cyclic[0].self = cyclic;
  const a = makeAdapter({ failPrefSetOn: K.rec });
  const r = await createStorage(a).save({ records: cyclic, players: ['A'] });
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes('records'));
  assert.equal(r.backupOk, false);                                // 緊急備份也存不下來
});

test('[R10] pref 主鍵寫失敗但緊急備份成功 → backupOk 為 true', async () => {
  const a = makeAdapter({ failPrefSetOn: K.rec });
  const r = await createStorage(a).save({ records: R, players: ['A'] });
  assert.equal(r.ok, false);
  assert.equal(r.backupOk, true);
  assert.deepEqual(JSON.parse(a._files.get('backup_latest.json')).records, R);
});

test('[R10] 一切正常時 backupOk 為 null（沒有觸發緊急備份）', async () => {
  const r = await createStorage(makeAdapter()).save({ records: R, players: ['A'] });
  assert.equal(r.ok, true);
  assert.equal(r.backupOk, null);
});

// ---------- R12：大量刪除同樣先備份 ----------

test('[R12] records 由 200 筆掉到 1 筆 → 覆寫前先留一份備份', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i, amount: 1 }));
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(many) } });
  await createStorage(a).save({ records: [{ id: 0, amount: 1 }], players: ['A'] });
  assert.deepEqual(JSON.parse(a._files.get('backup_latest.json')).records.length, 200);
});

test('[R12] 正常的小幅刪除不會每次都觸發備份', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, amount: 1 }));
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(many) } });
  await createStorage(a).save({ records: many.slice(0, 9), players: ['A'] });
  assert.equal(a._files.has('backup_latest.json'), false);
});

// ---------- R11：備份寫入順序 ----------

test('[R11] 當日快照先寫、backup_latest 最後寫（latest 是 commit point）', async () => {
  const order = [];
  const a = makeAdapter();
  const origWrite = a.fileWrite.bind(a);
  a.fileWrite = async (n, d) => { order.push(n); return origWrite(n, d); };
  await createStorage(a).writeBackup({ records: R, players: ['A'] });
  assert.deepEqual(order, ['backup_2026-07-07.json', 'backup_latest.json']);
});

// ---------- R7：預設牌友不可被呼叫端污染 ----------

test('[R7] mutate load() 回傳的 players 不得影響後續實例的預設值', async () => {
  const first = await createStorage(makeAdapter()).load();
  first.players.push('MUTATED');
  const second = await createStorage(makeAdapter()).load();
  assert.deepEqual(second.players, DEFAULT_PLAYERS);
});

// ---------- S1/S2：破壞性變更的獨立保險檔與還原出口 ----------

const many = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({
  id: `${tag}-${i}`, date: '2026-09-01T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [],
}));
const safetyNames = (a) => [...a._files.keys()].filter(n => /^safety_/.test(n));

test('[S1] 大幅刪除時寫出保險檔，且不參與每日快照輪替', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(many(200)) } });
  await createStorage(a).save({ records: many(3), players: ['A'] });
  const safety = safetyNames(a);
  assert.equal(safety.length, 1);
  assert.equal(JSON.parse(a._files.get(safety[0])).records.length, 200);   // 存的是「刪之前」那份
});

test('[S1] 保險檔只保留最近 5 份', async () => {
  // fake adapter 的 now() 是 2026-07-07，既有檔名必須早於它，否則新寫的那份反而排在最前面
  const a = makeAdapter({ files: {
    'safety_2026-06-01T000000.json': backup(many(10, 'a')),
    'safety_2026-06-02T000000.json': backup(many(10, 'b')),
    'safety_2026-06-03T000000.json': backup(many(10, 'c')),
    'safety_2026-06-04T000000.json': backup(many(10, 'd')),
    'safety_2026-06-05T000000.json': backup(many(10, 'e')),
  }, pref: { [K.rec]: JSON.stringify(many(100)) } });
  await createStorage(a).save({ records: many(1), players: ['A'] });
  const safety = safetyNames(a).sort();
  assert.equal(safety.length, 5);
  assert.equal(safety.includes('safety_2026-06-01T000000.json'), false);   // 最舊的被汰換
  assert.equal(safety.includes('safety_2026-07-07T000000.json'), true);    // 剛寫的這份留著
});

test('[S1] 正常的小幅變動不產生保險檔', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(many(10)) } });
  await createStorage(a).save({ records: many(9), players: ['A'] });
  assert.equal(safetyNames(a).length, 0);
});

test('[S1] 保險檔納入自動救援候選，排在每日快照之後', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': '{broken',
    'safety_2026-09-01T000000.json': backup([{ id: 'from-safety', date: '2026-09-01T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
  } });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'recovered');
  assert.equal(d.recoveredFrom, 'safety_2026-09-01T000000.json');
});

test('[S1] 每日快照可用時優先於保險檔（保險檔是更保守的後備）', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': '{broken',
    'backup_2026-09-18.json': backup([{ id: 'from-daily', date: '2026-09-18T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
    'safety_2026-09-01T000000.json': backup([{ id: 'from-safety', date: '2026-09-01T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }]),
  } });
  const d = await createStorage(a).load();
  assert.equal(d.recoveredFrom, 'backup_2026-09-18.json');
});

test('[S2] listBackups 列出所有可用備份，最新在前，並標示種類', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': JSON.stringify({ version: 1, exportedAt: '2026-09-19T10:00:00Z', count: 2, records: R, players: ['A'] }),
    'backup_2026-09-18.json': JSON.stringify({ version: 1, exportedAt: '2026-09-18T10:00:00Z', count: 1, records: [{ id: 1, date: '2026-09-18T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }], players: ['A'] }),
    'safety_2026-09-10T120000.json': JSON.stringify({ version: 1, exportedAt: '2026-09-10T12:00:00Z', count: 9, records: many(9), players: ['A'] }),
    '無關的檔案.txt': 'x',
  } });
  const list = await createStorage(a).listBackups();
  assert.deepEqual(list.map(b => b.name), ['backup_latest.json', 'backup_2026-09-18.json', 'safety_2026-09-10T120000.json']);
  assert.deepEqual(list.map(b => b.kind), ['latest', 'daily', 'safety']);
  assert.deepEqual(list.map(b => b.count), [2, 1, 9]);
});

test('[S2] listBackups 略過損毀的備份，不讓它出現在還原清單', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': '{broken', 'backup_2026-09-18.json': backup(R) } });
  const list = await createStorage(a).listBackups();
  assert.deepEqual(list.map(b => b.name), ['backup_2026-09-18.json']);
});

test('[S2] listBackups 在沒有任何備份時回空陣列', async () => {
  assert.deepEqual(await createStorage(makeAdapter()).listBackups(), []);
});

test('[S2] readBackup 走 validateBackup，正規化後回傳', async () => {
  const good = JSON.stringify({ version: 1, records: [{ id: 'a', date: '2026-09-01T00:00:00Z', amount: 100, type: 'win' }], players: ['A'] });
  const a = makeAdapter({ files: { 'backup_latest.json': good } });
  const r = await createStorage(a).readBackup('backup_latest.json');
  assert.equal(r.ok, true);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].participants.length, 0);   // 缺的欄位被補齊
});

test('[S2] readBackup 對損毀或不存在的檔案回可讀的錯誤，不 throw', async () => {
  const a = makeAdapter({ files: { 'backup_latest.json': '{broken' } });
  const s = createStorage(a);
  const bad = await s.readBackup('backup_latest.json');
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  const missing = await s.readBackup('safety_2026-01-01T000000.json');
  assert.equal(missing.ok, false);
  assert.ok(missing.error);
});

// ---------- S3：匯出時間記錄 ----------

test('[S3] markExported 寫入時間，load 讀得回來', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R) } });
  const s = createStorage(a);
  assert.equal((await s.load()).lastExportAt, null);      // 從未匯出
  const m = await s.markExported();
  assert.equal(m.ok, true);
  assert.equal((await s.load()).lastExportAt, m.at);
});

test('[S3] markExported 寫入失敗不 throw，回報 ok:false', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R) }, failPrefSetOn: 'mahjong_last_export' });
  const m = await createStorage(a).markExported();
  assert.equal(m.ok, false);
  assert.ok(m.at);
});

test('[S3] 匯出時間讀取失敗不影響主資料', async () => {
  const a = makeAdapter({ pref: { [K.rec]: JSON.stringify(R) } });
  const orig = a.prefGet.bind(a);
  a.prefGet = async (k) => { if (k === 'mahjong_last_export') throw new Error('boom'); return orig(k); };
  const d = await createStorage(a).load();
  assert.deepEqual(d.records, R);
  assert.equal(d.lastExportAt, null);
});

// ---------- S4：備份目錄搬到 Library，舊位置仍可讀 ----------

test('[S4] 寫入只進新目錄，讀取會回頭找舊目錄', async () => {
  // 模擬雙目錄:LIBRARY 是新家、DOCUMENTS 是 1.2.2 以前寫的位置
  const dirs = { LIBRARY: new Map(), DOCUMENTS: new Map() };
  dirs.DOCUMENTS.set('backup_latest.json', backup(R));    // 舊版留下的備份
  const a = {
    ...makeAdapter(),
    async fileWrite(n, d) { dirs.LIBRARY.set(n, d); },
    async fileRead(n) {
      for (const k of ['LIBRARY', 'DOCUMENTS']) if (dirs[k].has(n)) return dirs[k].get(n);
      return null;
    },
    async fileList() { return [...new Set([...dirs.LIBRARY.keys(), ...dirs.DOCUMENTS.keys()])]; },
    async fileDelete(n) { dirs.LIBRARY.delete(n); dirs.DOCUMENTS.delete(n); },
  };
  const s = createStorage(a);

  const d = await s.load();                               // 讀得到舊目錄那份
  assert.equal(d.source, 'recovered');
  assert.deepEqual(d.records, R);

  await s.writeBackup({ records: [{ id: 'new', date: '2026-09-01T12:00:00.000Z', amount: 1, type: 'win', note: '', participants: [] }], players: ['A'] }, { allowEmpty: false });
  assert.equal(dirs.LIBRARY.has('backup_latest.json'), true);                       // 新的寫進 Library
  assert.deepEqual(JSON.parse(dirs.DOCUMENTS.get('backup_latest.json')).records, R); // 舊的沒被動到
});

// ---------- S5：備份檔的中文摘要欄位 ----------

const summaryOf = (recs, adapter) => createStorage(adapter || makeAdapter()).backupSummary(recs);

test('[S5] 摘要含中文說明、筆數與總結算', () => {
  const s = summaryOf([
    { id: 1, amount: 500, type: 'win' },
    { id: 2, amount: 200, type: 'loss' },
    { id: 3, amount: 1000, type: 'win' },
  ]);
  assert.match(s['說明'], /麻將戰績/);
  assert.match(s['說明'], /匯入備份/);
  assert.equal(s['紀錄筆數'], 3);
  assert.equal(s['總結算'], '+1,300 元');
  assert.ok(s['匯出時間']);
});

test('[S5] 總結算為負時用負號顯示', () => {
  assert.equal(summaryOf([{ id: 1, amount: 800, type: 'loss' }])['總結算'], '−800 元');
});

test('[S5] 空紀錄與非陣列都不會炸', () => {
  assert.equal(summaryOf([])['紀錄筆數'], 0);
  assert.equal(summaryOf([])['總結算'], '+0 元');
  assert.equal(summaryOf(null)['紀錄筆數'], 0);
  assert.equal(summaryOf({ corrupt: true })['紀錄筆數'], 0);
});

test('[S5] 金額異常的紀錄不影響總結算計算', () => {
  const s = summaryOf([
    { id: 1, amount: 500, type: 'win' },
    { id: 2, amount: 'abc', type: 'win' },
    { id: 3, amount: null, type: 'loss' },
  ]);
  assert.equal(s['紀錄筆數'], 3);
  assert.equal(s['總結算'], '+500 元');
});

test('[S5] 帶摘要欄位的備份檔仍能通過 validateBackup', () => {
  const s = createStorage(makeAdapter());
  const recs = [{ id: 'a', date: '2026-09-01T00:00:00Z', amount: 100, type: 'win' }];
  const file = { ...s.backupSummary(recs), version: 1, exportedAt: '2026-09-20T00:00:00Z', records: recs, players: ['阿明'] };
  const v = s.validateBackup(JSON.parse(JSON.stringify(file)));
  assert.equal(v.ok, true);
  assert.equal(v.records.length, 1);
  assert.deepEqual(v.players, ['阿明']);
});

test('[S5] 舊格式(沒有摘要欄位)仍能匯入', () => {
  const s = createStorage(makeAdapter());
  const v = s.validateBackup({ version: 1, records: [{ id: 'a', date: '2026-09-01T00:00:00Z', amount: 100, type: 'win' }], players: [] });
  assert.equal(v.ok, true);
});

test('[S5] 摘要欄位排在檔案最前面(打開第一眼看到中文)', () => {
  const s = createStorage(makeAdapter());
  const recs = [{ id: 'a', date: '2026-09-01T00:00:00Z', amount: 100, type: 'win' }];
  const json = JSON.stringify({ ...s.backupSummary(recs), version: 1, records: recs, players: [] }, null, 2);
  const firstKey = json.split('\n')[1].trim();
  assert.ok(firstKey.startsWith('"說明"'), '第一個欄位應該是說明，實際是: ' + firstKey);
});

// ---------- T:對抗性審查找出的資料遺失路徑 ----------

const rec = (id, opts = {}) => ({
  id, date: opts.date || '2026-09-01T12:00:00.000Z', amount: opts.amount || 100,
  type: opts.type || 'win', note: '', participants: [],
});
const hang = () => new Promise(() => {});   // 永不 settle，模擬 bridge 掛住

test('[T1] 寫入掛住不會讓後續寫入永遠排隊,且如實回報 timedOut', async () => {
  const a = makeAdapter();
  a.writeTimeoutMs = 60;
  let hangNext = true;
  const orig = a.prefSet.bind(a);
  a.prefSet = async (k, v) => { if (hangNext) return hang(); return orig(k, v); };

  const s = createStorage(a);
  const first = await s.save({ records: [rec('a')], players: ['A'] });
  assert.equal(first.ok, false);
  assert.equal(first.timedOut, true);       // 舊版這裡會永遠 pending

  hangNext = false;
  const second = await s.save({ records: [rec('b')], players: ['A'] });
  assert.equal(second.ok, true);            // 鏈沒有卡死，後面的寫入照常
  assert.deepEqual(JSON.parse(a._pref.get(K.rec)), [rec('b')]);
});

test('[T2] load 掛住會逾時 reject,而不是讓使用者卡在載入中', async () => {
  const a = makeAdapter();
  a.loadTimeoutMs = 60;
  a.prefGet = async () => hang();
  await assert.rejects(() => createStorage(a).load(), /逾時/);
});

test('[T3] 救援挑 exportedAt 最新的那份,不是硬吃 backup_latest', async () => {
  const older = JSON.stringify({ version: 1, exportedAt: '2026-09-10T00:00:00Z', count: 1, records: [rec('old')], players: ['A'] });
  const newer = JSON.stringify({ version: 1, exportedAt: '2026-09-19T00:00:00Z', count: 3, records: [rec('n1'), rec('n2'), rec('n3')], players: ['A'] });
  const a = makeAdapter({ files: { 'backup_latest.json': older, 'backup_2026-09-19.json': newer } });
  const d = await createStorage(a).load();
  assert.equal(d.recoveredFrom, 'backup_2026-09-19.json');
  assert.equal(d.records.length, 3);
});

test('[T3] 挑到的不是筆數最多的那份時,要回報還有更完整的備份', async () => {
  const newestButSmall = JSON.stringify({ version: 1, exportedAt: '2026-09-20T00:00:00Z', count: 1, records: [rec('x')], players: ['A'] });
  const olderButBig = JSON.stringify({ version: 1, exportedAt: '2026-09-10T00:00:00Z', count: 4, records: [rec('a'), rec('b'), rec('c'), rec('d')], players: ['A'] });
  const a = makeAdapter({ files: { 'backup_latest.json': newestButSmall, 'safety_2026-09-10T000000.json': olderButBig } });
  const d = await createStorage(a).load();
  assert.equal(d.records.length, 1);
  assert.equal(d.hasLargerBackup, true);
  assert.equal(d.largestCount, 4);
});

test('[T4] 救援濾掉壞紀錄而不是整份放棄,也不把壞資料寫進 pref', async () => {
  const dirty = JSON.stringify({ version: 1, exportedAt: '2026-09-19T00:00:00Z',
    records: [rec('good1'), null, { id: 'bad', amount: 'oops', type: '??' }, rec('good2')], players: ['A'] });
  const a = makeAdapter({ files: { 'backup_latest.json': dirty } });
  const d = await createStorage(a).load();
  assert.equal(d.source, 'recovered');
  assert.equal(d.records.length, 2);              // 兩筆好的救回來
  assert.equal(d.skippedRecords, 2);              // 兩筆壞的被跳過並回報
  assert.equal(d.records.every(r => r && r.type), true);
  assert.equal(JSON.parse(a._pref.get(K.rec)).length, 2);   // 壞資料沒有被持久化
});

test('[T4] 嚴格模式(手動匯入)仍然一筆不合法就整份拒絕', () => {
  const s = createStorage(makeAdapter());
  const v = s.validateBackup({ records: [rec('a'), null], players: [] });
  assert.equal(v.ok, false);
});

test('[T6] 逐筆刪除累積縮水會觸發保險檔,存的是備份裡最完整的那份', async () => {
  const full = Array.from({ length: 20 }, (_, i) => rec('r' + i));
  const a = makeAdapter({
    files: { 'backup_2026-07-06.json': JSON.stringify({ version: 1, exportedAt: '2026-07-06T00:00:00Z', count: 20, records: full, players: ['A'] }) },
    pref: { [K.rec]: JSON.stringify(full) },
  });
  const s = createStorage(a);
  // 一筆一筆刪,每次只差 1 筆——舊的單次比對邏輯完全不會觸發
  for (let n = 19; n >= 12; n--) {
    await s.save({ records: full.slice(0, n), players: ['A'] });
  }
  const safety = safetyNames(a);
  assert.equal(safety.length >= 1, true, '累積縮水到七成應該要留保險檔');
  assert.equal(JSON.parse(a._files.get(safety[0])).records.length, 20, '保險檔要存最完整的 20 筆,不是刪剩的那幾筆');
});

test('[T7] 內容相同的保險檔不重複佔名額', async () => {
  const a = makeAdapter();
  const s = createStorage(a);
  const d = { records: [rec('a'), rec('b')], players: ['A'] };
  const r1 = await s.snapshot(d);
  const r2 = await s.snapshot(d);
  assert.equal(r1.ok, true);
  assert.equal(r2.skipped, 'duplicate');
  assert.equal(safetyNames(a).length, 1);
});

test('[T8] 時鐘被往回調時,剛寫的保險檔不會被自己這一輪刪掉', async () => {
  const a = makeAdapter({ files: {
    'safety_2026-08-01T000000.json': backup(many(5, 'p')),
    'safety_2026-08-02T000000.json': backup(many(5, 'q')),
    'safety_2026-08-03T000000.json': backup(many(5, 'r')),
    'safety_2026-08-04T000000.json': backup(many(5, 's')),
    'safety_2026-08-05T000000.json': backup(many(5, 't')),
  } });
  // adapter 的 now() 是 2026-07-07,比既有檔名都早(等同使用者把時間往回調)
  const r = await createStorage(a).snapshot({ records: [rec('precious')], players: ['A'] });
  assert.equal(r.ok, true);
  assert.equal(a._files.has('safety_2026-07-07T000000.json'), true, '剛寫的那份必須留著');
});

test('[T10] backup_latest 損毀時,空狀態不得覆寫當日快照', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': '{broken',
    'backup_2026-07-07.json': backup(many(20, 'keep')),
  } });
  const r = await createStorage(a).writeBackup({ records: [], players: [] });
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(a._files.get('backup_2026-07-07.json')).records.length, 20);
});

test('[T10] 0 筆的備份不出現在還原清單(點下去等於一鍵清空)', async () => {
  const a = makeAdapter({ files: {
    'backup_latest.json': JSON.stringify({ version: 1, exportedAt: '2026-09-19T00:00:00Z', count: 0, records: [], players: [] }),
    'backup_2026-09-18.json': backup([rec('a')]),
  } });
  const list = await createStorage(a).listBackups();
  assert.deepEqual(list.map(b => b.name), ['backup_2026-09-18.json']);
});

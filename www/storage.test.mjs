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

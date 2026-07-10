# 麻將戰績 App 儲存架構修復 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用戶資料從會被 iOS 清除的 `localStorage` 換成原生 Preferences ＋ 多層自動備份，現有用戶零動作自動遷移，過程中資料絕不遺失。

**Architecture:** 新增一個可注入 adapter 的 `storage` 模組（UMD，瀏覽器與 Node 皆可用），把危險的「遷移 + 回讀驗證 + 備份輪替」邏輯抽成純函式並用 Node 內建測試框架做 TDD；瀏覽器端用 Capacitor Preferences/Filesystem 實作 adapter，React UI 只把 3 處 localStorage 呼叫換成呼叫 storage 模組。

**Tech Stack:** Capacitor 8（`@capacitor/preferences`、`@capacitor/filesystem`）、vanilla JS UMD 模組、Node 20 內建 `node:test`、in-browser React/Babel（現狀，不動）。

## Global Constraints

- **隱私鐵律**：不接後端、不接 CloudKit，資料只在裝置本地（僅隨 Apple 裝置備份）。禁止任何網路呼叫。
- **資料安全不變量**：只要用戶曾有資料，`Preferences / localStorage / backup` 至少一處永遠有可讀副本，絕不同時全空。
- **遷移只一次、冪等、不覆蓋非空、不刪來源、驗證過才標記**（見 spec §3.2.1）。
- **每日備份保留最近 7 份**；即時備份 `backup_latest.json` 每次改動覆寫。
- 實際打包來源是 `www/index.html`（webDir=www）；根目錄 `index.html` 為手動同步副本，須一起改。
- Preferences key：`mahjong_records` / `mahjong_players` / `mahjong_onboarded` / `migrated_v1`。
- 備份檔名：`backup_latest.json` / `backup_YYYY-MM-DD.json` / `pre_migration_backup.json`，寫到 `Directory.Documents`。
- 備份/匯出 JSON 格式：`{ version:1, exportedAt, records, players }`（與現有手動匯出相容）。

---

### Task 1: Scaffold storage 模組 + Node 測試骨架

**Files:**
- Create: `www/storage.js`
- Create: `www/storage.test.mjs`
- Modify: `package.json`（加 deps 與 test script）

**Interfaces:**
- Produces: `createStorage(adapter) -> { load, save, writeBackup }`（後續 Task 消費）。adapter 介面：
  ```
  prefGet(key)->Promise<string|null>  prefSet(key,val)->Promise<void>
  legacyGet(key)->string|null（同步，讀舊 localStorage）
  fileWrite(name,data)->Promise<void>  fileRead(name)->Promise<string|null>
  fileList()->Promise<string[]>        fileDelete(name)->Promise<void>
  today()->'YYYY-MM-DD'  now()->ISO string
  ```

- [ ] **Step 1: 裝依賴**

Run:
```bash
cd /Users/arlong/Projects/Majong_project && npm install @capacitor/preferences@^8 @capacitor/filesystem@^8
```
Expected: `package.json` dependencies 出現兩個外掛，`npm install` 成功結束。
（**版本必須對齊 `@capacitor/core` 的 major＝8**；裝 ^7 會 peer 衝突。先 `npm ls @capacitor/core` 確認 core major，plugin major 跟它一致。）

- [ ] **Step 2: 加 test script**

Modify `package.json` 的 `scripts`：
```json
"scripts": {
  "test": "node --test www/"
}
```

- [ ] **Step 3: 寫失敗測試（模組存在且回傳三個方法）**

Create `www/storage.test.mjs`:
```js
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
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `cd /Users/arlong/Projects/Majong_project && npm test`
Expected: FAIL — `Cannot find module './storage.js'` 或 `createStorage is not a function`。

- [ ] **Step 5: 寫最小 storage.js（UMD 骨架）**

Create `www/storage.js`:
```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1' };
  const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];

  function createStorage(a) {
    async function load() { return { records: [], players: DEFAULT_PLAYERS, onboarded: false, source: 'empty' }; }
    async function save() {}
    async function writeBackup() {}
    return { load, save, writeBackup, _K: K };
  }
  return { createStorage };
});
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npm test`
Expected: PASS（1 test）。

- [ ] **Step 7: Commit**

```bash
git add www/storage.js www/storage.test.mjs package.json package-lock.json
git commit -m "feat(storage): scaffold storage module + node test harness"
```

---

### Task 2: `load()` — 遷移與多重安全防線（核心）

**Files:**
- Modify: `www/storage.js`（實作 `load`）
- Modify: `www/storage.test.mjs`（加測試）

**Interfaces:**
- Produces: `load() -> Promise<{records:Array, players:Array, onboarded:boolean, source:'pref'|'migrated'|'recovered'|'empty'}>`
- Consumes: adapter（Task 1）

- [ ] **Step 1: 寫失敗測試（涵蓋所有防線分支）**

在 `www/storage.test.mjs` 末端加：
```js
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npm test`
Expected: FAIL（load 還是回空 stub）。

- [ ] **Step 3: 實作 `load()`**

在 `www/storage.js` 的 `createStorage` 內，替換 `load`：
```js
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
```

- [ ] **Step 4: 執行確認通過**

Run: `npm test`
Expected: PASS（全部 load 測試綠）。

- [ ] **Step 5: Commit**

```bash
git add www/storage.js www/storage.test.mjs
git commit -m "feat(storage): load() with idempotent migration + defense-in-depth verification"
```

---

### Task 3: `save()` 與 `writeBackup()` — 多層備份 + 每日輪替保留 7 份

**Files:**
- Modify: `www/storage.js`
- Modify: `www/storage.test.mjs`

**Interfaces:**
- Produces: `save({records,players,onboarded}) -> Promise<void>`；`writeBackup({records,players}) -> Promise<void>`

- [ ] **Step 1: 寫失敗測試**

加到 `www/storage.test.mjs`：
```js
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npm test` → FAIL。

- [ ] **Step 3: 實作 save + writeBackup + 輪替**

在 `www/storage.js` 內替換 `save`/`writeBackup`：
```js
    async function save(d) {
      await a.prefSet(K.rec, JSON.stringify(d.records || []));
      await a.prefSet(K.ply, JSON.stringify(d.players || DEFAULT_PLAYERS));
      await a.prefSet(K.onb, String(!!d.onboarded));
    }

    async function writeBackup(d) {
      const payload = JSON.stringify({ version: 1, exportedAt: a.now(), records: d.records || [], players: d.players || DEFAULT_PLAYERS });
      try {
        await a.fileWrite('backup_latest.json', payload);
        await a.fileWrite('backup_' + a.today() + '.json', payload);
        // 輪替：只保留最近 7 份帶日期快照
        const snaps = (await a.fileList()).filter(n => /^backup_\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
        for (const old of snaps.slice(0, Math.max(0, snaps.length - 7))) await a.fileDelete(old);
      } catch (_) { /* 備份失敗不影響主流程 */ }
    }
```

- [ ] **Step 4: 執行確認通過**

Run: `npm test`
Expected: PASS（全部測試綠）。

- [ ] **Step 5: Commit**

```bash
git add www/storage.js www/storage.test.mjs
git commit -m "feat(storage): save + layered backup with 7-day daily snapshot rotation"
```

---

### Task 4: 瀏覽器 adapter + 接進 www/index.html（async 載入 + loading）

**Files:**
- Modify: `www/storage.js`（加瀏覽器 adapter 工廠 `browserAdapter()` 與自動實例）
- Modify: `www/index.html`（載入 storage.js、啟動 async load、save 改呼叫模組）

**Interfaces:**
- Consumes: `window.MahjongStorage.createStorage`（Task 1-3）
- Produces: `window.mahjongStore`（單例，React 用）

- [ ] **Step 1: 加瀏覽器 adapter（在 storage.js 的 factory return 前）**

在 `www/storage.js` `return { createStorage };` 之前插入，並改成同時輸出：
```js
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
```
並把結尾 `return { createStorage };` 改為：
```js
  const api = { createStorage, browserAdapter };
  if (typeof window !== 'undefined') window.mahjongStore = createStorage(browserAdapter());
  return api;
```

- [ ] **Step 2: 在 www/index.html 載入 storage.js**

在 `www/index.html` 載入 React/Babel 的 `<script>` 之前加一行（`<head>` 或 body 頂）：
```html
<script src="storage.js"></script>
```

- [ ] **Step 3: 改 React 啟動為 async 載入 + loading**

在 `www/index.html` 找到目前初始化 records/players 的 `useState`（約 line 104-109）與存檔 `useEffect`（約 line 159-160）。改成：
```jsx
      const [loading, setLoading] = React.useState(true);
      const [records, setRecords] = React.useState([]);
      const [players, setPlayers] = React.useState(['阿明', '小華', '大強', '林小姐']);

      React.useEffect(() => {
        (async () => {
          const d = await window.mahjongStore.load();
          setRecords(d.records); setPlayers(d.players);
          setLoading(false);
        })();
      }, []);

      // 存檔：載入完成後才寫，避免用初始空值覆蓋；debounce 備份
      React.useEffect(() => {
        if (loading) return;
        window.mahjongStore.save({ records, players, onboarded: true });
        const t = setTimeout(() => window.mahjongStore.writeBackup({ records, players }), 1500);
        return () => clearTimeout(t);
      }, [records, players, loading]);
```
並在主要 render 最前面加 loading 短路（找到 `return (` 主畫面處，前面插入）：
```jsx
      if (loading) return (<div className="flex items-center justify-center h-screen text-gray-400">載入中…</div>);
```

- [ ] **Step 4: 手動驗證（瀏覽器，先確認沒把 UI 弄壞）**

Run:
```bash
cd /Users/arlong/Projects/Majong_project && python3 -m http.server 8080 --directory www
```
在瀏覽器開 `http://localhost:8080`，DevTools Console 執行 `localStorage.setItem('mahjong_records', JSON.stringify([{id:1,amount:100}]))` 後重整。
Expected: 看到「載入中…」一瞬 → 畫面顯示那筆 100 的紀錄（web fallback 下 storage 走 localStorage，load 正常）。無 console error。

- [ ] **Step 5: Commit**

```bash
git add www/storage.js www/index.html
git commit -m "feat(storage): wire storage module into UI with async load + loading state"
```

---

### Task 5: 同步根目錄 index.html + cap sync + 版本 bump

**Files:**
- Modify: `index.html`（與 www/index.html 同步）
- Create: `www/storage.js` 的根目錄副本 `storage.js`（若根目錄也被當預覽用）
- Modify: `ios/App/App/Info.plist`（版本號）

- [ ] **Step 1: 同步根目錄檔案**

Run:
```bash
cd /Users/arlong/Projects/Majong_project && cp www/index.html index.html && cp www/storage.js storage.js
diff -q www/index.html index.html && echo SYNCED
```
Expected: `SYNCED`。

- [ ] **Step 2: cap sync（把新外掛帶進 iOS 專案）**

Run:
```bash
cd /Users/arlong/Projects/Majong_project && npx cap sync ios
```
Expected: 輸出含 `@capacitor/preferences` 與 `@capacitor/filesystem` 已 sync；pod install 成功。

- [ ] **Step 3: 版本 bump**

在 `ios/App/App/Info.plist` 把 `CFBundleShortVersionString` 與 `CFBundleVersion` 各加一版（例如 1.0.0 → 1.1.0；build number +1）。

- [ ] **Step 4: Commit**

```bash
git add index.html storage.js ios package.json package-lock.json
git commit -m "chore: sync root html, cap sync ios plugins, bump version"
```

---

### Task 6: iOS 模擬器端到端驗證（spec §6 全數）

**Files:** 無（驗證任務，用 apple-platform-build-tools）

- [ ] **Step 1: build + 裝上模擬器**

用 `apple-platform-build-tools:builder` agent build `ios/App/App.xcworkspace`（scheme App）到 iPhone 模擬器並啟動。
Expected: build 成功、app 起得來、無 crash。

- [ ] **Step 2: 遷移驗證（最重要）**

app 起來後（此時 Preferences 空），在 Safari Web Inspector 對該 WebView console 執行：
```js
localStorage.setItem('mahjong_records', JSON.stringify([{id:1,amount:100,date:'2026-07-01'}]));
localStorage.setItem('mahjong_players', JSON.stringify(['阿明','小華']));
```
完全關閉 app（模擬器 swipe kill）再重開。
Expected: 畫面顯示那筆紀錄；console `await window.Capacitor.Plugins.Preferences.get({key:'mahjong_records'})` 有值；`migrated_v1` = 'true'；Documents 有 `pre_migration_backup.json`。

- [ ] **Step 3: 持久 + 冪等**

再完全關閉重開 2 次。
Expected: 資料仍在；不重複遷移（`pre_migration_backup.json` 內容不變）；不覆蓋。

- [ ] **Step 4: 備份 + 輪替**

在 app 內新增/修改一筆紀錄，等 2 秒。
Expected: Documents 出現 `backup_latest.json` 與 `backup_<今日>.json`。（輪替 7 份已由 Task 3 單元測試覆蓋，模擬器僅確認有寫出。）

- [ ] **Step 5: 匯入 / 反向救援**

用 app 內既有「匯出備份」匯出一份 → 在 console 清掉 `localStorage.clear()` 且刪 Preferences 的 records → 重開 app。
Expected: 走反向救援用 `backup_latest.json` 還原，畫面非空（防線 #7）。再測既有「匯入」功能還原匯出檔正常。

- [ ] **Step 6: 全新用戶**

模擬器「清除所有內容與設定」或裝到乾淨模擬器 → 開 app。
Expected: 正常空狀態、可新增紀錄、無錯誤。

- [ ] **Step 7: 記錄驗證結果**

把上述每項 ✅/❌ 與證據（截圖/console 輸出）記進 `docs/superpowers/plans/2026-07-07-storage-migration.md` 底部「驗證結果」區塊；有 ❌ 回到對應 Task 修正。

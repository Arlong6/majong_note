# 麻將戰績 App — 儲存架構修復設計

**日期**：2026-07-07
**狀態**：設計待審
**觸發**：一位用戶回報「資料突然不見了」。根因調查確認資料只存在 WKWebView `localStorage`，被 iOS 清除且無任何備份/雲端副本，無法復原。

---

## 1. 問題與根因（已查證）

- App 用 **web `localStorage`** 存所有用戶資料，三個 key：`mahjong_records`（戰績/金額）、`mahjong_players`（牌友）、`mahjong_onboarded`（引導旗標）。（`index.html:104-160`）
- **完全無後端**（index.html 網路呼叫數 = 0）、無 iCloud、無自動備份。伺服器上沒有任何副本。
- iOS 把 WKWebView 的 localStorage 當成可回收快取，在**空間不足 / 重裝 / 換手機 / iOS 升級**時會清掉它。這是已知、可避免的失敗模式。
- 讀取邏輯本身有防呆（讀不到回空陣列，不 crash），所以資料消失時 app 只是顯示空白 → 用戶感受到「資料突然不見」。
- **非程式 bug，是架構缺陷**：關鍵資料（含金錢）只放在最脆弱、不同步、無備份的儲存。

## 2. 目標 / 非目標

**目標**
- 現有用戶（資料還在的）**零動作自動遷移**到不會被清的儲存。
- 資料不再被 iOS 輕易清除；換機/重裝（有裝置備份時）救得回。
- **100% 保持「不上傳伺服器」承諾**——資料不離開用戶裝置（僅隨 Apple 裝置備份）。
- 定時多層備份，可回滾到前幾天。

**非目標**
- 不接後端、不接 CloudKit、不做跨裝置即時同步（方案 A 的選擇，維持隱私承諾）。
- 不改任何 UI/畫面邏輯（只換底層儲存）。

## 3. 方案（A：純本地 + 自動備份）

### 3.1 主儲存：localStorage → Capacitor Preferences
- 安裝 `@capacitor/preferences`。iOS 上存進**原生 UserDefaults**（不受 WebView 清快取影響）；web 開發時外掛自動 fallback 到 localStorage，`npm run dev` 照跑。
- 三個 key 全部改走 Preferences。

### 3.2 零動作遷移（最關鍵，最優先測試）
App 啟動時：
1. 讀 Preferences 的 `mahjong_records`。
2. **若 Preferences 為空、但舊 localStorage 有 `mahjong_records`** → 把 localStorage 的 records/players/onboarded 複製進 Preferences。
3. 寫一個 `migrated_v1 = true` 旗標到 Preferences，**只遷移一次**；遷移後不再讀 localStorage、不覆蓋、不刪原 localStorage（保留當保險）。
- 冪等：重複啟動不會重跑、不會覆蓋既有 Preferences 資料。
- **做錯這步 = 親手清掉現有用戶資料**，因此這是測試第一重點。

### 3.2.1 資料安全防線（多重確認，defense-in-depth）

遷移是唯一可能「修的過程反而弄丟資料」的環節，因此每一步都要能驗證、能退回：

1. **遷移前先備份**：碰任何東西之前，先把當下 localStorage 內容寫成 `pre_migration_backup.json`（Documents）。就算後續全爆，這份原始快照還在。
2. **複製後回讀驗證**：localStorage → Preferences 寫入後，**從 Preferences 讀回來**，比對 `records` 筆數與內容雜湊（或逐筆）與來源一致。
3. **驗證通過才標記完成**：只有回讀驗證 pass 才寫 `migrated_v1 = true`。不 pass → 不標記、保留 localStorage、下次啟動重試。
4. **永不刪來源**：遷移後**不刪** localStorage（留作永久保險）。
5. **永不覆蓋非空**：遷移只在「Preferences 空」時執行；Preferences 已有資料絕不被覆蓋。
6. **讀取失敗不清空**：任何讀取/parse 失敗一律回退到「保留記憶體現值 + 讀最新備份」，**絕不因讀不到就把主儲存寫成空**。
7. **反向救援**：每次啟動若發現 Preferences 空、localStorage 也空、但備份檔有資料 → 主動用備份還原（而非顯示空白），避免重演「顯示空白 = 用戶以為資料沒了」。

**不變量（任何情況都必須成立）**：只要用戶曾經有資料，系統中至少存在一份可讀副本（Preferences / localStorage / backup 三者取其一），永遠不會同時全空。

### 3.3 定時多層備份（Capacitor Filesystem → Documents）
- 安裝 `@capacitor/filesystem`。備份寫到 `Directory.Documents`（會被 iCloud/iTunes 裝置備份帶走）。
- **兩層**：
  - `backup_latest.json` — 每次資料改動（debounce ~1.5s）覆寫，永遠是最新。
  - `backup_YYYY-MM-DD.json` — 每天第一次改動時寫一份當日快照，**保留最近 7 份**，超過的刪掉。可回滾到前幾天，防「資料被弄髒」。
- 備份內容：`{ version, exportedAt, records, players }`（與現有手動匯出格式相容，可互相 import）。

### 3.4 保留現有手動匯出/匯入
- `index.html:301-317` 的匯出/匯入功能不動，作為最後一層保險。

## 4. 資料流變化

Preferences/Filesystem 是**非同步**（現在的 code 同步讀 localStorage）：
- 啟動：顯示短暫 loading → `await storage.load()`（含遷移）→ 進 app。
- 改動：state 變 → `await storage.save()`（寫 Preferences）+ debounce 觸發備份。
- 把這些包成一個 **`storage` 模組**（`load` / `save` / `migrate` / `writeBackup` / `rotateBackups`），對外只暴露 async 介面；**React UI 元件不動**，只把原本 3 處 localStorage 呼叫換成呼叫 storage 模組。

## 5. 錯誤處理

- Preferences/Filesystem 全程 try/catch：任何失敗都**不可**讓 app 卡死或清空記憶體中的資料。
- 遷移只在「Preferences 空 + localStorage 有」時執行一次；任何一步失敗 → 保留 localStorage、不寫 migrated 旗標，下次再試。
- 備份寫入失敗 → 只 log/靜默，不影響主流程（備份是加分不是主線）。
- 讀取沿用現有防呆（parse 失敗回預設），但**不因讀不到就覆寫**主儲存。

## 6. 測試（iOS 模擬器）

1. **遷移**：先在 app 存一份 localStorage 舊資料 → 裝新版 → 啟動 → 確認資料完整出現在畫面、且已寫進 Preferences、`migrated_v1` 已設、`pre_migration_backup.json` 已寫。
2. **回讀驗證**：遷移後 Preferences 讀回的筆數/內容 = 來源（防線 #2）。
3. **持久**：完全關閉 app 重開 → 資料仍在。
4. **冪等**：重開多次 → 不重複遷移、不覆蓋、不變動。
5. **備份**：改動資料 → 確認 Documents 有 `backup_latest.json` 與當日 `backup_YYYY-MM-DD.json`；連續數日模擬 → 確認只保留 7 份。
6. **回滾/匯入**：拿一份備份檔用現有匯入功能還原 → 正常。
7. **無資料首開**：全新用戶（無 localStorage、無 Preferences）→ 正常空狀態，不報錯。
8. **失敗退回（負向測試）**：模擬遷移中途 Preferences 寫入失敗 → 確認**不**標記 migrated、localStorage 仍在、下次啟動重試、畫面資料未消失。
9. **反向救援**：清空 Preferences+localStorage 但留一份 backup → 啟動確認自動用備份還原（防線 #7）。
10. **不變量**：上述所有情境中，三處儲存永不同時全空（防線不變量）。

## 7. 影響範圍

- `package.json`：加 `@capacitor/preferences`、`@capacitor/filesystem`。
- `npx cap sync ios`（pod install，把外掛帶進 iOS 專案）。
- **`www/index.html`（實際打包來源，webDir=www）**：新增 `storage` 模組、改 3 處儲存呼叫、啟動加 async 載入/loading。
- **根目錄 `index.html`**：與 `www/index.html` 目前**完全相同、手動同步、無自動 copy 步驟** → 需同步套用相同修改（或實作時評估改用單一來源避免日後 drift）。
- 版本號 bump（CFBundleShortVersionString / Version），重新 build 上架。

## 8. 上線後

- 新版一上架，**現有用戶開 app 即自動遷移**，之後 iOS 清快取不再影響他們。
- 對這次遺失資料的用戶：新版救不回舊資料（已無副本），但能確保不再發生。

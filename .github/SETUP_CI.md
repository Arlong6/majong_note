# CI/CD 設定說明

## 自動化流程

推送 `v` 開頭的 tag 即自動 build + 上傳 App Store Connect：

```bash
git tag v1.1.0
git push origin v1.1.0
```

---

## 一次性設定（GitHub Secrets）

前往 GitHub repo → Settings → Secrets and variables → Actions → New repository secret

### 1. App Store Connect API Key（最重要）

1. 前往 [appstoreconnect.apple.com/access/integrations/api](https://appstoreconnect.apple.com/access/integrations/api)
2. 點 **+** 新增 Key，Role 選 **App Manager**
3. 下載 `.p8` 檔（只能下載一次）

設定三個 Secrets：
| Secret 名稱 | 值 |
|---|---|
| `ASC_KEY_ID` | API Key 的 Key ID（10位英數字）|
| `ASC_ISSUER_ID` | Issuer ID（UUID 格式）|
| `ASC_PRIVATE_KEY` | `.p8` 檔案內容（整段含 BEGIN/END）|

### 2. 簽名憑證

匯出 Distribution Certificate：
```bash
# 在 Keychain Access 找到 "Apple Distribution" 憑證 → 右鍵匯出 .p12
# 然後轉成 base64：
base64 -i certificate.p12 | pbcopy
```

| Secret 名稱 | 值 |
|---|---|
| `CERTIFICATE_BASE64` | 上面 base64 的輸出 |
| `CERTIFICATE_PASSWORD` | 匯出 .p12 時設的密碼 |
| `KEYCHAIN_PASSWORD` | 任意字串（如 `ci-keychain-pass`）|

### 3. Provisioning Profile

```bash
# 從 ~/Library/MobileDevice/Provisioning Profiles/ 找到對應的 .mobileprovision
base64 -i ~/Library/MobileDevice/Provisioning\ Profiles/xxxxxx.mobileprovision | pbcopy
```

| Secret 名稱 | 值 |
|---|---|
| `PROVISIONING_PROFILE_BASE64` | 上面 base64 的輸出 |

---

## 日常更新流程

```bash
# 1. 修改 index.html
# 2. commit
git add -A && git commit -m "feat: 新增功能 xxx"

# 3. 推 tag（版本號自動帶入 App）
git tag v1.1.0
git push origin main --tags
```

GitHub Actions 自動執行：
- npm install → cap sync → Archive → 上傳 App Store Connect
- 約 15~25 分鐘完成
- 完成後到 App Store Connect 選新建置版本 → 提交審查

# Moyue 发布签名 Runbook（release-signing-runbook）

日期：2026-11-14
任务：M0-Q2 发布签名加固（Owner @Eric / Reviewer @Tenny）
仓库：`github.com/anaconda110/moyue`
签名密钥：minisign 更新签名对（Tauri updater）。客户端内嵌**公钥** `7066A0480F75BF43`（`tauri.conf.json` updater.pubkey，2026-11-15 轮换；旧 `6F4D74BBD36FF9D1` 作废存档）。
私钥：仓库外 `~/.tauri/moyue-updater.key`（**永不入库**）。

> 本文件是 M0-Q2 的**运维层交付物**：为更新签名信任根提供 defense-in-depth。
> 它**不预设 Q2（CI-secret vs 离线签名）的最终答案** —— 受保护 environment + 手动审批 +
> 离线备份在两种模型下都增值。凡标 [A-contingent] 的步骤仅在 Q2=A（CI-secret 签名）下适用。

---

## 1. 信任根现状（核实，2026-11-14）

- **签名密钥**：更新签名私钥 `~/.tauri/moyue-updater.key`（minisign 私钥，本机文件，**未 commit 进 git 历史**）。
- **客户端公钥**：`apps/readest-app/src-tauri/tauri.conf.json` updater.pubkey = `7066A0480F75BF43`（minisign 公钥，内嵌客户端，**轮换必须发版**）。**2026-11-15 已轮换**（owner 指示；旧 `6F4D74BBD36FF9D1` 作废存档，未发过任何版本、无客户端信任旧钥）。
- **更新通道**：`.github/workflows/release.yml` 触发 = `workflow_dispatch` + `release:[published]`；
  签名 job（`build-tauri`）使用 `secrets.TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`（**仓库级**）；
  `update-android-latest-json` 把签名后的 `latest.json` 上传到 GitHub Release。
- **约束①**：更新 endpoint = `github.com/anaconda110/moyue/releases/latest/download/latest.json`，**无 readest.com**（满足）。
- **约束②**：签名私钥在 CI secret 中（仓库级）。本 runbook + M0-Q2 把该暴露面收紧为
  「受保护 environment + 手动审批 + 离线备份」—— 信任根 defense-in-depth。

---

## 2. 受保护 environment + 手动审批（Q2 两模型下均适用）

目标：签名/发布 job 只在与 `release` environment 关联、且该 environment 的 required reviewers
（owner）审批通过后才运行。

### 2.1 仓库侧改动（`.github/workflows/release.yml`）

给以下两个**信任根 job** 加 `environment: release`（该 job 即成为 deployment，受 environment
protection rules 约束，无审批则阻塞）：

```yaml
  build-tauri:
    environment: release      # 签名 job：TAURI_SIGNING_PRIVATE_KEY 在此解析
    needs: get-release
    # ... 现有内容不变

  update-android-latest-json:
    environment: release      # latest.json 发布 job
    needs: [get-release, build-tauri]
    # ... 现有内容不变
```

> 注意：`environment: release` 使该 job 内的 `secrets.TAURI_SIGNING_PRIVATE_KEY` 从
> **environment 级**（若已迁移）解析；environment 级同名 secret 会遮蔽仓库级。其它 secret
> （APPLE_* / SENTRY / ANDROID_*）仍从仓库级解析，不受影响。

### 2.2 GitHub 侧配置（需 repo-admin 权限，`gh` 或 UI）

```bash
# 1) 创建 release environment
gh api --method POST repos/{owner}/{repo}/environments/release

# 2) 配置 required reviewers（owner 审批）—— 把 owner 的 GitHub 用户加入
#    (environment protection rules → required reviewers)
#    等价 UI 操作：Settings → Environments → release → Protection rules → Required reviewers

# 3) 限定部署分支/tag（可选但建议）：
#    Settings → Environments → release → Deployment branches/tags → 允许 v* 或 release 相关 tag

# 4) [A-contingent] 把签名 secret 从仓库级迁到 environment 级：
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --body "<base64 私钥>"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --body "<密码>"
gh secret delete TAURI_SIGNING_PRIVATE_KEY          # 迁移后清仓库级
gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# 5) 加 tag protection（防止非授权创建 release tag）：
#    Settings → Rules → Rulesets → 新建，target=tag，限制能推/删 release 相关 tag 的人
#    或 UI：Settings → Tags → Protected tags
```

---

## 3. 私钥离线加密备份（Q2 两模型下均适用）

**目标**：私钥在**仓库外、离线、加密**保存 ≥2 份，防单点丢失；任何环节私钥**不写入仓库、日志、
任务线程、CI 缓存**（红线）。

### 3.1 生成/存放

- 私钥路径：`~/.tauri/moyue-updater.key`（本机，不 commit）。
- **离线加密备份**：用 `age` 或 `gpg --symmetric` 加密后存到**冷存储**（离线 U 盘 / 加密网盘）≥2 份：

```bash
# 用 age 加密（推荐，公钥对/口令都行）
age -p -o moyue-updater.key.age ~/.tauri/moyue-updater.key   # 口令加密
# 或用 gpg
gpg --symmetric --cipher-algo AES256 -o moyue-updater.key.gpg ~/.tauri/moyue-updater.key
```

- 把加密备份存到 2 处独立位置（至少 1 处离线/冷存），**记录存放位置与访问人**（见 §6 表）。
- 加密口令/身份密钥（age 口令或 gpg 口令）**与备份分处存放**，不能和备份放一起（否则失去意义）。

### 3.2 校验备份可恢复（每季度 + 轮换前）

- 解密备份到临时目录，比对私钥指纹与当前 `~/.tauri/moyue-updater.key` 一致；
- 用解密出的私钥对一个测试字符串签名，并用客户端内嵌公钥 `7066A0480F75BF43` 验签，确认**私钥↔公钥对**正确。

---

## 4. 恢复步骤（私钥丢失/损坏时）

1. 取离线加密备份 → 解密到 `~/.tauri/moyue-updater.key`（恢复原路径，权限 `600`）。
2. 校验：`minisign` 或 Tauri 签名 CLI 用恢复的私钥签名一个测试串，客户端公钥 `7066A0480F75BF43` 验签通过。
3. **若两处备份都不可用** → 视为**密钥丢失**，走 §5 轮换（不能继续用不可信的"恢复"）。
4. 记录恢复时间、操作人、备份来源（§6 表）。

---

## 5. 轮换说明（Tauri 公钥内嵌客户端 → 轮换必须发版）

> **关键约束**：客户端内嵌的更新公钥是 `7066A0480F75BF43`，**无法热更新**。轮换签名密钥 = 新公钥必须随
> **一次发版**进入客户端，否则客户端用旧公钥验新签名的包会失败。
>
> **轮换已执行 2026-11-15**（owner 指示，oraw 执行）：旧 `6F4D74BBD36FF9D1` → 新 `7066A0480F75BF43`；
> 新公钥已进仓库（`bbc4b0cb5`），env `release` secrets 已重置；未发过任何版本、无客户端信任旧钥，不构成违约。

轮换步骤（仅在需要时执行，需 owner 决策）：
1. 生成新 minisign 密钥对：`pnpm tauri signer generate -w ~/.tauri/moyue-updater.key`（新私钥+公钥）。
2. 用新私钥对新版本包签名；**新公钥**写入 `tauri.conf.json` updater.pubkey，随该版本**发版**。
3. **发版后**：确认所有在网客户端能收到新版本（旧公钥验不了新包 → 客户端会提示手动更新或失败，需
   明确过渡期）。**旧私钥归档销毁**（离线加密备份更新为新私钥）。
4. 更新本 runbook 的公钥记录与备份位置表。

---

## 6. 泄漏应急（私钥泄露 = 信任根破，最高优先级）

**红线**：私钥一旦可能泄露（进过仓库/日志/任务线程/CI 缓存被下载、或有人未经授权访问）——
**立即按此处置，不得等**：

1. **冻结**：立即停止用该私钥签名 / 暂停发布（owner 同意前不产生新签名产物）。
2. **轮换**：立即执行 §5 轮换（新密钥对 + 随最近一次可发版替换公钥）。
3. **追溯**：检查 git 历史 / CI 日志 / GitHub Actions artifacts / 任务线程，确认私钥是否真正暴露；
   若暴露过，**视同不可信**，旧密钥对作废。
4. **记录**：泄漏时间、暴露面、影响、处置，写入 §6 表 + 通知 owner。

---

## 7. 验收证据清单（对齐 @Tenny Reviewer 五点）

| # | 证据 | 谁产出 |
|---|---|---|
| 1 | `gh api` 输出：`release` environment 存在 + required reviewers 生效 | @oraw (repo-admin) |
| 2 | `gh secret list --env release`：签名 secret 仅在 environment 级；仓库级已清（或理由成立） | @oraw (repo-admin) |
| 3 | dry-run：无审批 → release job 阻塞；审批后运行 | @oraw (repo-admin) |
| 4 | runbook 恢复/轮换演练**真实跑过**（命令输出留痕） | @Eric（+@oraw 配合） |
| 5 | 私钥零暴露：不进 repo/日志/任务线程（grep + 核查） | @Eric + @Tenny 复核 |

---

## 8. 私钥位置记录表（每季度更新）

| 备份副本 | 位置 | 加密方式 | 访问人 | 最后校验 |
|---|---|---|---|---|
| 主私钥 | `~/.tauri/moyue-updater.key`（本机） | 明文（本机） | owner/oraw | 2026-11-15（轮换后） |
| 旧私钥 | （存档/作废，`6F4D74BBD36FF9D1`） | — | — | 2026-11-15（作废） |
| 冷存 1 | （离线 U 盘 / 加密盘，待填） | age/gpg 加密 | （待填） | （待填） |
| 冷存 2 | （独立位置，待填） | age/gpg 加密 | （待填） | （待填） |

# live-dashboard-ksu

> **Live Dashboard 自建改造版** · KernelSU 上报模块 · 应用使用时长统计 · 事件通知 · 隐私模式 · 纯 IPv6 公网部署

本仓库是 [**Monika-Dream/live-dashboard**](https://github.com/Monika-Dream/live-dashboard) 的**个人改造版**（独立仓库，非官方版本，不是 GitHub fork）。

仓库名里的 **ksu = KernelSU** —— 本改造最大的变化就是用 **KernelSU root 模块**取代了上游依赖的官方 Android App。

上游是一个"视监面板"：把你设备正在使用的应用实时展示在一个网页看板上。

---

## ⚠️ 上游署名与开源协议

| 项目 | 内容 |
|---|---|
| 上游仓库 | [`Monika-Dream/live-dashboard`](https://github.com/Monika-Dream/live-dashboard) |
| **原作者** | **Monika**（GitHub: [@Monika-Dream](https://github.com/Monika-Dream)） |
| **开源协议** | **MIT License** —— 见 [LICENSE](./LICENSE)，**版权归原作者所有**：`Copyright (c) 2026 Monika` |
| 基线版本 | commit [`6ba9a5e`](https://github.com/Monika-Dream/live-dashboard/commit/6ba9a5edc09b0c4389d1d6b57a4f55ff385d855b)（2026-07-23，`main` 分支） |
| 上游 README | 原文保留在 [README.upstream.md](./README.upstream.md) |

**本仓库对 MIT 协议的遵守**：

- `LICENSE` **原样保留**（MIT 要求在任何副本与衍生作品中保留版权声明与协议全文）
- 本仓库**第一个 commit 是上游的原始快照**（未做任何修改），从第二个 commit 起才是本改造 —— 便于用 `git log` / `git diff` 核对改动
- 本仓库的改动部分版权归本仓库作者，同样以 **MIT License** 发布
- 二次使用本仓库时，请同时保留上游与本仓库的版权声明

---

## 改动清单（相对上游 `6ba9a5e`）

### 一、手机端：KernelSU 上报模块（新增 `module/`）

上游依赖官方 Android App（无障碍快照 + UsageStats 回退）。本改造改为 **KernelSU（兼容 Magisk 格式）root 模块**：

| 能力 | 说明 |
|---|---|
| 前台应用识别 | 直接 `dumpsys activity` 取 topResumedActivity，规避上游"无障碍快照有效期 12 小时"被 MIUI 游戏工具箱卡死的问题 |
| **应用使用时长** | 解析 `dumpsys usagestats` 事件流，配对 `ACTIVITY_RESUMED/PAUSED` 计算**亮屏 / 解锁 / 各 App 前台时长**（必须排序 + 去重、熄屏后恢复计时） |
| 健康数据 | 直读**小米运动健康** SQLite（`fitness_data` 的 `hr_record`/`sleep_segment`/`spo2_record`/`weight_item_record` 与 `fitness_summary`）+ MIUI 计步库，不依赖 Health Connect |
| **隐私模式** | KernelSU「操作」按钮一键切换 / 按 App 包名名单 / 超时自动关闭；开启后只上报 `app_id=private`，不报应用名与窗口标题 |
| **事件通知** | 轮询服务端事件，在本机弹**系统原生通知**（关键：必须以 `shell`(uid 2000) 身份发布，root 身份会被系统静默丢弃） |
| 免依赖 | 内置静态编译的 aarch64 `sqlite3`，手机端无需任何额外依赖 |

### 二、服务端（新增接口与事件系统）

| 文件 | 改动 |
|---|---|
| `packages/backend/src/routes/usage.ts` | **新增**：`POST /api/usage`（上报使用时长 + 亮屏/解锁）、`GET /api/usage`（某天排行）、`GET /api/usage/range`（周/月区间 + 每日趋势）；含服务端**显示层排除列表** `USAGE_HIDE_APPS` |
| `packages/backend/src/routes/events.ts` | **新增**：`GET /api/events`（Bearer 鉴权，**事件内容不在面板公开**） |
| `packages/backend/src/services/watcher.ts` | **新增**：变化检测（上线/离线、打开应用、开始/拔掉充电、电量低于阈值、进入隐私模式）→ `events` 表；含**抖动抑制**（`notify` 标记：同设备同类型在冷却窗口内只通知一次） |
| `packages/backend/src/routes/diag.ts` | **新增**：`POST /api/diag` 诊断通道（调试用途，可删除） |
| `packages/backend/src/db.ts` | 新增表 `usage_stats`、`screen_time`、`events` 及相关语句 |
| `packages/backend/src/index.ts` | 注册上述路由、启动 watcher |
| `packages/backend/src/routes/proxy.ts` | 多面板代理白名单补充 `usage` / `usage/range` |

### 三、前端

| 文件 | 改动 |
|---|---|
| `src/components/UsageStats.tsx` | **新增**：应用使用时长统计卡（今天 / 近 7 天 / 近 30 天 + SVG 趋势折线 + 排行） |
| `src/components/DatePicker.tsx` | 增加原生 `<input type="date">` 日期跳转（原版只能一天天翻） |
| `src/lib/api.ts` | 新增 `fetchUsage` / `fetchUsageRange` 及类型定义 |
| `app/page.tsx` | 挂载统计卡 |
| `public/favicon.ico` | 新增图标（原版 `/favicon.ico` 会落到 SPA 兜底返回 HTML） |

### 四、部署与文档

- **`docs/项目文档.md`（约 900 行）**：自建部署实录 —— Debian + Bun + systemd + nginx（TLS / 限流 / 扫描器拦截）+ **纯 IPv6 公网访问**（ddns-go 只发布 AAAA + Let's Encrypt **DNS-01** 证书）+ 模块原理 + API 参考 + 运维手册 + 备份恢复 + 已知限制 + 全部踩坑记录

---

## 快速开始

上游的构建方式不变（Bun + Next.js 静态导出）：

```bash
# 后端（Bun）
cd packages/backend
bun install
# 按 .env.example 配置环境变量（DEVICE_TOKEN_n / HASH_SECRET / STATIC_DIR …）
bun run src/index.ts

# 前端（Next.js 静态导出）
cd packages/frontend
bun install
bun run build                 # 产出 out/
rm -rf ../backend/public && cp -r out ../backend/public
```

**手机端模块**（需要 KernelSU 或 Magisk，Android 需 root）：

```bash
# 1) 改配置
vim module/config.sh    # SERVER_PRIMARY / TOKEN / DEVICE_ID / USAGE_* / EVENT_* / PRIVACY_*
                        # TOKEN 取服务端 DEVICE_TOKEN_n 的第一段（冒号前）

# 2) 打包（保持 module.prop 在 zip 根目录）
cd module && zip -r ../ld-reporter.zip .

# 3) 手机端用 KernelSU「从本地安装」后重启；
#    或解压到 /data/adb/modules/live_dashboard_reporter/
```

详细步骤、参数语义与踩坑记录见 **[docs/项目文档.md](./docs/项目文档.md)**。

---

## 本改造版的已知限制

1. **仅支持 IPv6 对外**（家庭宽带无公网 IPv4 时的方案，见文档 §4.1）
2. 健康数据依赖**小米运动健康**的数据库结构，换品牌 / 换 App 不适用
3. 使用时长依赖 `dumpsys usagestats` 事件流（最多回看 24 小时），**更早的历史补不了**
4. 事件通知依赖手机上的模块在运行；被系统杀掉期间会漏通知（事件仍留存在服务端库里）
5. `events` / `health_records` 目前**没有过期清理策略**（`activities` 有 7 天自动清理）

---

## 许可

- 上游代码：**MIT License**，`Copyright (c) 2026 Monika`（见 [LICENSE](./LICENSE)）
- 本仓库改动：同样以 **MIT License** 发布

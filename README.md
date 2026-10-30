# ZYW图床 (ZYW Image Hosting v2.0)

> 基于《tu.baidui.de5.net (T-IMG) 站点分析报告》及全部探测样本数据深度重构与全方位升级的**高端云端图床源码**。

---

## 一、相比原版 T-IMG 的核心架构升级

| 维度 | 原版 `T-IMG` (`tu.baidui.de5.net`) | 全新升级版 **ZYW图床 v2.0** |
|---|---|---|
| **前端包体积与性能** | Nuxt 2 + Vue 2 (EOL) + 全量 Element UI，首屏未压缩 JS 高达 **1.19 MB** | **零冗余原生架构 + 现代玻璃拟态 UI**，单文件秒开，无废弃框架安全隐患 |
| **上传能力** | 仅支持单张上传，仅支持 `jpeg/png/gif/mp4` | **多文件并发批量拖拽 / 点选 / 粘贴上传**，支持 `JPEG/PNG/GIF/WebP/AVIF/SVG/HEIC/MP4` 及前端智能 WebP 压缩 |
| **链接复制格式** | 仅支持单条 URL 或单条 Markdown 切换 | **四合一格式一键复制**：支持单张卡片与多图批量汇总一键复制 **BBCode (`[img]`)、HTML (`<img>`)、Markdown (`![]()`)、URL 直链** |
| **存储引擎可靠性** | 仅依赖 Telegram Bot API，面临封号/清理导致全站死链风险 | **Cloudflare R2 + Telegram Bot API 双活存储引擎** + KV `IMAGE_INDEX` 索引，支持主备自动切换 |
| **门禁与安全防护** | 仅拦截 5 个白名单路径（`/upload` 等可直接绕过看到页面）、登录无限流、无 HSTS、CORS `*`、全站软 404 | **全路径 `_middleware.js` 门禁**、IP 登录防爆破限流（10分钟5次返回 `429`）、`HSTS` 强安全头、同源严格 CORS、真实 404 响应 |
| **视觉与交互体验** | 314×370px 局促白色小卡片 | **黑金深空极光玻璃拟态 + Bing 每日壁纸轮播双模式**，支持图库管理、相册分类、实时并发进度条、灯箱预览 |

---

## 二、目录结构

```text
zyw-tuchuang/
├── public/
│   ├── index.html                  # ZYW图床 主应用（支持批量上传、BBCode/HTML/Markdown一键复制、图库管理）
│   ├── upload-login.html           # 独立轻量级安全认证门禁页
│   ├── robots.txt                  # 标准搜索引擎爬虫规则（修复原版软 404）
│   ├── manifest.json               # PWA Web App Manifest
│   ├── favicon.ico                 # 原版提取图标资源
│   └── assets/
│       └── images/
│           ├── background.svg      # 原版提取矢量背景装饰纹样
│           └── favicon_256.png     # 高清站点图标
├── functions/                      # Cloudflare Pages Functions 服务端无服务器接口
│   ├── _middleware.js              # 全局门禁、CSRF 校验、HSTS 安全头、真实 404 路由守卫
│   ├── upload.js                   # POST /upload 批量上传接口（R2 + Telegram 双活引擎 + 11种标准错误码）
│   ├── file/
│   │   └── [id].js                 # GET /file/:id 同域直链边缘缓存读取接口
│   └── api/
│       ├── bing/
│       │   └── wallpaper.js        # GET & POST /api/bing/wallpaper 每日必应壁纸代理
│       ├── manage/
│       │   └── list.js             # GET & DELETE /api/manage/list 图库索引查询与删除接口
│       └── upload-auth/
│           ├── login.js            # POST /api/upload-auth/login 带 KV 速率限制的登录认证
│           ├── logout.js           # POST /api/upload-auth/logout 销毁会话 Cookie
│           └── session.js          # GET /api/upload-auth/session 会话状态探测
├── wrangler.toml                   # Cloudflare Pages / KV / R2 配置文件
├── package.json                    # 项目脚本配置
└── README.md                       # 部署与使用文档
```

---

## 三、快速部署指南 (Cloudflare Pages)

1. **创建 KV 命名空间与 R2 存储桶**：
   - 在 Cloudflare Dashboard 创建 KV 命名空间并绑定变量名 `IMAGE_INDEX`。
   - 创建 R2 存储桶 `zyw-images` 并绑定变量名 `ZYW_R2_BUCKET`。
2. **配置环境变量**：
   - `UPLOAD_AUTH_PASSWORD`：设置上传访问密码（留空则为公开免密上传模式）。
   - `SESSION_SECRET`：用于签名 `zyw_session` Cookie 的随机密钥。
   - `STORAGE_DRIVER`：`dual`（默认 R2+Telegram 双备）、`r2`（仅 R2）或 `telegram`（仅 Telegram）。
   - `TG_BOT_TOKEN` & `TG_CHAT_ID`：当启用 Telegram 存储通道时填写 Bot Token 与频道/群组 ID。
3. **本地预览或一键部署**：
   ```bash
   npx wrangler pages dev public
   npx wrangler pages deploy public --project-name zyw-tuchuang
   ```

---

## 四、v3.0 修复：上传成功但直链几分钟后 404（`file_not_found`）

### 根因

v2.3 的 `detectStorageBindings()` 在**一个绑定都没有**时不会报错，而是把文件只写进了两个「易失」位置：

| 写入位置 | 实际生命周期 | 是否跨机房 |
|---|---|---|
| `caches.default`（边缘缓存） | 随时被驱逐，通常几分钟~几小时 | ❌ 不共享 |
| `globalThis.__ZYW_MEM_STORE`（内存） | Worker isolate 回收即丢失 | ❌ 不共享 |

所以现象必然是：**刚上传时能打开 → 过一会儿 / 换个网络 404 → 换回原网络又能打开**。这不是偶发 bug，是架构缺陷。

### v3.0 的改动

1. **写入链变为**：R2（强一致）→ KV → Telegram → 三者全失败才降级。
2. **每次写入后回读校验**（`r2.head()` / `kv.get()`），杜绝「接口说成功但对象没落盘」。
3. **边缘缓存降级为纯加速层**，不再被当成存储。
4. **Telegram 成为零绑定持久化方案**：直链形如 `/file/tg_<file_id>.<ext>`，file_id 直接内嵌在路径里，不需要 KV 也能永久回源。
5. **无持久化时不再假装成功**：上传响应带 `durable: false` + `warning`，前端弹出红色警告，卡片显示「临时缓存」。
6. 新增自检接口 `GET /api/storage/status`，一次性看清 R2 / KV / Telegram 到底通不通。
7. 删除图片时同步 `caches.default.delete()`，避免删了还能访问。

### 必须做的配置（否则直链依然会掉）

> 代码只能保证「只要绑定了就 100% 持久」，绑不绑是控制台的事。

**方式 A：Dashboard 绑定（推荐，连 Git 仓库部署的用这个）**

1. Cloudflare Dashboard → **R2** → Create bucket，名称如 `zyw-images`（无需公开访问）。
2. 进入 **Workers & Pages → 你的项目 → Settings → Bindings**（新界面叫 *Runtime / Bindings*）。
3. **Add → R2 bucket**
   - Variable name：`ZYW_R2_BUCKET`
   - R2 bucket：选刚建的 `zyw-images`
4. （可选）**Add → KV namespace**，Variable name 填 `IMAGE_INDEX`，用于图库列表与登录限流。
5. **Deployments → 重新部署一次**（绑定变更必须重新部署才生效）。

**方式 B：Telegram 兜底（不想开 R2 / 没有信用卡）**

在 Settings → Environment variables 加：

| 变量 | 值 |
|---|---|
| `TG_BOT_TOKEN` | BotFather 拿到的 token |
| `TG_CHAT_ID` | 频道/群组 ID，如 `-1001234567890` |

重新部署后，未绑定 R2 时上传会自动走 Telegram，直链变成 `/file/tg_xxx.webp`，长期有效（单文件上限 20MB）。

### 部署后自检

登录站点后，浏览器直接打开：

```
https://你的域名/api/storage/status
```

正常应返回：

```json
{ "durable": true, "checks": { "r2": "ok", "kv": "not_bound" } }
```

`r2: ok` 就说明直链已经持久，可以正常用了。若返回 `"r2": "not_bound"`，说明绑定没生效，重点检查：变量名拼写、是否重新部署过。

### KV 不绑会怎样（v3.1 已处理大部分）

| 能力 | 不绑 KV 的实际影响 |
|---|---|
| 直链访问 | ✅ 无影响（走 R2） |
| 图库列表 | ✅ 无影响（v3.1 改为 `r2.list()` 枚举对象，零 KV 也能列全） |
| 删除图片 | ✅ 无影响（直接删 R2 对象） |
| 登录限流 | ⚠️ 失效（`login.js` 依赖 `IMAGE_INDEX` 计数），密码可被无限次尝试 |

所以 KV 属于「建议绑、不是必须绑」。要绑就把变量名设为 `IMAGE_INDEX`。

### ⚠️ 历史图片必须重传

修复前上传的图（例如 `39840056c1fa.webp`）**从来没有进过 R2/KV**，只存在于当时的边缘缓存里，已经再也找不回来了。绑定存储后需要重新上传一遍。


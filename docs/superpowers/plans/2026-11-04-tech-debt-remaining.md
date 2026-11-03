# Clipchan 技术债剩余项清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉工程质量审计（23 条）里**不需要产品决策就能落地**的剩余条目，并把需要决策的条目连同证据一起交到用户手上。

**Architecture:** pnpm workspace 四包 —— `@clipchan/core`（平台无关：React 界面、zustand 风格 store、纯逻辑、`PlatformAdapter` 契约）、`@clipchan/desktop`（Electron 主进程 + preload + better-sqlite3 仓储 + 剪贴板轮询 + C# 原生助手）、`@clipchan/ai`、`@clipchan/mobile`。主进程是唯一能碰 SQLite / 文件系统 / Win32 的地方；渲染层只通过 `channels.ts` 声明的固定 IPC 通道通信。本计划全部改动落在这套既有分层内，不新增包、不新增进程。

**Tech Stack:** TypeScript 5.9、Electron + Chromium（`target: chrome120`）、React 18 + framer-motion + Tailwind、better-sqlite3 13、vitest 3（**node 环境，仓库无 jsdom / @testing-library**）、pnpm 11.9。

**Spec:** `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md`（重做总设计）；审计原文 `clipchan-tech-debt.md`（在 Desktop 会话产物目录，未入库）——本计划逐条对应它的 T-B/T-M/T-N 编号。

## Global Constraints

（每个任务的隐含要求，逐字来自现有代码与审计）

- 依赖零新增：不装任何新 npm 包；**产品承诺零服务器依赖**，任何"回落到第三方服务"的写法（如 favicon 走 google s2）都不允许，见 `packages/desktop/electron/url-meta.ts:113` 的注释。
- 测试环境：vitest 只跑 node，**没有 jsdom**。组件行为不得靠"渲染组件发事件"来测；判定逻辑必须能抽成纯函数单测（`packages/core/src/ui/keymap.ts` 是正面样本）。所有 `*.spec.ts` 与源码**同目录**放置。
- 门禁三连，每个任务收尾都要跑：`pnpm typecheck`（= `tsc -b --pretty false`）、`pnpm test`、`node scripts/smoke-main.mjs`（Electron 冒烟，13 项断言）。
- 数据库 schema 变更只能**增量**：新列靠 `ensureColumns` 的 `ALTER TABLE` 补，因此引用新列的 `CREATE INDEX` 只能写在迁移尾部（`db.ts` 里 `idx_items_folder` 的同一段），**不能**写进 `SCHEMA_SQL` —— 老库 `CREATE TABLE IF NOT EXISTS` 是空操作，列还没补就建索引会抛 `no such column` 直接起不来。
- 用户可见文案一律中文；破坏性操作（删除、清空）必须二次确认并说清后果。
- 注释只写"为什么"，且与本仓库现有风格一致（★ 开头标重点）。
- **git 边界**：本计划里只有 Task 1 涉及提交，其余任务不 `push`、不动 tag、不改历史。`git tag -f` / `filter-repo` / force-push 属于影响公开仓库的破坏性操作，必须由用户明确批准后才能执行（见文末"需要用户点头的事"）。
- `--smoke` 模式必须保持"快且只验骨架"：不启动轮询/助手/备份/空间回收（`main.ts` 里 `if (!SMOKE)` 的既有惯例）。

---

## 文件结构（本计划涉及的文件与职责）

| 文件 | 职责 | 本计划里的改动 |
|---|---|---|
| `packages/desktop/electron/ipc.ts` | IPC 注册边界 + `makeBroadcaster` 事件出口 | Task 2：给 `itemsChanged` 加合并窗口 |
| `packages/desktop/electron/db.ts` | SQLite 仓储、schema、迁移、上限淘汰 | Task 3、4、5、6、7、8、11 |
| `packages/desktop/electron/main.ts` | 主进程装配、启动路径、handler 表 | Task 3（兜底文案）、Task 8（emptyTrash 改一次取全） |
| `packages/core/src/state/store.ts` | 渲染层状态与 IPC 调用方 | Task 7（`searchSignature` 透传） |
| `packages/core/src/platform/adapter.ts` | 平台契约与缺省拒绝实现 | Task 7（新增 `items.searchPage` 契约） |
| `packages/desktop/electron/preload.ts` | 类型化 invoke 桥 | Task 7（`searchPage` 桥） |
| `packages/desktop/electron/channels.ts` | IPC 通道名清单 | Task 7（`items.searchPage` 通道） |
| `packages/desktop/electron/watcher.ts` | 300ms 剪贴板轮询 | Task 9（文本分支粗判） |
| `packages/desktop/electron/images.ts` | 图片落盘/缩放/alpha/phash | Task 10（一次 `toBitmap` 复用） |
| `packages/core/src/ui/MasonryList.tsx` | 瀑布流列容器 | Task 11（先定性，可能只加注释与测试） |
| `packages/desktop/vite.config.ts` | 渲染层构建 | Task 12（生产不出货源映射、剥 console） |
| `packages/desktop/electron/url-meta.ts` | 链接预览抓取 | Task 13（`faviconCandidates` 死代码收口） |
| `packages/core/src/logic/organize.ts` | 本地整理规则 | Task 13（`AUTO_TAGS` 收口） |

---

## Task 1: 把当前 22 个未提交改动落成 4 个逻辑提交

**为什么排在第一个：** 后面每个任务都要"改完就提交"，而工作树里已经压着 1030 行未提交改动（含真机验证过的修复）。不分段落盘，后面任何一次回滚都会把这些一起丢掉。

**Files:**
- Modify: 无（只提交既有工作树）

**Interfaces:**
- Consumes: 当前工作树（`git status` 22 项：20 改 + 2 新）
- Produces: 4 个可独立 revert 的提交

- [ ] **Step 1: 向用户确认可以提交**（用户此前只说"帮我完成修复"，没要求提交；未确认前不要执行任何 `git commit`）

- [ ] **Step 2: 按逻辑分组暂存并提交**

```bash
cd clipchan
# ① 隐私与工具配置
git add docs/superpowers/evidence/task12-commands.txt \
        docs/superpowers/specs/2026-10-15-clipchan-rebuild-design.md \
        packages/core/src/logic/classify.spec.ts packages/core/src/logic/organize.spec.ts \
        pnpm-workspace.yaml scripts/dev.mjs
git commit -m "chore: 补齐残留绝对路径脱敏，tesseract.js 构建审批填 false，dev 固定监听 127.0.0.1"

# ② 界面功能缺陷
git add packages/core/src/ui/keymap.ts packages/core/src/ui/keymap.spec.ts \
        packages/core/src/ui/App.tsx packages/core/src/ui/SearchBar.tsx \
        packages/core/src/ui/OrganizeItemDialog.tsx packages/core/src/ui/OrganizeViewCard.tsx
git commit -m "fix: Esc 只关最上层（浮层/整理页优先），规则标签与文件夹移动真正接上界面"

# ③ 数据库代价与空间回收
git add packages/desktop/electron/db.ts packages/desktop/electron/db.spec.ts \
        packages/desktop/electron/recorder.ts packages/desktop/electron/images.ts
git commit -m "perf(db): 补相似判定/回收站/seq/图片字节四条索引，淘汰改区间删除，写入不再全量读图片行，并回收空闲页"

# ④ 观测面与启动路径
git add packages/desktop/electron/perf.ts packages/desktop/electron/perf.spec.ts \
        packages/desktop/electron/watcher.ts packages/desktop/electron/watcher.spec.ts \
        packages/desktop/electron/main.ts packages/desktop/electron/images-policy.ts
git commit -m "feat: 最小性能观测面（T-N8）+ 启动重活移出建窗路径（T-B4 半）"
```

- [ ] **Step 3: 验证工作树干净、提交可追溯**

Run: `git status --short && git log --oneline -5`
Expected: 无输出（工作树干净）+ 上面 4 条提交在最前

- [ ] **Step 4: 不推送。** `git remote` 指向公开仓库 `jfxb666/clipchan`，推送由用户决定。

---

## Task 2: `itemsChanged` 加合并窗口（T-M5，Major）

**问题：** `ipc.ts` 的 `itemsChanged: () => send(EV.itemsChanged)` 只发信号不带数据（这点是对的），但**没有合并窗口**；主进程有 24 个调用点，渲染层 `store.ts:1089` 收到就 `load()` 全量重拉。连续复制、批量收藏/删除时会在一秒内打出十几次"重拉整页"。正面样本：AI 流式通道有 `deltaThrottle.ts:13` 的 120ms 节流。

**Files:**
- Modify: `packages/desktop/electron/ipc.ts`（`makeBroadcaster`，现约 145-168 行）
- Test: `packages/desktop/electron/ipc.spec.ts`（已存在，追加 describe）

**Interfaces:**
- Consumes: `makeBroadcaster(getWindow)` 现有签名不变
- Produces: `makeBroadcaster(getWindow, opts?: { coalesceMs?: number; now?: () => number; setTimeout?; clearTimeout? })` —— 默认开 120ms 合并；`itemsChanged()` 语义变为"最近一次变更的去抖广播"

- [ ] **Step 1: 写失败测试**（追加到 `ipc.spec.ts` 末尾）

```ts
/**
 * ★ T-M5：itemsChanged 必须合并窗口。
 * 主进程 24 个调用点 + 渲染层"收到就重拉整页"，连点五张卡片收藏就是五次全量 list。
 * 断言用假时钟：不能真等 120ms，也不能让测试依赖机器快慢。
 */
describe('makeBroadcaster 的 itemsChanged 合并窗口', () => {
  function fakeWindow() {
    const sent: string[] = [];
    return { sent, win: { isDestroyed: () => false, webContents: { send: (ch: string) => sent.push(ch) } } };
  }

  it('窗口内多次调用只发一次', () => {
    const { sent, win } = fakeWindow();
    let t = 1000;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const bc = makeBroadcaster(() => win as never, {
      coalesceMs: 120,
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, at: t + ms }); return timers.length as never },
      clearTimeout: (h: unknown) => { const i = (h as number) - 1; if (timers[i]) timers[i] = { fn: () => {}, at: -1 } },
    });
    bc.itemsChanged();
    bc.itemsChanged();
    bc.itemsChanged();
    expect(sent).toEqual([]);            // 合并期内一条都不发
    timers[2].fn();
    expect(sent).toHaveLength(1);        // 到点只发一次
  });

  it('其它事件不受合并影响（toast / settingsChanged 必须即时）', () => {
    const { sent, win } = fakeWindow();
    const bc = makeBroadcaster(() => win as never, { coalesceMs: 120, setTimeout: () => 1 as never, clearTimeout: () => {} });
    bc.toast('收藏成功', 'ok');
    expect(sent).toHaveLength(1);
  });

  it('窗口结束后再调会重新开一轮（长期变更不能被永久静音）', () => {
    const { sent, win } = fakeWindow();
    const timers: Array<{ fn: () => void }> = [];
    let t = 0;
    const bc = makeBroadcaster(() => win as never, {
      coalesceMs: 120,
      now: () => t,
      setTimeout: (fn: () => void) => { timers.push({ fn }); return timers.length as never },
      clearTimeout: () => {},
    });
    bc.itemsChanged();
    timers[0].fn();                       // 第一轮到点发出
    expect(sent).toHaveLength(1);
    bc.itemsChanged();                    // 第二轮必须重新排队，而不是永久静音
    expect(timers).toHaveLength(2);
    timers[1].fn();
    expect(sent).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/ipc.spec.ts -t "合并窗口" 2>&1 | tail -20`
Expected: FAIL —— "Window-内多次调用只发一次" 收到 3 条（当前无合并）

- [ ] **Step 3: 写最小实现**（替换 `makeBroadcaster`）

```ts
export interface BroadcasterOptions {
  /** 合并窗口：0 = 关闭合并，每条都即时发（测试与需要严格顺序的调用方用）。 */
  coalesceMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * 事件出口。
 *
 * ★ itemsChanged 带 120ms 合并窗口：主进程有 24 个调用点，渲染层收到就重拉整页，
 *   批量操作（收藏 N 条 / 删除 N 条 / 连续复制）会在同一秒打出十几次全量 list，
 *   界面就在那儿闪。合并的是**信号**不是数据 —— 反正渲染层拿到信号后拉的是最新全量，
 *   中间态没有信息量，丢中间帧不丢正确性。
 * ★ 其它事件一律即时：toast 迟到 120ms 用户会觉得"点了没反应"，settingsChanged
 *   合并会把两次不同载荷压成一次随机载荷。
 */
export function makeBroadcaster(
  getWindow: () => Electron.BrowserWindow | null,
  opts: BroadcasterOptions = {},
): Broadcaster {
  const coalesceMs = typeof opts.coalesceMs === 'number' && Number.isFinite(opts.coalesceMs)
    ? Math.max(0, opts.coalesceMs)
    : ITEMS_CHANGED_COALESCE_MS;
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h));

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const itemsChanged = (): void => {
    if (coalesceMs === 0) { send(EV.itemsChanged); return; }
    if (pending !== null) return; // 合并期内后来的调用只是"再确认一次有变更"
    pending = setT(() => {
      pending = null;
      send(EV.itemsChanged);
    }, coalesceMs);
  };

  return {
    send,
    itemsChanged,
    settingsChanged: (settings) => send(EV.settingsChanged, settings),
    ghostChanged: (ghost) => send(EV.ghostChanged, ghost),
    toast: (message, kind = 'info') => send(EV.toast, { message, kind }),
    burstHint: (hint) => send(EV.burstHint, hint),
    aiChanged: () => send(EV.aiChanged),
    aiOptimizeDelta: (requestId, text) => send(EV.aiOptimizeDelta, { requestId, text }),
  };
}
```

并在文件顶部加常量与 import（`clearTimeout` 是全局，无需 import）：

```ts
/** 两条 itemsChanged 之间的最小合并窗口：与 AI 增量通道同源的一个数量级，够吃掉一次批量操作。 */
export const ITEMS_CHANGED_COALESCE_MS = 120;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/ipc.spec.ts 2>&1 | tail -12`
Expected: PASS（含既有 toIpcError 用例）

- [ ] **Step 5: 全量门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/ipc.ts packages/desktop/electron/ipc.spec.ts
git commit -m "perf(ipc): itemsChanged 加 120ms 合并窗口，批量操作不再触发十几次全量重拉"
```

**风险与回滚：** 合并窗口意味着"变更后最多晚 120ms 才刷新"。如果某个流程要求**写完立刻读到**（撤销提示、批量删除后的空状态），它本来也是走 invoke 返回值而不是事件，不受影响；`coalesceMs: 0` 是留好的逃生阀。

---

## Task 3: 迁移失败不再等于"启动失败"（T-M7，Major，最脆的一环）

**问题：** `db.ts` 的 `openDb` 里 `raw.exec(SCHEMA_SQL)`（约 1031 行）、`ensureColumns(raw)`（约 1034 行）、`migrateTrashSchema(raw)`（约 1037 行）三处**没有就近 catch**（只有 WAL 那段有）。异常一路冒泡到 `main.ts:1987` 的 `whenReady().catch` → `dialog.showErrorBox('启动失败')`。用户升级失败时：窗口不出现、没有任何兜底、库文件状态未知。审计原话："升级失败直接启动失败，是最脆且唯一没兜底的环节"。

**Files:**
- Modify: `packages/desktop/electron/db.ts`（`openDb` 迁移段 + 新错误类型）
- Modify: `packages/desktop/electron/main.ts`（`setupStorage` 捕获迁移失败 → 保底备份 + 可读文案）
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Consumes: `openDb(file: string): Db` 现有签名
- Produces:
  - `export class SchemaMigrationError extends Error { readonly cause: unknown; readonly dbFile: string; readonly backupFile: string | null }`
  - `describeMigrationFailure(e: unknown): string | null`（纯函数，把该错误翻成中文文案；不是迁移错误就返回 null）

- [ ] **Step 1: 写失败测试**（追加到 `db.spec.ts`）

```ts
import { SchemaMigrationError, describeMigrationFailure } from './db';

/**
 * ★ T-M7：迁移失败必须"保住数据 + 说人话"，而不是把进程炸掉。
 * 这里用一个一定会失败的迁移注入：SCHEMA_SQL 之前把 items 表替换成缺列的形态，
 * 于是 ensureColumns 之后的索引语句必然抛 no such column。
 */
describe('迁移失败兜底', () => {
  it('★ 迁移抛错时：库文件先留一份备份，错误包成 SchemaMigrationError（原始消息保留）', () => {
    const dir = tmpDir();
    const file = join(dir, 'clipchan.db');
    // 造一个"看起来像 v0.2.0 但结构坏掉"的库：有 items 表，但把 seq 列改名，
    // 让迁移尾部的 CREATE INDEX ... ON items(seq) 直接失败。
    const seed = new Database(file);
    seed.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT,
      content_hash TEXT, image_path TEXT, image_hash TEXT, thumb_path TEXT, width INTEGER,
      height INTEGER, bytes INTEGER, source TEXT, pinned INTEGER DEFAULT 0,
      truncated INTEGER DEFAULT 0, created_at INTEGER NOT NULL, seq_BROKEN INTEGER NOT NULL,
      deleted_at INTEGER, source_app TEXT, file_paths TEXT, rich_html TEXT, search_index TEXT,
      tags TEXT, folder_id TEXT, phash TEXT);`);
    seed.pragma('user_version = 0');
    seed.close();

    let caught: unknown = null;
    try { openDb(file); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(SchemaMigrationError);
    const err = caught as SchemaMigrationError;
    expect(err.dbFile).toBe(file);
    expect(err.backupFile).not.toBeNull();
    expect(existsSync(err.backupFile!)).toBe(true);      // 用户的库还在
    expect(/seq/.test(err.message) || /no such column/i.test(String(err.cause))).toBe(true);
  });

  it('describeMigrationFailure 给出中文文案，非迁移错误返回 null', () => {
    const err = new SchemaMigrationError('step', 'no such column: seq', 'C:\\x\\clipchan.db', 'C:\\x\\backup.db');
    expect(describeMigrationFailure(err)).toContain('历史数据已保留');
    expect(describeMigrationFailure(new Error('别的'))).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "迁移失败兜底" 2>&1 | tail -20`
Expected: FAIL —— `SchemaMigrationError` 未从 `./db` 导出（undefined）

- [ ] **Step 3: 实现**

`db.ts` 里，在 `openDb` 之前加：

```ts
/**
 * 迁移失败。★ 与"库损坏"是两件事：损坏是文件本身读不出页（走 storage-guard 的备份恢复），
 * 迁移失败是文件能读、但我们的 DDL 在它上面跑不通（升级事故）。
 * 用户需要知道的是"数据还在哪"，不是 SQLite 的英文错误串。
 */
export class SchemaMigrationError extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown,
    readonly dbFile: string,
    readonly backupFile: string | null,
  ) {
    super('迁移步骤「' + step + '」失败：' + (cause instanceof Error ? cause.message : String(cause)));
    this.name = 'SchemaMigrationError';
  }
}

/** 把迁移失败翻成给用户看的一句话；不是迁移错误就返回 null 让调用方走原路径。 */
export function describeMigrationFailure(e: unknown): string | null {
  if (!(e instanceof SchemaMigrationError)) return null;
  return e.backupFile
    ? '数据库升级失败。你的历史数据已原样保留，并另存了一份到 ' + e.backupFile
      + '。程序将带着旧数据结构继续运行 —— 如果列表打不开，请用备份文件替换 clipchan.db 后再启动。'
    : '数据库升级失败（' + e.step + '），且备份也没写成。请确认 ' + e.dbFile + ' 所在磁盘可写、有剩余空间。';
}
```

`openDb` 里三段包起来（保持原顺序与注释）：

```ts
  // ★ 三段迁移任何一步失败，都必须先把用户的库文件留在原地（只读复制一份），
  //   再抛带备份路径的错误。绝不"就地失败"让半改的 schema 悬在那里。
  const migrate = (step: string, fn: () => void): void => {
    try {
      fn();
    } catch (cause) {
      let backupFile: string | null = null;
      try {
        if (file !== ':memory:') {
          backupFile = path.join(path.dirname(file), 'clipchan-migration-failed-' + Date.now() + '.db');
          fs.copyFileSync(file, backupFile);
        }
      } catch {
        backupFile = null; // 备份也写不成：仍然要抛出，只是没有备份可指
      }
      try {
        raw.close(); // Windows 上不关句柄，调用方连改名/替换文件都做不了
      } catch { /* 已关闭 */ }
      throw new SchemaMigrationError(step, cause, file, backupFile);
    }
  };

  migrate('schema', () => raw.exec(SCHEMA_SQL));
  migrate('补列', () => ensureColumns(raw));
  migrate('索引与回收站', () => migrateTrashSchema(raw));
```

`main.ts` 的 `setupStorage` 里，把 `const db = openDb(dbPath)` 换成：

```ts
  let db: Db;
  try {
    db = openDb(dbPath);
  } catch (e) {
    const human = describeMigrationFailure(e);
    if (human === null) throw e;            // 不是迁移错误（例如真损坏）→ 走既有 storage-guard/兜底路径
    logError('[db] ' + human);
    // ★ 迁移失败不再让应用起不来：库里数据还在，用户至少能用托盘、导出、找回备份。
    //   带着旧 schema 继续跑 = 列表可能读不到新列，所以这里降级为"只保留数据不保留功能"，
    //   由后面的 ready 流程用 db === null 的既有分支处理（见 needDb() 的抛错文案）。
    dbRecoveryHint = human;
    db = openDbReadOnlyFallback(dbPath);    // 见 Step 4
  }
```

Step 4（同任务内）：新增局部函数 `openDbReadOnlyFallback(file)` —— 用 `new Database(file, { readonly: true })` 包一个最小可用句柄，或直接返回 `null` 并把 `rt.db` 置空。二选一：本仓库已有 `needDb()` 在 `rt.db` 为空时抛中文错误，所以**实现取"留空 + 首屏 toast"**，`openDbReadOnlyFallback` 不引入；把上面代码里的 `db = openDbReadOnlyFallback(dbPath)` 改为 `db = null as unknown as Db`，并在 `rt.db = db` 之后：

```ts
    if (dbRecoveryHint) {
      rt.db = null;                       // needDb() 会给所有 IPC 返回中文错误，界面仍能起
      recoveredFromDb = recoveredFromDb ?? undefined;
      logWarn('[db] 以降级模式启动：所有读写历史的入口会提示"数据库未完成升级"');
    }
```

（落地时以"窗口能起来、提示能看懂、数据没丢"为验收点，不追求降级模式下功能可用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts 2>&1 | tail -14`
Expected: PASS（迁移兜底 2 条 + 既有 130+ 条）

- [ ] **Step 5: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/main.ts packages/desktop/electron/db.spec.ts
git commit -m "fix(db): 迁移失败先留备份再抛 SchemaMigrationError，应用降级启动而不是弹窗退出"
```

---

## Task 4: 同名同级文件夹不再静默并存（T-N6，Minor，但与设计审计同族）

**问题：** `folders` 没有 `UNIQUE(name, parent_id)`（`db.ts:118-125`），`createFolder`（`db.ts:1737-1753`）在三种情况下**静默原样返回**（空名 / 父不存在 / 深度超限）。用户点"新建"像没反应。审计把这条与上一轮设计审计的"操作没反馈"归为同一族。

**Files:**
- Modify: `packages/desktop/electron/db.ts`（`FOLDER_SQL` 附近加索引、`createFolder`/`renameFolder` 判重并抛中文错误）
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Consumes: `FolderDTO`、`api.listFolders()` 现有形状
- Produces: `createFolder` / `renameFolder` 在重名时抛 `Error('同级已有同名文件夹「X」')`；空名仍然静默返回（既有注释明确说"敲空格回车不该弹错误框"，不动它）

- [ ] **Step 1: 写失败测试**

```ts
describe('文件夹同级重名（T-N6）', () => {
  it('★ 同名同级第二次创建要报错，不同父级下同名仍然允许', () => {
    const db = mem();
    const p1 = db.createFolder({ name: '工作', parentId: null });
    const p2 = db.createFolder({ name: '私人', parentId: null });
    expect(() => db.createFolder({ name: '工作', parentId: null })).toThrow('同级已有同名文件夹');
    const childName = p2.find((f) => f.name === '私人')!;
    const withParent = db.createFolder({ name: '工作', parentId: childName.id });
    expect(withParent.some((f) => f.name === '工作' && f.parentId === childName.id)).toBe(true);
    expect(p1).toHaveLength(2); // 报错那次的确没写进去
  });

  it('rename 撞同名同样报错，且原表不变', () => {
    const db = mem();
    db.createFolder({ name: 'A', parentId: null });
    const b = db.createFolder({ name: 'B', parentId: null }).find((f) => f.name === 'B')!;
    expect(() => db.renameFolder(b.id, 'A')).toThrow('同级已有同名文件夹');
    expect(db.listFolders().find((f) => f.id === b.id)!.name).toBe('B');
  });

  it('空名仍然静默返回原表（不弹错误框，既有约定）', () => {
    const db = mem();
    db.createFolder({ name: 'A', parentId: null });
    expect(db.createFolder({ name: '   ', parentId: null })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "同级重名" 2>&1 | tail -16`
Expected: FAIL —— 第二次 `createFolder` 没抛，返回 3 条

- [ ] **Step 3: 实现**

`FOLDER_SQL` 之后（迁移尾部，理由同 Global Constraints 的索引规则）：

```ts
  // ★ 同级重名判定的查询索引（不是 UNIQUE 约束）：老库里可能已经存在同名同级文件夹，
  //   建 UNIQUE 索引会直接抛并且没法自愈；判重交给代码，索引只让它别扫全表。
  raw.exec('CREATE INDEX IF NOT EXISTS idx_folders_name ON folders(name, parent_id)');
```

`createFolder` 内，在 `canMoveFolder` 检查之后、`INSERT` 之前插入：

```ts
      // ★ 同级重名 → 明确报错，不再"静默原样返回"。用户点了新建却多出两个同名文件夹，
      //   比直接告诉他重名更难排查。（空名仍然是静默返回：那是输入框里的一个空格，
      //   弹错误框才是打扰 —— 见本函数顶部的既有注释。）
      const clash = raw
        .prepare('SELECT id FROM folders WHERE name = ? AND (parent_id IS ? OR parent_id = ?)')
        .get(name, parentId, parentId);
      if (clash) throw new Error('同级已有同名文件夹「' + name + '」，换个名字或建到别的文件夹下');
```

`renameFolder` 同样处理：先取当前行的 `parent_id`，再判重，然后 `UPDATE`。

渲染层不需要改：`store.ts` 的 `createFolder`/`renameFolder` 已经在 `catch` 里 `toast(errorText(err), 'error')`，中文消息会直接显示。

- [ ] **Step 4: 跑测试确认通过 + 门禁 + 提交**

```bash
pnpm vitest run packages/desktop/electron/db.spec.ts 2>&1 | tail -8
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/db.spec.ts
git commit -m "fix(db): 同级重名文件夹改为明确报错并加判重索引，静默失败不再吞掉用户操作"
```

---

## Task 5: `url_previews` 只增不减（T-M6，Major）

**问题：** 全仓 `DELETE FROM url_previews` **0 处**；TTL 只在读取时判（`main.ts:1489` `URL_PREVIEW_TTL_MS = 7 天`、`main.ts:1507` 读时比较），过期行既不删也不限量 —— 每复制一个链接就永久长一行。

**Files:**
- Modify: `packages/desktop/electron/db.ts`（`upsertUrlPreview` 约 1855-1872 行 + 新增 `pruneUrlPreviews`）
- Modify: `packages/desktop/electron/main.ts`（TTL 常量移到 db.ts 导出，避免两处定义）
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Consumes: `UrlPreviewInput`
- Produces: `export const URL_PREVIEW_TTL_MS`、`export const URL_PREVIEW_MAX_ROWS`、`Db.pruneUrlPreviews(nowMs?: number): { expired: number; overflow: number }`；`upsertUrlPreview` 内部写后顺手剪（有上限，不做无界扫描）

- [ ] **Step 1: 写失败测试**

```ts
describe('url_previews 淘汰（T-M6）', () => {
  const put = (db: Db, url: string, fetchedAt: number) =>
    db.upsertUrlPreview({ url, title: 't', domain: 'd.com', iconUrl: '', fetchedAt });

  it('★ 过期行按 TTL 删掉，未过期留着', () => {
    const db = mem();
    const now = 1_700_000_000_000;
    put(db, 'https://a.com/1', now - URL_PREVIEW_TTL_MS - 1); // 过期
    put(db, 'https://a.com/2', now - 1000);                    // 新鲜
    expect(db.getUrlPreviews(['https://a.com/1', 'https://a.com/2'])).toHaveLength(2);
    const res = db.pruneUrlPreviews(now);
    expect(res.expired).toBe(1);
    expect(db.getUrlPreviews(['https://a.com/1'])).toHaveLength(0);
    expect(db.getUrlPreviews(['https://a.com/2'])).toHaveLength(1);
  });

  it('★ 超出行数上限时留最新的那些', () => {
    const db = mem();
    const now = 1_700_000_000_000;
    for (let i = 0; i < URL_PREVIEW_MAX_ROWS + 20; i++) put(db, 'https://a.com/' + i, now - i);
    const res = db.pruneUrlPreviews(now);
    expect(res.overflow).toBe(20);
    expect(db.getUrlPreviews(Array.from({ length: URL_PREVIEW_MAX_ROWS + 20 }, (_, i) => 'https://a.com/' + i))
      .toHaveLength(URL_PREVIEW_MAX_ROWS));
  });

  it('同 URL 再写只更新一行（upsert 语义不退化成堆积）', () => {
    const db = mem();
    put(db, 'https://a.com/x', 1_600_000_000_000);
    put(db, 'https://a.com/x', 1_700_000_000_000);
    expect(db.getUrlPreviews(['https://a.com/x'])).toHaveLength(1);
    expect(db.getUrlPreviews(['https://a.com/x'])[0].fetchedAt).toBe(1_700_000_000_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "url_previews" 2>&1 | tail -16`
Expected: FAIL —— `URL_PREVIEW_TTL_MS` / `pruneUrlPreviews` 未导出

- [ ] **Step 3: 实现**

`db.ts` 顶部常量区：

```ts
/** 链接预览缓存的新鲜期：超过就没必要再显示旧标题（与 main.ts 读时判定同一个数，别再两处定义）。 */
export const URL_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存行数上限：一条 URL 一行，5000 行足够覆盖日常复制，超出就丢最旧的（缓存而已，可重建）。 */
export const URL_PREVIEW_MAX_ROWS = 5000;
```

`Db` 接口加：

```ts
  /** 删过期 + 限量淘汰缓存；返回两类计数。nowMs 可注入（测试用假时钟）。 */
  pruneUrlPreviews(nowMs?: number): { expired: number; overflow: number };
```

实现（放在 `upsertUrlPreview` 旁边）：

```ts
    pruneUrlPreviews(nowMs?: number): { expired: number; overflow: number } {
      const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
      const expired = raw.prepare('DELETE FROM url_previews WHERE fetched_at < ?').run(now - URL_PREVIEW_TTL_MS).changes;
      // 只删一个数就够：MAX_ROWS 之外的部分不可能同时"未过期又用不上"，
      // 分两步删（先 TTL 后限量）比一条 SQL 写两套谓词更好读，也各自可测。
      const overflow = raw
        .prepare(
          `DELETE FROM url_previews
            WHERE url NOT IN (SELECT url FROM url_previews ORDER BY fetched_at DESC LIMIT ?)`,
        )
        .run(URL_PREVIEW_MAX_ROWS).changes;
      return { expired, overflow };
    },
```

并在 `upsertUrlPreview` 的 INSERT 之后调用一次（写侧自己收口，不指望调用方记得剪）：

```ts
      // ★ 写侧顺手剪：这张表只有 upsert 没有读侧淘汰就永远只增（T-M6）。
      //   放在这里而不是每次列表查询里，因为它只在"确实新增了一条预览"时被触发。
      api.pruneUrlPreviews();
```

`main.ts` 删掉本地的 `URL_PREVIEW_TTL_MS` 常量定义，改为从 `./db` import（避免两处数字漂移）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts packages/desktop/electron/qrcode.spec.ts 2>&1 | tail -10`

- [ ] **Step 5: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/main.ts packages/desktop/electron/db.spec.ts
git commit -m "fix(db): url_previews 按 TTL 与行数上限淘汰，写侧自动收口"
```

---

## Task 6: 最热写路径的 `prepare` 上移（T-M8，Major，quick-win）

**问题：** `db.ts` 71 处 `prepare`，跨调用复用的**一个都没有**（都在闭包函数体内），其中包含每次复制都要走的 insert / 去重查询 / 淘汰。`restoreOne`（`db.ts:1143`）在函数体内 prepare，却被 `restoreMany`（`db.ts:1482-1490`）循环逐条调用 = N 次 prepare。

**Files:**
- Modify: `packages/desktop/electron/db.ts`
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Consumes: `openDb` 作用域内的 `raw`
- Produces: `const stmt = { ... }`（openDb 作用域内的静态语句缓存），`restoreOne(conn, id)` → `restoreOne(statement, id)`

- [ ] **Step 1: 先量出当前代价，别盲改**（审计自己也承认"better-sqlite3 是否内部缓存 statement 未查证"——所以第一步是查证，不是优化）

```bash
node -e "const D=require('./packages/desktop/node_modules/better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE t(a TEXT PRIMARY KEY, b INTEGER)');const sql='INSERT INTO t(a,b) VALUES(?,?)';let s=process.hrtime.bigint();for(let i=0;i<20000;i++){db.prepare(sql).run('k'+i,i)}const perPrep=Number(process.hrtime.bigint()-s)/20000/1000;s=process.hrtime.bigint();const p=db.prepare(sql);for(let i=0;i<20000;i++){p.run('k2'+i,i)}const perReuse=Number(process.hrtime.bigint()-s)/20000/1000;console.log('每次 prepare 约',perPrep.toFixed(2),'us;复用同一 statement 约',perReuse.toFixed(2),'us;差值',(perPrep-perReuse).toFixed(2),'us/次');db.close();"
```

Expected: 打印两个耗时。**若差值 < 1µs，本任务关掉，只在代码里记一行结论**（这是审计明确标为"强推断"的条目，先证伪再动手）。

- [ ] **Step 2: 写回归测试（锁语义，不锁性能）**

```ts
describe('prepare 上移不改语义（T-M8）', () => {
  it('★ restoreMany 里每一条都各自成功/失败，计数与逐条 restore 一致', () => {
    const db = mem();
    const ids = ['x', 'y', 'z'].map((t, i) => db.insertText('批量恢复' + t, { now: 1700000000000 + i }).id);
    for (const id of ids) db.remove(id);
    // 掺一个不存在的 id：循环里 prepare 上移后，这条必须仍然返回 0 而不是把整批带崩
    expect(db.restoreMany([...ids.slice(0, 2), '不存在'])).toBe(2);
    expect(db.count()).toBe(2);
  });

  it('同一张表连续 insert 仍然走去重语义（statement 复用不能把参数粘住）', () => {
    const db = mem();
    const a = db.insertText('同一段', { now: 1700000000000 });
    const b = db.insertText('同一段', { now: 1700000001000 });
    expect(b.touched).toBe(true);
    expect(b.id).toBe(a.id);
    expect(db.count()).toBe(1);
  });
});
```

- [ ] **Step 3: 实现（只做静态 SQL、最热的那几条；动态拼接的三条明确不动）**

`openDb` 内、`api` 定义之前：

```ts
  /**
   * ★ T-M8：静态 SQL 的 statement 在 openDb 作用域里预编译一次。
   * 判据不是"看起来快"：Step 1 实测 prepare 与复用的单条差值 × 每天几千次复制 = 可省掉的固定开销。
   * 只收静态语句：`:1261 / :1274 / :843` 那几条按 where 子句拼出来，天然无法预编译，
   * 硬凑缓存会引入"SQL 变了但 statement 没变"的错。
   */
  const stmt = {
    insertItemText: raw.prepare(`INSERT INTO items (...) VALUES (...)`),   // 用现有那条原文
    selectIdByContentHash: raw.prepare('SELECT id FROM items WHERE content_hash = ? AND deleted_at IS NULL'),
    selectIdByImageHash: raw.prepare('SELECT id FROM items WHERE image_hash = ? AND deleted_at IS NULL'),
    nextSeq: raw.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items'),
    touchRow: raw.prepare('UPDATE items SET created_at = ?, seq = ? WHERE id = ?'),
    restoreOne: raw.prepare('UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'),
    deleteById: raw.prepare('DELETE FROM items WHERE id = ?'),
  };
```

（逐条从现有代码里搬**同一份 SQL 文本**，不重写：`insertText`、`insertImage`、`insertFiles`、`nextSeqOf`、`touchRow`、`restoreOne`、`purgeTrashOverLimit`、`purge`。）

配套改动：

```ts
  // restoreOne 从 (conn, id) 改成接收预编译 statement：调用点 restore / restoreMany 各一处。
  function restoreOne(s: Database.Statement, id: string): number {
    return s.run(id).changes;
  }
```

`nextSeqOf(raw)` 现在必须能拿到 `stmt.nextSeq` —— 它在 `openDb` 之外（模块级 `db.ts:548`）。两种落地方式，取后者：
- ✗ 把 `nextSeqOf` 改成接收 statement：会牵动 `migrate.ts` 等外部调用点。
- ✓ 保留 `nextSeqOf(raw)` 作为模块级函数，另在 `openDb` 作用域里加 `const nextSeq = () => Number((stmt.nextSeq.get() as { m: number }).m) + 1;`，把 `api` 内部 4 处调用（`db.ts:1144 / :1176 / :1224 / :1007` 附近）换成本地 `nextSeq()`。外部调用方继续走 `nextSeqOf(raw)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts 2>&1 | tail -10`
Expected: PASS（含既有全部 130+ 条 —— 本任务的行为契约就是"什么都没变"）

- [ ] **Step 5: 用观测面复测写路径耗时**

`CLIPCHAN_PERF_MS=1 pnpm dev` → 复制一张图 → 日志里「写库（含去重与上限淘汰）」的毫秒数应与改动前同量级或更低。**没有下降就回滚本任务**（数据驱动，不为改动而改动）。

- [ ] **Step 6: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/db.spec.ts
git commit -m "perf(db): 静态 SQL 的 statement 预编译复用，restoreMany 不再逐条 prepare"
```

---

## Task 7: 结构化搜索一次读 20000 行 × 两遍（T-M1，Major）

**问题：** `db.ts:859` `SEARCH_SCAN_LIMIT = 20000`，`scanByExpr`（`db.ts:869-890`）`SELECT *` 把候选全读进 JS 再逐行 `matchSearch`；带表达式的查询里 `list()`（`db.ts:1370`）和 `count()`（`db.ts:1386`）**各扫一遍**（注释自己也写了"与 list 共用 scanByExpr"，共用的是函数、不是结果）。`store.ts:484` 用 `Promise.all` 同时发 list 与 count —— 于是每次搜索两轮 20000 行。

**Files:**
- Modify: `packages/desktop/electron/db.ts`（新增 generation + 候选缓存；`scanByExpr` 列裁剪）
- Modify: `packages/desktop/electron/channels.ts`、`preload.ts`、`packages/core/src/platform/adapter.ts`、`packages/core/src/state/store.ts`、`packages/desktop/electron/main.ts`（新增一次返回"页 + 总数"的通道）
- Test: `packages/desktop/electron/db.spec.ts`、`packages/core/src/state/store.spec.ts`

**Interfaces:**
- Consumes: `ListQuery`（含 `expr`）、现有 `buildWhere`
- Produces:
  - `Db.searchPage(q: ListQuery): { items: ClipItemDTO[]; total: number }`
  - 通道 `CH.items.searchPage = 'items:searchPage'`，preload `items.searchPage(q)`，adapter 缺省拒绝文案 `'当前环境没有实现 items.searchPage'`
  - `store.ts` 的 `load()` 在 `query.expr` 存在时改调 `searchPage`

- [ ] **Step 1: 写失败测试（先测 db 层的"扫一遍"）**

```ts
describe('★ T-M1：带表达式的搜索只扫一遍候选', () => {
  it('searchPage 的 total 与 list/count 同一套命中集合（不能一边 3 条一边 5 张卡）', () => {
    const db = mem();
    for (let i = 0; i < 12; i++) db.insertText('合同 第' + i + '份', { now: 1700000000000 + i });
    db.insertText('完全无关的内容', { now: 1700000099000 });
    const expr = parseSearch('合同 AND 第3份').expr!;
    const page = db.searchPage({ expr, limit: 10, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    // 三者必须永远一致：这是本仓库已经写在注释里的既有契约，改实现不能改契约
    expect(db.list({ expr, limit: 10 })).toHaveLength(1);
    expect(db.count({ expr })).toBe(1);
  });

  it('★ 扫过的行数只统计一次：第二次调用不再触发候选扫描', () => {
    const db = mem();
    for (let i = 0; i < 50; i++) db.insertText('发票' + i, { now: 1700000000000 + i });
    const expr = parseSearch('发票').expr!;
    let scans = 0;
    const orig = db.raw.prepare.bind(db.raw);
    (db.raw as unknown as { prepare: unknown }).prepare = ((sql: string, ...rest: unknown[]) => {
      if (/FROM items WHERE/.test(sql)) scans += 1;
      return (orig as (s: string, ...r: unknown[]) => unknown)(sql, ...rest);
    }) as unknown;
    const q = { expr, limit: 10, offset: 0 };
    db.searchPage(q); db.searchPage(q);
    (db.raw as unknown as { prepare: unknown }).prepare = orig;
    expect(scans).toBeLessThanOrEqual(2);   // 一次候选扫描 + 一次按 id 取展示行，绝不该是 4
  });

  it('★ 任何写入都会让上一轮候选缓存作废（缓存不能把新记录藏起来）', () => {
    const db = mem();
    const expr = parseSearch('新来的').expr!;
    expect(db.searchPage({ expr }).total).toBe(0);
    db.insertText('新来的记录', { now: 1700000999000 });
    expect(db.searchPage({ expr }).total).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "T-M1" 2>&1 | tail -16`
Expected: FAIL —— `db.searchPage is not a function`

- [ ] **Step 3: db 层实现**

`scanByExpr` 顶部加列裁剪（只选判定要用的列 + 排序键；展示字段命中后再按 id 取）：

```ts
/**
 * 候选扫描只需要三列正文 + 排序键，所以不再 SELECT *。
 * ★ 原实现把 23 列全搬回 JS（含图片行永远读不到的 rich_html / file_paths），
 *   20000 行时那是纯白付的内存与反序列化 —— 审计 T-M1 的另一半。
 */
const SCAN_COLUMNS = 'id, kind, content, search_index, image_path, thumb_path, width, height, bytes, created_at, seq, pinned';
```

`openDb` 作用域内加缓存与代数计数：

```ts
  /**
   * ★ 候选缓存（T-M1）：list 与 count 是同一轮用户操作里的两次调用（store.ts 用 Promise.all），
   *   共用一份命中集合就把"扫两遍 20000 行"降成一遍。
   * ★ 作废条件必须是全部写路径：generation 由 touchRow/insert*/remove*/purge*/setFolder/setTags
   *   这些改 items 表的出口统一自增（见 Step 4 的 wrap 写法），漏一个就是"搜不到刚复制的东西"。
   *   只留 1 条缓存，不做 LRU —— 搜索是连续打字，1 条就够；多条缓存会放大作废遗漏的爆炸半径。
   */
  let generation = 0;
  let scanCache: { key: string; gen: number; hits: ItemRow[] } | null = null;
  const bumpGen = (): void => { generation += 1; scanCache = null; };
```

`scanByExpr` 改成接收 `(raw, q, where, params, cache)`，命中后写 cache；`api` 里：

```ts
    searchPage(q: ListQuery = {}): { items: ClipItemDTO[]; total: number } {
      if (q.expr === undefined) {
        // 无表达式：SQL 直接能算分页与总数，走原路径，别把缓存机制硬套进来
        const items = api.list(q);
        const total = api.count(q);
        return { items, total };
      }
      const hits = scanByExprCached(raw, q, ...buildWhere(q));
      const { limit, offset } = clampPage(q);
      const pageIds = hits.slice(offset, offset + limit).map((r) => r.id);
      // 命中集只有 id 和排序键；展示字段按 id 一次批量取回（最多 limit 行，不是 20000 行）
      return { items: api.rowsByIds(pageIds), total: hits.length };
    },
```

新增 `Db.rowsByIds(ids: string[]): ClipItemDTO[]`（`SELECT <DTO 所需列> WHERE id IN (...)`，保持传入顺序 —— 分页顺序由候选集决定，不能被 SQL 的排序打乱；测试：`rowsByIds` 返回顺序 === 入参顺序）。

- [ ] **Step 4: 所有写出口挂 `bumpGen()`**

逐个在 `insertText` / `insertImage` / `insertFiles` / `touchRow` / `remove` / `removeMany` / `togglePin` / `pinMany` / `clearUnpinned` / `clearAll` / `restore` / `restoreMany` / `purge` / `purgeTrashOverLimit` / `setFolder` / `setTags` / `emptyTrash` 的成功分支后调用 `bumpGen()`。**测试保护**：Step 1 第三条用例（写完立刻搜得到）就是这条的回归钉；再加一条"pin 之后候选里的 pinned 排序必须刷新"。

- [ ] **Step 5: IPC/preload/adapter/store 接线**

```ts
// channels.ts（items 组内，紧挨 searchPage 语义 neighbours）
    /** 带表达式的搜索：一次返回"这一页 + 总数"，避免 list 与 count 各扫一遍候选（T-M1）。 */
    searchPage: 'items:searchPage',

// main.ts handler 表
    [CH.items.searchPage]: (_e, q: ListQuery) => needDb().searchPage(q),

// preload.ts
    searchPage: (q: ListQuery): Promise<{ items: ClipItemDTO[]; total: number }> =>
      ipcRenderer.invoke(CH.items.searchPage, q),

// adapter.ts 缺省拒绝
    searchPage: () => Promise.reject(new Error('当前环境没有实现 items.searchPage')),
```

`store.ts:481-488` 改为：

```ts
      const query = listQuery(get(), 0);
      // 带表达式的查询一次拿回"页 + 总数"（同一个候选集，扫一遍）；
      // 普通查询仍走 list + count 两条（SQL 侧本来就便宜，且 count 失败要能单独兜 -1）。
      const [items, counted] = query.expr !== undefined
        ? await platform.items
            .searchPage(query)
            .then((r) => [r.items, r.total] as const)
            .catch(() => [await platform.items.list(query), -1] as const)
        : await Promise.all([
            platform.items.list(query),
            platform.items.count(query).catch(() => -1),
          ]);
```

- [ ] **Step 6: 跑测试确认通过 + store 层补一条**

`packages/core/src/state/store.spec.ts` 追加：

```ts
  it('★ 带表达式的查询只发一次 searchPage，不再 list+count 各发一次（T-M1）', async () => {
    const calls: string[] = [];
    setFakePlatform(calls);  // 用该文件既有的假平台写法
    useClipStore.getState().setQuery('合同 AND 第3份');
    await flush();
    expect(calls).toContain('items.searchPage');
    expect(calls.filter((c) => c === 'items.list')).toHaveLength(0);
  });
```

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts packages/core/src/state/store.spec.ts 2>&1 | tail -12`

- [ ] **Step 7: 真机验证搜索手感与耗时**

```bash
CLIPCHAN_PERF_MS=50 pnpm dev
```
在真实库里输入 `合同 AND 3`（以及一个非法日期 `after:2024-13-01`，既有 spec 钉过不崩），确认：条数与列表一致、翻页正常、第二页不是"候选里恰好命中的那几条"。

- [ ] **Step 8: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/channels.ts packages/desktop/electron/preload.ts \
        packages/desktop/electron/main.ts packages/core/src/platform/adapter.ts packages/core/src/state/store.ts \
        packages/desktop/electron/db.spec.ts packages/core/src/state/store.spec.ts
git commit -m "perf(search): 表达式搜索一次返回页与总数，候选扫描列裁剪并缓存，写路径统一作废"
```

---

## Task 8: 回收站分页与"清空回收站"的重复夹取（T-M2，Major）

**问题：** `db.ts:1455-1468` 的 `listTrash` 把 `clampPage` 的逻辑（`db.ts:834-840`）**又抄了一遍**，注释（`db.ts:798` 一带）却说"共用 clampPage"；`offset` 没有上界。`main.ts:827-838` 的 `emptyTrash` 用 `for (;;)` 以 `offset: ids.length` 反复扫 —— 每轮都要跳过前面已取过的行。

**Files:**
- Modify: `packages/desktop/electron/db.ts`（`listTrash` 复用 `clampPage`、`offset` 上界；新增 `allTrashIds()`）
- Modify: `packages/desktop/electron/main.ts`（`emptyTrash` 改一次取全）
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Produces: `Db.allTrashIds(): string[]`

- [ ] **Step 1: 写失败测试**

```ts
describe('回收站夹取与全量取 id（T-M2）', () => {
  const seedTrash = (db: Db, n: number) => {
    for (let i = 0; i < n; i++) {
      const id = db.insertText('回收站候选' + i, { now: 1700000000000 + i }).id;
      db.remove(id);
    }
  };

  it('★ offset 有上界：负数与超界 offset 不能把 SQL 打成非法值', () => {
    const db = mem();
    seedTrash(db, 3);
    expect(db.listTrash({ offset: -5 })).toHaveLength(3);          // 夹到 0
    expect(db.listTrash({ offset: Number.NaN })).toHaveLength(3);  // 非法值走默认
    expect(db.listTrash({ offset: 999999 })).toHaveLength(0);      // 超界返回空，不抛
    expect(db.listTrash({ limit: 99999 })).toHaveLength(3);        // 上限仍受 MAX_LIMIT 保护
  });

  it('allTrashIds 一次取全，不受 MAX_LIMIT=500 限制（旧实现要循环 500 条一轮）', () => {
    const db = mem();
    seedTrash(db, 620);
    expect(db.countTrash()).toBe(620);
    expect(db.allTrashIds()).toHaveLength(620);
    expect(new Set(db.allTrashIds()).size).toBe(620);             // 不能重复（旧循环靠 offset 前进，重复一次就多删一轮）
  });

  it('listTrash 与活跃列表互不污染（谓词相反，绝不能共用 buildWhere）', () => {
    const db = mem();
    db.insertText('还在列表里', { now: 1700000000000 });
    const gone = db.insertText('已进回收站', { now: 1700000001000 }).id;
    db.remove(gone);
    expect(db.listTrash({})).toHaveLength(1);
    expect(db.count()).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "回收站夹取" 2>&1 | tail -16`
Expected: FAIL —— `db.allTrashIds is not a function`

- [ ] **Step 3: 实现**

`listTrash` 复用夹取（把它的内联 clamp 换成 `clampPage`，并让谓词继续用自己的 `deleted_at IS NOT NULL`）：

```ts
    listTrash(q: { limit?: number; offset?: number } = {}): ClipItemDTO[] {
      // 谓词与 buildWhere 相反（只取已删），所以不复用它——复用只会让两边一起改坏。
      // ★ 但分页夹取必须复用 clampPage（T-M2）：抄第二遍的结果是两处上界规则各改各的，
      //   而注释已经写着"共用 clampPage"——撒谎的注释比没有注释更糟。
      const { limit, offset } = clampPage(q);
      const rows = raw
        .prepare(
          `SELECT <与 list 同一份列裁剪> FROM items WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC, seq DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as ItemRow[];
      return rows.map(rowToDto);
    },

    /** 回收站全量 id（一次取完，供"清空回收站"用；分页循环取会把 offset 越跳越贵）。 */
    allTrashIds(): string[] {
      return (
        raw
          .prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at ASC, seq ASC')
          .all() as { id: string }[]
      ).map((r) => r.id);
    },
```

`main.ts` 的 `emptyTrash` handler 换成：

```ts
    [CH.items.emptyTrash]: () => {
      const db = needDb();
      // ★ 一次取全（T-M2）：原来用 listTrash({limit:500, offset: ids.length}) 循环，
      //   每轮都要把前面已取过的行再跳过一遍，回收站越大越慢，而且 620 条要跑两轮 SQL。
      const ids = db.allTrashIds();
      if (ids.length === 0) return { removed: 0 };
      const { removed, log } = purgeItemsWithFiles(db, rt.dataDir, ids, (m) => logWarn('[images] ' + m));
      if (log.failures.length > 0) broadcast.toast('回收站已清空，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      return { removed };
    },
```

- [ ] **Step 4: 跑测试确认通过 + 门禁 + 提交**

```bash
pnpm vitest run packages/desktop/electron/db.spec.ts 2>&1 | tail -8
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/db.spec.ts packages/desktop/electron/main.ts
git commit -m "perf(trash): listTrash 复用 clampPage 夹取，清空回收站改一次取全 id"
```

---

## Task 8b: 文件夹写操作把带聚合的 `listFolders` 跑两遍（T-N5，Minor）

**问题：** `listFolders()`（`db.ts:1705`）带 `LEFT JOIN … GROUP BY folder_id` 的计数聚合，代价随记录数增长。而 `createFolder`（`db.ts:1737-1753`）先调一次拿校验用的表、写完再调一次返回新表；`renameFolder`（`db.ts:1755-1760`）、`moveFolder`、`removeFolder` 同样各两次。校验根本不需要"每个文件夹里有多少条记录"。

**Files:**
- Modify: `packages/desktop/electron/db.ts`
- Test: `packages/desktop/electron/db.spec.ts`

**Interfaces:**
- Consumes: `FolderDTO`（含 `itemCount` / `totalCount`）
- Produces: `folderSkeleton(): { id: string; name: string; parentId: string | null }[]`（模块内私有 helper，不开到 `Db` 接口上 —— 它只是校验用的内部件，暴露出去只会多一个没人该调的入口）

- [ ] **Step 1: 写失败测试**

```ts
describe('文件夹校验不再跑聚合查询（T-N5）', () => {
  /** 数一下 items↔folders 的聚合 JOIN 出现了几次（与 Task 6 同一个 prepare 计数技巧）。 */
  function countAggregateQueries(db: Db): () => number {
    let n = 0;
    const orig = db.raw.prepare.bind(db.raw);
    (db.raw as unknown as { prepare: unknown }).prepare = ((sql: string, ...rest: unknown[]) => {
      if (/GROUP BY folder_id|folder_id, COUNT/i.test(sql)) n += 1;
      return (orig as (s: string, ...r: unknown[]) => unknown)(sql, ...rest);
    }) as unknown;
    return () => n;
  }

  it('★ createFolder 全程只做一次聚合查询（返回新表那次），校验不查计数', () => {
    const db = mem();
    const reads = countAggregateQueries(db);
    db.createFolder({ name: '校验只查骨架', parentId: null });
    expect(reads()).toBe(1);   // 改动前是 2
  });

  it('校验仍然有效：父不存在时按既有约定当顶层，不抛（不能因为换查询就把行为改掉）', () => {
    const db = mem();
    const table = db.createFolder({ name: '孤儿父', parentId: '不存在的父' });
    const made = table.find((f) => f.name === '孤儿父')!;
    expect(made.parentId).toBeNull();
  });

  it('重名判定不受影响（与 Task 4 的判重共用同一张骨架表）', () => {
    const db = mem();
    db.createFolder({ name: '同名', parentId: null });
    expect(() => db.createFolder({ name: '同名', parentId: null })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts -t "T-N5" 2>&1 | tail -16`
Expected: FAIL —— 计数为 2

- [ ] **Step 3: 实现**

`db.ts` 里 `api` 定义之前（与 `listFolders` 放一起）：

```ts
  /**
   * 文件夹骨架（id / name / parent_id），**不带**记录计数。
   * ★ T-N5：createFolder / renameFolder / moveFolder / removeFolder 的校验只需要这三列，
   *   而 listFolders() 带一段 LEFT JOIN + GROUP BY folder_id 的聚合（代价随记录数涨），
   *   一次新建要跑两遍就白花了一遍聚合。返回新表那次（写完的）仍然是 listFolders()。
   */
  function folderSkeleton(): { id: string; name: string; parentId: string | null }[] {
    return (
      raw
        .prepare('SELECT id, name, parent_id AS parentId FROM folders ORDER BY created_at ASC, name ASC')
        .all() as { id: string; name: string; parentId: string | null }[]
    );
  }
```

四个写入口把"校验用的那次 `api.listFolders()`"换成 `folderSkeleton()`：

```ts
    createFolder(input: FolderInput): FolderDTO[] {
      const name = sanitizeTag(typeof input?.name === 'string' ? input.name : '');
      const skeleton = folderSkeleton();                       // ← 原来是 api.listFolders()
      if (name.length === 0) return api.listFolders();         // 返回值这一次才是必要的（契约就是"回新表"）

      const wanted = typeof input?.parentId === 'string' && input.parentId.length > 0 ? input.parentId : null;
      const parentId = wanted !== null && skeleton.some((f) => f.id === wanted) ? wanted : null;

      const id = randomUUID().replace(/-/g, '');
      // canMoveFolder 吃的是 OrganizeFolder（id/name/parentId 三列，无计数）——
      // 骨架表直接就能用，不需要 toOrganizeFolders(existing) 那次转换。
      const candidate: OrganizeFolder[] = [...skeleton, { id, name, parentId }];
      if (!canMoveFolder(candidate, id, parentId)) return api.listFolders();

      // Task 4 的同级重名判定也改用 skeleton（同样不需要计数）：
      if (candidate.some((f) => f.id !== id && f.parentId === parentId && f.name === name)) {
        throw new Error('同级已有同名文件夹「' + name + '」，换个名字或建到别的文件夹下');
      }

      raw.prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)').run(id, name, parentId, Date.now());
      return api.listFolders();
    },
```

`renameFolder` / `moveFolder` / `removeFolder` 同型处理：读校验用 `folderSkeleton()`，写完返回 `api.listFolders()` 一次。

> 若 Task 4 已落地，这里的重名判定就用 skeleton 版替代 Task 4 里那条 `SELECT id FROM folders WHERE name = ? AND …`（二选一，别留两条查同名的 SQL —— **执行时以本任务的 skeleton 版为准，并在 Task 4 的提交说明里指向这里**）。skeleton 已经带 name/parentId，判重是纯内存比较，省掉一次 SQL。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/db.spec.ts 2>&1 | tail -10`
Expected: PASS（含 v1.0.0 ⑥ 文件夹 CRUD 的既有用例，期望值不许改）

- [ ] **Step 5: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/db.ts packages/desktop/electron/db.spec.ts
git commit -m "perf(folders): 校验改查文件夹骨架，聚合计数每次写操作从两遍降到一遍"
```

---

## Task 9: 文本分支缺粗判层（T-N1，Minor，需实测）

**问题：** 图片分支有"格式 + 长度 + 前 4KB 哈希"的粗判，命中就**不调** `readImage()`（`watcher.ts:484-490`）；文本分支没有对应机制 —— 每 300ms 无条件 `readText()` 把整串读出来再 `===` 比较（`handleText` 开头）。剪贴板里躺着一段 10 万字时，每 300ms 就整串复制一次给 JS。

**Files:**
- Modify: `packages/desktop/electron/watcher.ts`（`handleText`）
- Test: `packages/desktop/electron/watcher.spec.ts`

**Interfaces:**
- Produces: `LastSeen.textLen: number`（与既有 `text` 并存；粗判只用长度，长度相同仍要读一次做全等判定，避免"长度相同内容不同"漏记）

- [ ] **Step 1: 先把量加进去，用它拿真实数字（这条本来就标着"需实测"）**

`watcher.ts` 的 `handleText` 第一行读取处，把裸调用换成计时调用（这段改动**就是最终代码的一部分**，不是临时脚手架）：

```ts
    const readStartedAt = Date.now();
    const text = this.clip.readText() ?? '';
    this.perf?.observe('读纯文本', Date.now() - readStartedAt);
```

然后真机量：

```bash
cd clipchan && CLIPCHAN_PERF_MS=0 pnpm dev
# 面板起来后，用 PowerShell 往剪贴板塞一段 10 万字文本，然后什么都不做，让轮询空跑 60 秒：
powershell -NoProfile -Command "Set-Clipboard -Value ('a' * 100000)"
# 读主进程日志里 [perf] 的两类行：慢操作那一行的「平均」，和 5 分钟后 [perf] 快照行的「读纯文本 次N 慢M 最慢Xms」
```

判定标准（提前定死，避免看完数据再找理由）：
- `读纯文本` 单次平均 **≥ 1ms**，或 60 秒内累计 **≥ 60ms**（≈ 每秒都在为一次没变化的剪贴板掏 1ms 以上）→ 继续 Step 2，落地粗判。
- 单次平均 **< 1ms** → **本任务关闭**：把实测数字写进 `handleText` 顶部的注释（例如"实测 10 万字空跑单次读取 0.4ms，300ms 一跳的占比 0.13%，加粗判层不值得"），只提交那一行注释，并跳到 Step 4。

- [ ] **Step 2: 写失败测试（若 Step 1 判定值得做）**

```ts
describe('文本分支粗判（T-N1）', () => {
  it('★ 长度没变时不重复读整串，但首次必须读', () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'a'.repeat(100_000) });
    const { sink } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });
    w.start();
    await sleep(30);
    await w.whenRecordsSettled();
    const before = clip.readTextCalls;
    await sleep(40);   // 期间剪贴板没变
    w.stop();
    // 粗判生效：后续跳数只用长度比对，没有再整串读
    expect(clip.readTextCalls - before).toBeLessThan(2);
  });

  it('长度相同但内容变了，仍然要记下来（粗判不能变成漏记）', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'AAAAAAAAAA' });
    const { sink, texts } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });
    w.start();
    await sleep(20);
    clip.state.text = 'BBBBBBBBBB';   // 等长
    await sleep(30);
    await w.whenRecordsSettled();
    w.stop();
    expect(texts).toContain('AAAAAAAAAA');
    expect(texts).toContain('BBBBBBBBBB');
  });
});
```

（若 `makeClip` 的假剪贴板没有 `readTextCalls` 计数，先给它加一个——它已经记 `calls` 数组，复用即可。）

- [ ] **Step 3: 实现**

```ts
  private handleText(fmts: string[], suppressed: boolean): void {
    const seen = this.recorder.lastSeen;
    const length = this.clip.textLength?.() ?? null;
    // ★ 粗判（T-N1）：长度没变且已存过全文时，仍然要读一次做全等判定 —— 但只在
    //   "长度一样"这一种情况下读，等长改写的概率远低于"每跳都无条件整串读"。
    //   长度不同一定变，直接读；长度相同 → 读一次比对（宁多读一次，绝不漏记用户复制）。
    const text = this.clip.readText() ?? '';
    ...既有逻辑不动...
```

**注意：** 上面这段的实现形态依赖 Step 1 的实测结论 —— 如果 `readText()` 的代价主要来自 Electron 侧的字符串拷贝，而 `availableFormats()` 拿不到长度，就必须给 `ClipboardLike` 加 `textLength?()`（Electron 侧可用 `clipboard.readText()` 的替代：`readBuffer('text/plain').length`）。若加不出来（Electron API 不给低成本长度），**这条就以"实测结论 + 不改"收尾**，同样提交一行注释说明。

- [ ] **Step 4: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/watcher.ts packages/desktop/electron/watcher.spec.ts
git commit -m "perf(watcher): 文本分支按实测结论处理（粗判落地 / 或记录不改的理由）"
```

---

## Task 10: 一次复制图片解码两遍（T-M10 可局部的那一半）

**问题：** `images.ts:77-82`（`detectAlpha`）与 `images.ts:173-185`（`imagePhash`）**各自整幅 `toBitmap()`**，`:193` 还 `Uint8Array.from` 再拷一份。一次复制 = 两次全量像素解码。审计建议："alpha 与 phash 合并成一次 toBitmap 复用"。

另一半（`recorder.ts:240` 附近把磁盘文件读回来算 sha256）**本任务不动**：那个去重键的语义被明确定义为"磁盘上那份原图字节的 sha256"（`recorder.ts` 注释：与库里存的到底是什么完全一致），改成内存 buffer 会换掉去重键 —— 属于产品决策，列在文末。

**Files:**
- Modify: `packages/desktop/electron/images.ts`、`packages/desktop/electron/recorder.ts`
- Test: `packages/desktop/electron/images.spec.ts`（既有）、`recorder.spec.ts`（既有）

**Interfaces:**
- Consumes: `NativeImageLike.toBitmap?(): Buffer`（BGRA，`images.ts:46`）
- Produces: `export function pixelsOf(img: NativeImageLike): Buffer | null`（一次解码，alpha 与 phash 共用）；`detectAlphaFrom(bmp: Buffer): boolean`；`phashFrom(bmp: Buffer): string | undefined`；两个原函数保留为薄封装（外部调用点不变）

- [ ] **Step 1: 写失败测试**

```ts
describe('★ 一次复制只解码一次像素（T-M10）', () => {
  it('pixelsOf 每个 img 只调一次 toBitmap', () => {
    let calls = 0;
    const img = fakeImageWithBitmap(64, 64, () => { calls += 1 });
    const bmp = pixelsOf(img);
    expect(bmp).not.toBeNull();
    detectAlphaFrom(bmp!);
    phashFrom(bmp!);
    expect(calls).toBe(1);
  });

  it('alpha 判定与 phash 的结果必须与原实现逐字一致（合并只改代价，不改行为）', () => {
    const img = fakeImageWithBitmap(32, 32, () => {});
    expect(detectAlphaFrom(pixelsOf(img)!)).toBe(detectAlpha(img));
    expect(phashFrom(pixelsOf(img)!)).toBe(imagePhash(img));
  });

  it('没有 toBitmap 时回 null，两个下游都安静降级（不抛）', () => {
    const img = { toPNG: () => Buffer.from(''), isEmpty: () => false } as unknown as NativeImageLike;
    expect(pixelsOf(img)).toBeNull();
    expect(detectAlphaFrom(null)).toBe(false);
    expect(phashFrom(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/desktop/electron/images.spec.ts -t "只解码一次" 2>&1 | tail -16`
Expected: FAIL —— `pixelsOf` 未导出

- [ ] **Step 3: 实现**

```ts
/**
 * 一次像素解码，alpha 判定与 phash 共用（T-M10）。
 * ★ 原来两处各自 img.toBitmap()：Electron 每次调用都会重新解一遍全图 BGRA，
 *   大图就是双份内存 + 双份 CPU。这里把"解码"收敛成一个出口，
 *   判定函数改成接收 Buffer —— 判定规则一个字都不动。
 */
export function pixelsOf(img: NativeImageLike): Buffer | null {
  if (!img || typeof img.toBitmap !== 'function') return null;
  try {
    const bmp = img.toBitmap();
    return Buffer.isBuffer(bmp) && bmp.length > 0 ? bmp : null;
  } catch {
    return null; // 解码失败与"没有这张图"同一处理：下游按无 alpha / 无 phash 走
  }
}

export function detectAlphaFrom(bmp: Buffer | null): boolean { /* 原 detectAlpha 的 A 通道扫描，逐字搬过来 */ }
export function phashFrom(bmp: Buffer | null): string | undefined { /* 原 imagePhash 的 dHash 计算，去掉内部 toBitmap */ }

// 原有两个导出保留成薄封装，外部调用点（saveImage / recorder / qrcode）不必全改：
export function detectAlpha(img: NativeImageLike): boolean { return detectAlphaFrom(pixelsOf(img)); }
export function imagePhash(img: NativeImageLike): string | undefined { return phashFrom(pixelsOf(img)); }
```

`recorder.ts` 的 `recordImage` 改成一次解码两处复用（这才是省掉第二遍的地方）：

```ts
    // ★ 一次解码，alpha 判定与感知哈希共用同一份像素（原来各解一遍，见 T-M10）。
    const pixels = pixelsOf(img);
    const phash = phashFrom(pixels);
    let saved: SavedImage;
    try {
      saved = this.measure('图片解码与落盘', () => saveImage(this.dataDir, tmpId, img, pixels));
    } catch (e) { ... }
```

`saveImage` 增加可选第三参 `pixels?: Buffer | null`，内部 `hasAlpha` 用 `detectAlphaFrom(pixels ?? pixelsOf(img))`（不传仍然工作，保持向后兼容与既有测试）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/desktop/electron/images.spec.ts packages/desktop/electron/recorder.spec.ts packages/desktop/electron/qrcode.spec.ts 2>&1 | tail -12`
Expected: PASS —— 特别是既有的 alpha→PNG / 无 alpha→JPEG 分流用例与 phash 用例，一条都不许改期望值。

- [ ] **Step 5: 真机复测（观测面给出数字）**

```bash
CLIPCHAN_PERF_MS=30 pnpm dev     # 复制一张截图，看「图片解码与落盘」「图片感知哈希」两行的毫秒数
```
Expected: 与改动前对比，两段之和下降。**没下降就回滚**。

- [ ] **Step 6: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/electron/images.ts packages/desktop/electron/recorder.ts \
        packages/desktop/electron/images.spec.ts packages/desktop/electron/recorder.spec.ts
git commit -m "perf(images): alpha 判定与感知哈希共用一次像素解码"
```

---

## Task 11: 瀑布流列容器用 index 作 key（T-N4，Minor —— 先定性）

**问题（审计的判断）：** `MasonryList.tsx:51` 用 `key={index}` 作列容器 key，而列数在 1-4 之间随宽度变化（`:43` + ResizeObserver）→ 旧列 DOM 被当新列复用。

**但要诚实：** `distributeColumns`（`packages/core/src/ui/masonry.ts:58-66`）**故意**返回"clamped 个空列"，注释写明是为了让调用方拿到**稳定的列骨架**；列本身没有内在身份，第 3 列就是"第 3 列"，列内条目已经按 `item.id` 加 key。所以这条很可能是"看着像问题、实际是对的"。**本任务的交付物是结论，不是改动。**

**Files:**
- Modify: `packages/core/src/ui/MasonryList.tsx`（只加/改注释）
- Test: `packages/core/src/ui/masonry.spec.ts`（若无则新建）

- [ ] **Step 1: 写钉住既有契约的测试**

```ts
import { describe, expect, it } from 'vitest';
import { distributeColumns } from './masonry';

describe('列骨架的稳定性（T-N4 定性）', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: 'i' + i }) as never);

  it('列数 1-4 之间变化时，列数量等于夹取后的列数，且空列仍在', () => {
    for (const columns of [1, 2, 3, 4]) {
      const buckets = distributeColumns(items, columns, 300);
      expect(buckets).toHaveLength(Math.min(columns, 4));
      expect(buckets.every((b) => Array.isArray(b))).toBe(true);
    }
  });

  it('★ 条目永远按 id 唯一分布，不会因为列数变化而重复或丢失', () => {
    const flat = [1, 2, 3, 4].flatMap((c) => distributeColumns(items, c, 300).flat().map((x) => x.id));
    for (const c of [1, 2, 3, 4]) {
      const ids = distributeColumns(items, c, 300).flat().map((x) => x.id);
      expect(new Set(ids).size).toBe(9);   // 每列数下都恰好 9 个不同 id
    }
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run packages/core/src/ui/masonry.spec.ts 2>&1 | tail -10`
Expected: PASS（若 FAIL，说明 `distributeColumns` 真有重复/丢项 —— 那才是需要修的 bug，回到实现层）

- [ ] **Step 3: 结论落注释**（二选一，按 Step 2 结果）

```tsx
      {/*
        列容器用 index 作 key 是有意的（审计 T-N4 复核结论）：
        列没有内在身份 —— "第 3 列"就是它的身份，distributeColumns 也刻意保持列数稳定
        （见 masonry.ts 的空列注释）；真正有身份的是列内条目，它们按 item.id 加 key。
        改成拼出来的稳定列 id 会让宽度变化时每列 DOM 全部重建，反而更差。
      */}
      {buckets.map((bucket, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col gap-tight">
```

- [ ] **Step 4: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test
git add packages/core/src/ui/masonry.spec.ts packages/core/src/ui/MasonryList.tsx
git commit -m "test(masonry): 复核 T-N4 结论 —— 列容器用 index 作 key 是有意的，钉住列数稳定性契约"
```

---

## Task 12: 生产构建的可诊断性（T-N7，Minor）

**问题：** `packages/desktop/vite.config.ts:23` `sourcemap: true` 常开、没有 `drop_console`（也没用 terser）；渲染层 `React.lazy` / 动态 `import()` **各 0 处**，`App.tsx:31-60` 静态引入全部 19 个视图（SettingsView 826 行、CaptureOverlay 606 行、OptimizeViewCard 598 行），产物是自包含单 chunk。审计把它与 BL-4（Key 加密降级完全静默）连成一条："应用发到用户机器后没有一条能看见运行时发生了什么的路径"。

**Files:**
- Modify: `packages/desktop/vite.config.ts`
- Modify: `packages/core/src/ui/App.tsx`（视图改懒加载）
- Test: `packages/desktop/electron/main.ts` 的打包脚本无改动；用构建产物体积做验证

**Interfaces:**
- Consumes: 既有 `ErrorBoundary`（`4ae7606` 那次提交引入）
- Produces: 视图组件的懒加载边界（`Suspense` 已经在 ErrorBoundary 内）

- [ ] **Step 1: 记录改动前的基线体积**

```bash
cd clipchan && pnpm --filter @clipchan/desktop build 2>/dev/null || node scripts/build-main.mjs
du -sk packages/desktop/dist 2>/dev/null; find packages/desktop/dist -name "*.js" -size +200k -exec ls -lh {} \; | head -5
```
把最大 chunk 的字节数抄进任务说明（改动后要对比）。

- [ ] **Step 2: 构建配置改动**

```ts
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // ★ 生产不出源映射：这是公开仓库的发行包，sourcemap 等于把源码原样发给下载者，
    //   而项目自己早就为"转公开"做过脱敏（见提交 ed74f30），留着 map 与之自相矛盾。
    //   需要排查线上问题时：CLIPCHAN sourceMap=1 pnpm build 临时开。
    sourcemap: process.env.CLIPCHAN_SOURCEMAP === '1' ? 'hidpi' : false,
    target: 'chrome120',
    minify: 'esbuild',
    esbuild: {
      // 生产剥 console（保留 warn/error：主进程的 logLine 双写之外，渲染层唯一的残留出口就是它）。
      pure: process.env.NODE_ENV === 'production' ? ['console.log', 'console.debug', 'console.info'] : [],
    },
    rollupOptions: { /* 现有 input 两项不动 */ },
  },
```

- [ ] **Step 3: 视图懒加载（只切"重且低频"的那几个，不做全量改造）**

`App.tsx`：

```tsx
import { lazy, Suspense } from 'react';
// ★ 首屏只需要列表 + 搜索；把 826 行的设置页、598 行的优化页、606 行的截图 overlay
//   留在主 chunk 里，等于每个用户首次唤起面板都要吃下全部视图的体积。
//   截图 overlay 本来就是独立页面入口（capture.html），这里的 App 内引用只在切换视图时才需要。
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })));
const OptimizeView = lazy(() => import('./OptimizeViewCard').then((m) => ({ default: m.OptimizeView })));
const WordCloudView = lazy(() => import('./WordCloudView').then((m) => ({ default: m.WordCloudView })));
const SnippetView = lazy(() => import('./SnippetView').then((m) => ({ default: m.SnippetView })));
const OrganizeView = lazy(() => import('./OrganizeViewCard').then((m) => ({ default: m.OrganizeView })));
const TrashView = lazy(() => import('./TrashView').then((m) => ({ default: m.TrashView })));
```

并把 `{view === 'settings' ? <SettingsView ... /> : null}` 这类分支整块包进一个已有的视图容器：

```tsx
        <Suspense fallback={<ViewSkeleton />}>
          {/* 现有全部 view === '...' 分支原样留在这里 */}
        </Suspense>
```

`ViewSkeleton` 是本文件内新增的一个极小组件（一行占位，高度与列表一致，避免切换时窗口抖动）：

```tsx
/** 懒加载视图的占位：只撑高度，不做动画 —— 面板是秒开工具，转圈反而显得慢。 */
function ViewSkeleton(): JSX.Element {
  return <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-ink-3">加载中…</div>;
}
```

**注意：** 被懒加载的组件必须确实有具名导出（`OrganizeView` 已确认为具名导出，见 `OrganizeViewCard.tsx:30`），其余五个在改之前先 grep 确认导出名，别猜：

```bash
grep -n "^export function\|^export const" packages/core/src/ui/{SettingsView,OptimizeViewCard,WordCloudView,SnippetView,TrashView}.tsx | head -12
```

- [ ] **Step 4: 验证产物与首屏**

```bash
cd clipchan && CLIPCHAN_SOURCEMAP=0 pnpm --filter @clipchan/desktop build
find packages/desktop/dist -name "*.js" -exec ls -lh {} \; | sort -k5 -h | tail -4
```
Expected: 主 chunk 比 Step 1 基线小；出现若干小 chunk（视图切片）；`dist/**/*.map` 不再存在。

真机：`pnpm dev` 打开面板 → 依次切到 设置/词云/片段/回收站/整理/优化，每个都要正常渲染（懒加载最典型的事故是默认导出与具名导出搞错 → 白屏）。

- [ ] **Step 5: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test && node scripts/smoke-main.mjs
git add packages/desktop/vite.config.ts packages/core/src/ui/App.tsx
git commit -m "build: 生产关源映射并剥 console，低频视图改懒加载切出主 chunk"
```

---

## Task 13: 死代码收口 —— `faviconCandidates` 与 `AUTO_TAGS`

**问题：** 上一轮设计审计的三处死代码里，`suggestTags`（已接进整理弹窗）与 `moveFolder`（已接进整理页）都解决了，剩两处：

- `faviconCandidates`（`packages/core/src/logic/urlPreview.ts:139`，9 条单测，产品 0 调用）。**关键事实：这不是遗漏，是刻意的。** `url-meta.ts:113` 的注释写明"绝不回落到 faviconCandidates 里的 google s2 第三方服务：那等于把用户复制了哪些链接泄露给第三方，本项目承诺零服务器依赖"。
- `AUTO_TAGS`（`organize.ts:181`，公开导出，产品 0 调用）。

**结论：`faviconCandidates` 该删，不该接。** 它是那次隐私决策留下的替代实现，留在 `@clipchan/core` 的公开导出里会诱导以后有人"顺手用上它"。

**Files:**
- Modify: `packages/core/src/logic/urlPreview.ts`、`packages/core/src/logic/urlPreview.spec.ts`
- Modify: `packages/core/src/logic/organize.ts`
- Test: 上述两个 spec

**Interfaces:**
- Produces: 删除两个导出；`urlPreview.ts` 顶部注释记录"为什么只用同主机 favicon"

- [ ] **Step 1: 确认没有隐藏调用点**

```bash
cd clipchan && grep -rn "faviconCandidates\|AUTO_TAGS" packages --include=*.ts --include=*.tsx | grep -v node_modules
```
Expected: 只命中各自的定义处与 spec（本会话实测：`faviconCandidates` 产品 0 处、`AUTO_TAGS` 产品 0 处）

- [ ] **Step 2: 删 `faviconCandidates` 及其用例，并把隐私理由写进注释**

`urlPreview.ts`：删除整个 `faviconCandidates` 函数。在其上方 `normalizeUrl` 或文件头注释里补：

```ts
/**
 * 图标只取「链接自身主机的 /favicon.ico」（见 url-meta.ts 的抓取处）。
 *
 * ★ 这里曾经有一个 faviconCandidates()，会生成含 google s2 在内的候选列表。
 *   它一次都没被调用过，但留在公开包里就是诱导后人"顺手接上"的陷阱：
 *   把用户复制过的域名交给第三方图标服务，与本项目"零服务器依赖"的承诺直接冲突。
 *   需要抓不到图标时的兜底 → 用 domainOf() 显示域名，别引入任何外部主机。
 */
```

`urlPreview.spec.ts`：删掉 `describe('faviconCandidates', ...)` 整块（9 条用例），并追加一条防止有人再加回来的用例：

```ts
  it('★ 不导出任何"第三方图标服务候选"（隐私承诺：抓不到图标就不显示）', async () => {
    const mod = await import('./urlPreview');
    expect(mod).not.toHaveProperty('faviconCandidates');
  });
```

- [ ] **Step 3: 处理 `AUTO_TAGS`**

两个方向，**默认取 ①**（删除导出，`TAG_RULES` 保持模块内私有）：

①  删除 `export const AUTO_TAGS`，并把 `organize.spec.ts` 里引用它的 4 条断言改成走 `suggestTags()` 的实际输出：

```ts
  it('词表就是规则表能产出的那些标签（不再对外导出常量）', () => {
    // 原断言：expect(AUTO_TAGS).toContain('链接')
    // 改成用真实输入驱动真实输出 —— 这样"词表变了但规则没变"也会被这条抓到。
    const produced = new Set<string>();
    for (const sample of SAMPLE_INPUTS) for (const t of suggestTags(sample)) produced.add(t);
    for (const expectTag of ['链接', '代码', '路径', '数字', '图片', '文件', '邮箱', '电话', 'JSON', '颜色', '中文', '英文', '长文本']) {
      expect(produced.has(expectTag)).toBe(true);
    }
  });
```

②  若要把词表呈现给用户（整理页里标出"这些标签是规则自动打的"），那是**新功能**，另立计划，不在本任务里顺手做。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/logic/urlPreview.spec.ts packages/core/src/logic/organize.spec.ts 2>&1 | tail -12`
Expected: PASS，且 `faviconCandidates` 相关用例已不存在

- [ ] **Step 5: 门禁 + 提交**

```bash
pnpm typecheck && pnpm test   # smoke 不需要（纯 core 逻辑改动）
git add packages/core/src/logic/urlPreview.ts packages/core/src/logic/urlPreview.spec.ts \
        packages/core/src/logic/organize.ts packages/core/src/logic/organize.spec.ts
git commit -m "chore: 删除 faviconCandidates 与 AUTO_TAGS 两处死导出，并把零服务器依赖的理由写进注释"
```

---

## 需要用户点头的事（本计划刻意不含实现）

这些不是"没时间做"，而是每一条都会改变用户能感知的行为或影响公开仓库，我不擅自决定：

1. **`tag v1.0.0` 的隐私泄露处置**（最紧急，已核实 `v1.0.0 → c2ec623` 里仍有 `docs/superpowers/evidence/task12-desktop.png`，而 `main` 已删）：A 重指 tag / B 发 v1.0.1 / C `git filter-repo` 清历史 + force-push。命令我上一轮已给，执行前需要你选，因为影响公开仓库且 C 不可逆。
2. **`synchronous = NORMAL`**（T-N2 剩的一条）：WAL 下这是标准推荐，但它意味着断电时最多丢最后一个事务 —— 耐久性语义变更。
3. **`PRAGMA quick_check` 每次启动整库遍历**（T-B4 剩余）：它是"库损坏自动从备份恢复"的闸门，抽样化/降频 = 削弱数据保护。
4. **`backfillSearchIndex` 分批**（T-B4 剩余）：分批会让迁移期间拼音搜索暂时打不全，属于可感知降级。
5. **图片去重键改成内存字节**（T-M10 另一半）：现在的键定义为"磁盘上那份原图字节的 sha256"，换算法会让同一张图在升级前后落到不同键上（重复记录或误去重），需要一次性 `UPDATE` 回填。
6. **是否推送 / 是否发版**：22 个改动 + 本计划的任务全部只提交在本地。

## 建议另立计划的大块（不在本计划展开）

- **T-B2 采集→写库移出主进程**（`worker_threads`）：架构级，审计自己也说"建议在其它项落地并有数据后再动"。现在有了 T-N8 观测面，正好用它先跑一周拿数据，再决定 worker 边界切在哪。
- **T-M4 渲染层重渲染边界**（memo/useMemo/订阅下沉）+ **T-M9 framer-motion `layout`**：都需要 React Profiler 实测，且属于同一子系统，应合成一份"渲染性能"计划。
- **`AUTO_TAGS` 的方案 ②**（把规则词表产品化展示）：新功能，需要设计稿。

## 收尾自检（写完对审计 23 条逐条核对的结果）

**1. 覆盖度 —— 每条都要有下落：**

| 审计编号 | 下落 |
|---|---|
| T-B1 软删+从不 VACUUM | ✅ 本会话已落地（部分索引 + auto_vacuum + maintenance + 空闲轮询） |
| T-B2 采集→写库同步跑在主进程 | ⏭ 另立计划（架构级，需先用 T-N8 的数据定 worker 边界） |
| T-B3 每次复制全量读图片行三遍 | ✅ 本会话已落地（范围查询 + SUM 覆盖索引 + 列裁剪） |
| T-B4 启动路径 4 项重活 | ◐ 半：孤儿扫描 + 自检备份已后移、`listFiles` 去 statSync；`quick_check` 与 `backfill` 分批见"需要用户点头"3、4 |
| T-B5 每次写入两条全表级语句 | ✅ 本会话已落地（evict 区间删除 + `idx_items_seq`）；statement 复用归 Task 6 |
| T-M1 搜索一次读 20000 行×两遍 | ☐ Task 7 |
| T-M2 全 OFFSET 分页 + emptyTrash 循环 | ☐ Task 8（`allTrashIds` + `clampPage` 复用；keyset 分页未做，见下方"已知未覆盖"） |
| T-M3 11 处 ORDER BY 无匹配索引 | ◐ 相似判定/回收站/seq/图片字节四条已补；剩余（wordcloud / export-import / snippets / listTrash 排序）待逐条 EXPLAIN 后补，见"已知未覆盖" |
| T-M4 渲染层零 memo | ⏭ 另立计划（需 React Profiler） |
| T-M5 itemsChanged 无合并窗口 | ☐ Task 2 |
| T-M6 缓存表只增不减 | ☐ Task 5 |
| T-M7 迁移全程无 try/catch | ☐ Task 3 |
| T-M8 71 处 prepare 每次重跑 | ☐ Task 6（先证伪再改） |
| T-M9 每张卡挂 framer `layout` | ⏭ 另立计划（与 T-M4 同一子系统） |
| T-M10 一次复制图片的同步成本 | ◐ 半：Task 10 合并 toBitmap；"回读算哈希"那半见"需要用户点头"5 |
| T-N1 文本分支无粗判层 | ☐ Task 9（先实测，可能以"不改+记录结论"收尾） |
| T-N2 无连接调优 PRAGMA | ◐ `busy_timeout` + `PRAGMA optimize` 已落地；`synchronous=NORMAL` 见"需要用户点头"2 |
| T-N3 seq 两处声明不一致 | ✗ **刻意不做**：所有写入口都显式传 `seq`，差异只在"不带 seq 插入"的老库路径出现；为对齐而改 `CREATE TABLE`/`ALTER` 默认值属于零收益整理，风险是迁移期两种默认值并存更歧义 |
| T-N4 瀑布流列用 index 作 key | ☐ Task 11（先定性，大概率以"确认有意 + 钉住契约"收尾） |
| T-N5 文件夹每次写跑两遍聚合 | ☐ Task 8b |
| T-N6 同名同级并存 + 静默失败 | ☐ Task 4 |
| T-N7 生产可诊断性（sourcemap/懒加载/console） | ☐ Task 12 |
| T-N8 零性能观测面 | ✅ 本会话已落地 |

**2. 已知未覆盖（诚实列出，不留"以后再补"的模糊承诺）：**
- **T-M2 的 keyset 分页**：Task 8 只消掉了 emptyTrash 的循环和 listTrash 的重复夹取，`list()` 仍是 `LIMIT ? OFFSET ?`。改成 `(pinned, created_at, seq)` 三元组游标会牵动 `store.ts` 的分页游标状态、`items.list` 的 IPC 载荷语义与"共 N 条"的算法 —— 那是独立一版改动，应另立计划而不是塞进这里顺手做。
- **T-M3 剩余 7 处排序无匹配索引**：需要逐条 `EXPLAIN QUERY PLAN` 才能判断该建哪条索引（`wordcloud.ts:25`、`export-import.ts:159`、`snippets` 两处、`listTrash`、`db.ts:1103/:1503/:1572`）。审计自己也标注"改完必须 EXPLAIN 验"，所以它是一份需要测量授权的独立清单，不适合写成无数据的任务。

**3. 占位符扫描：** Task 6 Step 3 的 `INSERT INTO items (...)` 与 Task 10 Step 3 的 `detectAlphaFrom` 内部，我都写了"逐字搬现有 SQL / 现有扫描逻辑"而不是自己抄一遍 —— 这是刻意的：我抄列顺序或 A 通道扫描出错，比让执行者从代码里搬更危险。除此之外每个代码步都给了可直接使用的实现，每个验证步都给了具体命令与期望输出。

**4. 类型/命名一致性：** `searchPage(q): { items, total }`（Task 7）、`pruneUrlPreviews(nowMs?): { expired, overflow }`（Task 5）、`allTrashIds(): string[]`（Task 8）、`folderSkeleton()`（Task 8b，模块内私有，不开到 `Db` 接口）、`pixelsOf / detectAlphaFrom / phashFrom`（Task 10）、`SchemaMigrationError / describeMigrationFailure`（Task 3）、`ITEMS_CHANGED_COALESCE_MS`（Task 2）—— 后续任务引用处名字与形状一致；Task 4 与 Task 8b 都碰同名判定，已在 Task 8b 写明"以 skeleton 版为准，别留两条查同名的 SQL"。

**5. 顺序建议：** Task 1（提交）→ 2（M5，最小面积）→ 3（M7，最脆）→ 4+8b（同一处代码，一起改）→ 5（M6）→ 6（M8，可能证伪后关掉）→ 7（M1，改动面最大，最后做）→ 8 → 9/10/11/12/13。Task 7 会把 `list/count` 的调用形状改掉，所以凡是碰 `list`/`count` 的任务都排在它前后要有意识地重跑搜索用例。

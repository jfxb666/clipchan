/**
 * 手机端平台适配器（Task 11 的核心）。
 *
 * ── 为什么手机端「只能手动粘进来、手动复制出去」──────────────────────────
 * Android 10（API 29）起，**后台应用读取剪贴板被系统禁止**：只有持有焦点的应用
 * 才能调用 ClipboardManager.getPrimaryClip()，否则返回空并记一条系统告警。
 * iOS 同样有「粘贴提示气泡」（UIPasteboard 读取会弹授权提示）。
 * 所以手机端**在系统层面就做不到**桌面端那种「复制即入历史」的后台捕获：
 *   · capabilities.backgroundCapture = false 是对平台限制的真实反映，不是偷懒；
 *   · 界面据此显示「本设备不支持后台监听」的说明，而不是假装在监听。
 * 手机端的产品形态是：
 *   ① 用户把内容**手动粘贴进来**（走界面上的「新增」入口 / 系统分享）；
 *   ② 用户在列表里点某条 → 我们写系统剪贴板 → 用户到目标 App **手动粘贴出去**。
 *
 * ── 与桌面端的差别一览（对应 capabilities 四个开关）────────────────────
 *   autoPaste          false  手机端无法向别的 App 注入 Ctrl+V
 *   globalHotkey       false  移动端没有全局热键这个概念（iOS/Android 都不允许）
 *   backgroundCapture  false  Android 10 起系统禁止后台读剪贴板
 *   frostedGlass       false  WebView 里没有桌面窗口的毛玻璃合成
 * 界面读到这些开关后会自动降级（隐藏热键设置、忽略 autoPaste、不渲染玻璃效果）。
 *
 * ── 存储 ────────────────────────────────────────────────────────────────
 * 本轮把记录放在**模块级内存数组**里：进程活着数据就在，冷启动即清空。
 * 这是有意为之的范围控制（spec 里手机端的持久化是后续任务）：先把「同一份 core
 * 界面能在 Capacitor 壳里跑起来、且交互闭环」这件事做出来，持久化（Capacitor
 * Preferences / SQLite）留到下一步换掉本文件里的 store 实现即可 —— 对外的
 * PlatformAdapter 契约不变，界面代码一行不用改。
 *
 * ★ 本文件不 import 任何 electron / node 模块，只依赖 '@clipchan/core' 的逻辑层。
 */
import {
  DEFAULT_SETTINGS,
  buildWordCloud,
  classify,
  previewOfText,
  type AppToast,
  type BurstHint,
  type Capabilities,
  type ClipItemDTO,
  type ExportResult,
  type GhostState,
  type ImportResult,
  type HotkeyStatus,
  type Kind,
  type KindFilter,
  type ListQuery,
  type NavigateTarget,
  type PasteResult,
  type PlatformAdapter,
  type PurgeResult,
  type RestoreResult,
  type Settings,
  type Snippet,
  type SnippetInput,
  type TrashQuery,
  type UpdateStatus,
  type WordCloudData,
} from '@clipchan/core';

/** 内存里的一条记录（比 DTO 多一个 content：DTO 只给界面看，content 供粘贴/拼接）。 */
interface MobileRecord {
  id: string;
  kind: Kind;
  content: string | null;
  /** 图片的内联 dataURL（base64），文本记录为 null。 */
  dataUrl: string | null;
  createdAt: number;
  pinned: boolean;
  source: 'capture' | 'merge';
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return 'm' + Date.now().toString(36) + '-' + seq.toString(36);
}

/** 记录表（模块级单例，适配器每次创建都共享同一份数据）。 */
const records: MobileRecord[] = [];

/** 片段库（同样是模块级单例；手机端本轮不落盘）。 */
const snippets: Snippet[] = [];

/** 换行常量：拼接分隔符与桌面端 MergeService 一致（CRLF）。 */
const CRLF = String.fromCharCode(13, 10);

type Unsub = () => void;
const itemsSubs = new Set<() => void>();
const settingsSubs = new Set<(s: Settings) => void>();
const ghostSubs = new Set<(g: GhostState) => void>();
const modeSubs = new Set<(m: 'main' | 'widget') => void>();
const navSubs = new Set<(t: NavigateTarget) => void>();
const burstSubs = new Set<(h: BurstHint) => void>();

function emit(list: Set<() => void>): void {
  for (const fn of [...list]) {
    try {
      fn();
    } catch {
      // 单个订阅者出错不影响其它订阅者与调用方。
    }
  }
}

/** 订阅工具：加进集合，返回退订函数（**同步返回，绝不返回 Promise**）。 */
function subscribe<T>(set: Set<T>, cb: T): Unsub {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

const GHOST_OFF: GhostState = { active: false, remainingMs: 0, until: null };

const CAPABILITIES: Capabilities = {
  autoPaste: false,
  globalHotkey: false,
  backgroundCapture: false,
  frostedGlass: false,
};

/** 手机端内存设置的唯一副本；DEFAULT_SETTINGS 只用于初始化。 */
let settings: Settings = { ...DEFAULT_SETTINGS };

/** 'text-group' 不是 Kind，而是「排除图片」的一组；与 KindFilter 的定义保持一致。 */
function kindMatches(kind: Kind, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'text-group') return kind !== 'image';
  return kind === filter;
}

function toDTO(r: MobileRecord): ClipItemDTO {
  const dto: ClipItemDTO = {
    id: r.id,
    kind: r.kind,
    preview: r.kind === 'image' ? '图片' : previewOfText(r.content ?? ''),
    createdAt: r.createdAt,
    pinned: r.pinned,
    source: r.source,
  };
  if (r.dataUrl) dto.thumbUrl = r.dataUrl;
  return dto;
}

/** 收藏优先、同档按时间倒序（与 SQL 的 ORDER BY pinned DESC, created_at DESC 对齐）。 */
function sortRecords(list: MobileRecord[]): MobileRecord[] {
  return [...list].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.createdAt - a.createdAt));
}

/** 新增一条文本记录，返回新记录（供界面的「手动粘进来」入口与拼接复用）。 */
export function addText(content: string): ClipItemDTO {
  const trimmed = content.replace(/\r\n/g, '\n').trim();
  const rec: MobileRecord = {
    id: nextId(),
    kind: classify(trimmed),
    content: trimmed,
    dataUrl: null,
    createdAt: Date.now(),
    pinned: false,
    source: 'capture',
  };
  records.push(rec);
  emit(itemsSubs);
  return toDTO(rec);
}

/** 新增一条图片记录（dataURL / base64）。 */
export function addImage(dataUrl: string): ClipItemDTO {
  const rec: MobileRecord = {
    id: nextId(),
    kind: 'image',
    content: null,
    dataUrl,
    createdAt: Date.now(),
    pinned: false,
    source: 'capture',
  };
  records.push(rec);
  emit(itemsSubs);
  return toDTO(rec);
}

/**
 * 创建一个手机端平台适配器。
 * 同时挂到全局 `globalThis.clipchan`，这样即使宿主忘了调用 setPlatform()，
 * core 的 getPlatform() 也能探测到（core 的探测顺序：注入 > globalThis.clipchan > 报错桩）。
 */
export function createMobileAdapter(): PlatformAdapter {
  /** list 与 count 共用的筛选：两边必须同一套条件，否则「共 N 条」和列表对不上。 */
  const pickRecords = (q: ListQuery): MobileRecord[] => {
    const kind = q.kind ?? 'all';
    const needle = (q.q ?? '').trim().toLowerCase();
    let picked = sortRecords(records).filter((r) => kindMatches(r.kind, kind));
    if (needle.length > 0) {
      // 大小写不敏感，同时匹配展示文本与原始内容（与桌面端 SQL 的 LIKE 行为一致）。
      picked = picked.filter((r) => {
        const hay = ((r.content ?? '') + ' ' + (r.kind === 'image' ? '图片' : '')).toLowerCase();
        return hay.includes(needle);
      });
    }
    return picked;
  };

  const adapter: PlatformAdapter = {
    items: {
      async list(q: ListQuery): Promise<ClipItemDTO[]> {
        const offset = q.offset ?? 0;
        const limit = q.limit ?? 200;
        return pickRecords(q).slice(offset, offset + limit).map(toDTO);
      },

      async paste(id: string): Promise<PasteResult> {
        const rec = records.find((r) => r.id === id);
        if (!rec) return { ok: false, reason: 'no-target' };
        try {
          if (rec.kind === 'image' && rec.dataUrl) {
            // 图片：尽量按 image/png 写进系统剪贴板。
            // 只在支持 ClipboardItem 的 WebView 上尝试；失败就老实报 send-failed，
            // 不假装成功（界面据此提示「请用长按图片另存/分享」）。
            const w = navigator as Navigator & {
              clipboard?: { write?: (items: unknown[]) => Promise<void> };
            };
            const Ctor = (globalThis as { ClipboardItem?: new (o: Record<string, unknown>) => unknown })
              .ClipboardItem;
            if (!w.clipboard?.write || !Ctor) return { ok: false, reason: 'send-failed' };
            const blob = await (await fetch(rec.dataUrl)).blob();
            const item = new Ctor({ [blob.type || 'image/png']: blob });
            await w.clipboard.write([item]);
          } else {
            await navigator.clipboard.writeText(rec.content ?? '');
          }
          return { ok: true };
        } catch {
          // 手机端写系统剪贴板需要页面处于前台且有用户手势，失败是常态而非异常。
          return { ok: false, reason: 'send-failed' };
        }
      },

      async remove(id: string): Promise<void> {
        const i = records.findIndex((r) => r.id === id);
        if (i >= 0) records.splice(i, 1);
        emit(itemsSubs);
      },

      async togglePin(id: string): Promise<void> {
        const rec = records.find((r) => r.id === id);
        if (rec) rec.pinned = !rec.pinned;
        emit(itemsSubs);
      },

      async clearUnpinned(): Promise<void> {
        for (let i = records.length - 1; i >= 0; i -= 1) {
          if (!records[i]!.pinned) records.splice(i, 1);
        }
        emit(itemsSubs);
      },

      async clearAll(): Promise<void> {
        records.length = 0;
        emit(itemsSubs);
      },

      async copy(id: string): Promise<PasteResult> {
        // 手机端没有"贴回原窗口"这回事，复制就是写系统剪贴板。
        const rec = records.find((r) => r.id === id);
        if (!rec) return { ok: false, reason: 'no-target' };
        try {
          if (rec.kind === 'image' && rec.dataUrl) {
            const nav = globalThis.navigator as Navigator | undefined;
            if (!nav?.clipboard || typeof ClipboardItem === 'undefined') {
              throw new Error('当前环境不支持写图片到剪贴板');
            }
            const blob = await (await fetch(rec.dataUrl)).blob();
            await nav.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            return { ok: true };
          }
          const nav = globalThis.navigator as Navigator | undefined;
          if (!nav?.clipboard?.writeText) throw new Error('当前环境不支持写剪贴板');
          await nav.clipboard.writeText(rec.content ?? '');
          return { ok: true };
        } catch {
          return { ok: false, reason: 'send-failed' };
        }
      },

      async count(q: ListQuery): Promise<number> {
        return pickRecords(q).length;
      },

      async exportAll(): Promise<ExportResult> {
        // 手机端没有文件系统落盘能力，如实报失败（不假装导出成功）。
        return { ok: false, reason: '手机端没有文件系统落盘能力' };
      },

      async importAll(): Promise<ImportResult> {
        // 手机端既不能选 zip 也不能解压落盘 —— 与回收站五方法同样明确抛错，不返回假成功。
        throw new Error('手机端暂不支持导入备份包');
      },

      async mergeSelected(ids: string[]): Promise<{ ok: boolean; id?: string; reason?: string }> {
        // 语义与桌面端 MergeService 一致：收藏项与图片项**不参与**，
        // 且**必须原样保留不删**；剩下不足 2 条就什么都不做。
        if (!Array.isArray(ids) || ids.length < 2) return { ok: false, reason: 'not-enough' };

        const rows: MobileRecord[] = [];
        for (const id of ids) {
          if (typeof id !== 'string' || id.length === 0) continue;
          const rec = records.find((r) => r.id === id);
          if (rec) rows.push(rec);
        }
        if (rows.length < 2) return { ok: false, reason: 'not-enough' };

        const pinned = rows.filter((r) => r.pinned).length;
        const images = rows.filter((r) => r.kind === 'image' || r.content === null).length;
        const parts = rows.filter((r) => !r.pinned && r.kind !== 'image' && r.content !== null);

        if (parts.length < 2) {
          if (images > 0 && rows.length - images < 2) return { ok: false, reason: 'images-skipped' };
          if (pinned > 0) return { ok: false, reason: 'pinned' };
          return { ok: false, reason: 'not-enough' };
        }

        const text = parts.map((r) => r.content).join(CRLF);
        const merged: MobileRecord = {
          id: nextId(),
          // 拼接结果可能是多行代码块，kind 一律按 classify 重算（与桌面端一致）。
          kind: classify(text),
          content: text,
          dataUrl: null,
          createdAt: Date.now(),
          pinned: false,
          source: 'merge',
        };
        // 先插入再删源：中途异常最多留一份重复内容，绝不丢数据。
        records.push(merged);
        const src = new Set(parts.map((r) => r.id));
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const rid = records[i]!.id;
          if (rid !== merged.id && src.has(rid)) records.splice(i, 1);
        }
        emit(itemsSubs);
        return { ok: true, id: merged.id };
      },

      async getFullImage(id: string): Promise<string> {
        const rec = records.find((r) => r.id === id);
        // 手动粘进来的图片就是内联 base64/dataURL，原样返回；纯文本返回空串。
        // 刻意不 throw：界面可以据此显示「无原图」而不是弹错误提示。
        return rec && rec.kind === 'image' && rec.dataUrl ? rec.dataUrl : '';
      },

      async getText(id: string): Promise<string> {
        const rec = records.find((r) => r.id === id);
        // 手机端记录本来就存全文（内存数组里没有"截断的预览"这回事），原样返回。
        return rec && rec.kind !== 'image' ? (rec.content ?? '') : '';
      },

      async saveText(text: string): Promise<{ ok: boolean; id?: string }> {
        // 与桌面端同语义：空白串回 ok:false（不造一条空记录）。
        if (typeof text !== 'string' || text.trim().length === 0) return { ok: false };
        return { ok: true, id: addText(text).id };
      },

      // ★ 手机端没有回收站（内存数组里没有 deleted_at 这层）。如实 reject 而不是返回
      //   空数组/假成功：界面据此显示"当前平台不支持回收站"，而不是一个永远空的面板。
      async trashList(_q: TrashQuery): Promise<ClipItemDTO[]> {
        throw new Error('手机端暂不支持回收站');
      },

      async trashCount(): Promise<number> {
        throw new Error('手机端暂不支持回收站');
      },

      async restore(_id: string): Promise<RestoreResult> {
        throw new Error('手机端暂不支持回收站');
      },

      async purge(_ids: string[]): Promise<PurgeResult> {
        throw new Error('手机端暂不支持回收站');
      },

      async emptyTrash(): Promise<PurgeResult> {
        throw new Error('手机端暂不支持回收站');
      },

      async pastePlain(id: string): Promise<PasteResult> {
        // 纯文本粘贴 = 只写文本。手机端写剪贴板本来就只有纯文本这条路。
        const rec = records.find((r) => r.id === id);
        if (!rec || rec.kind === 'image') return { ok: false, reason: 'no-target' };
        const nav = globalThis.navigator as Navigator | undefined;
        if (!nav?.clipboard?.writeText) return { ok: false, reason: 'send-failed' };
        try {
          await nav.clipboard.writeText(rec.content ?? '');
          return { ok: true };
        } catch {
          return { ok: false, reason: 'send-failed' };
        }
      },

      async pasteMany(ids: string[]): Promise<PasteResult> {
        // 手机端没有"贴回原窗口"：批量粘贴退化为把拼好的文本写进剪贴板。
        const parts: string[] = [];
        for (const id of ids) {
          const rec = records.find((r) => r.id === id);
          if (rec && rec.kind !== 'image') parts.push(rec.content ?? '');
        }
        if (parts.length === 0) return { ok: false, reason: 'no-target' };
        const nav = globalThis.navigator as Navigator | undefined;
        if (!nav?.clipboard?.writeText) return { ok: false, reason: 'send-failed' };
        try {
          await nav.clipboard.writeText(parts.join('\n'));
          return { ok: true };
        } catch {
          return { ok: false, reason: 'send-failed' };
        }
      },

      async removeMany(ids: string[]): Promise<number> {
        let removed = 0;
        for (const id of ids) {
          const i = records.findIndex((r) => r.id === id);
          if (i >= 0) {
            records.splice(i, 1);
            removed += 1;
          }
        }
        if (removed > 0) emit(itemsSubs);
        return removed;
      },

      async pinMany(ids: string[], pinned: boolean): Promise<void> {
        for (const id of ids) {
          const rec = records.find((r) => r.id === id);
          if (rec) rec.pinned = pinned;
        }
        emit(itemsSubs);
      },

      async startDrag(_id: string): Promise<void> {
        // 拖出到外部应用是桌面窗口能力（Electron webContents.startDrag），手机端 no-op。
      },

      onChanged(cb: () => void): Unsub {
        return subscribe(itemsSubs, cb);
      },

      onBurstHint(cb: (hint: BurstHint) => void): Unsub {
        // 连续复制的探测在桌面端由主进程监听剪贴板完成；手机端没有后台监听，
        // 所以这个事件永远不会触发。接口必须留着（core 会订阅），返回真退订函数。
        return subscribe(burstSubs, cb);
      },
    },

    settings: {
      async get(): Promise<Settings> {
        return { ...settings };
      },

      async set(patch: Partial<Settings>): Promise<Settings> {
        settings = { ...settings, ...patch };
        const snapshot = { ...settings };
        for (const cb of [...settingsSubs]) {
          try {
            cb(snapshot);
          } catch {
            // 订阅者异常不影响持久化结果。
          }
        }
        return snapshot;
      },

      onChanged(cb: (s: Settings) => void): Unsub {
        return subscribe(settingsSubs, cb);
      },
    },

    ghost: {
      async get(): Promise<GhostState> {
        return { ...GHOST_OFF };
      },

      async set(_minutes: number): Promise<GhostState> {
        // 幽灵模式（暂停监听 N 分钟）是「有后台监听」才成立的概念。
        // 手机端根本没有后台监听，所以恒为未激活 —— 界面会据此隐藏该项设置。
        return { ...GHOST_OFF };
      },

      onChanged(cb: (g: GhostState) => void): Unsub {
        return subscribe(ghostSubs, cb);
      },
    },

    app: {
      async setMode(_mode: 'main' | 'widget'): Promise<void> {
        // 手机端没有「主面板 / 小组件」两种窗口形态（那是桌面窗口的概念）：no-op。
      },

      async hide(): Promise<void> {
        // 桌面端 Esc 是「隐藏面板」；手机端没有隐藏面板这回事，no-op。
      },

      async setWidgetSize(_px: number): Promise<void> {
        // 小组件尺寸只对桌面窗口有意义：no-op。
      },

      async setWidgetHeight(_px: number): Promise<void> {
        // 小组件高度只对桌面窗口有意义：no-op。
      },

      async resizeBy(_dw: number, _dh: number): Promise<void> {
        // 手机端窗口由系统管理，不能程序化改尺寸：no-op。
      },

      async getHotkeyStatus(): Promise<HotkeyStatus> {
        return {
          activate: false,
          widget: false,
          capture: false,
          conflicts: ['手机端不支持全局热键'],
        };
      },

      async getAutoStart(): Promise<boolean> {
        // 开机自启由系统管理（Android 需要专门的 boot 权限与后台服务），本轮不做。
        return false;
      },

      async setAutoStart(_on: boolean): Promise<boolean> {
        // 恒返回 false：界面据此把「开机自启」开关显示为不可用（在手机上点了也没用）。
        return false;
      },

      async openDataFolder(): Promise<void> {
        throw new Error('手机端没有「数据文件夹」这个概念：Android/iOS 不给应用暴露用户可浏览的目录。');
      },

      async checkUpdate(): Promise<UpdateStatus> {
        // 自动更新是桌面端 electron-updater 的能力；手机端由应用商店负责。
        return { state: 'none', message: '手机端由应用商店更新' };
      },

      async applyUpdate(): Promise<void> {
        throw new Error('手机端没有可自行安装的更新包');
      },

      onUpdate(_cb: (s: UpdateStatus) => void): Unsub {
        return () => {};
      },

      onMode(cb: (mode: 'main' | 'widget') => void): Unsub {
        return subscribe(modeSubs, cb);
      },

      onNavigate(cb: (target: NavigateTarget) => void): Unsub {
        return subscribe(navSubs, cb);
      },

      onToast(_cb: (t: AppToast) => void): Unsub {
        // 手机端没有主进程推提示这条路（提示都在本进程内直接发）：订阅即空转，不 throw。
        return () => {};
      },
    },

    wordcloud: {
      async today(): Promise<WordCloudData> {
        // 用内存里的记录现算（桌面端是查 SQLite 今天的记录）。
        const texts = records.filter((r) => r.kind !== 'image' && (r.content ?? '').length > 0).map((r) => r.content ?? '');
        const words = buildWordCloud(texts).slice(0, 60);
        return { words, totalItems: texts.length };
      },

      async exportPng(): Promise<{ ok: boolean; path?: string }> {
        // 手机端没有「导出到文件路径」的写权限与统一入口：明确报失败，由界面提示。
        return { ok: false };
      },
    },

    clipboard: {
      // WebView 里 navigator.clipboard 可用；不可用时明确报错，不静默吞。
      async writeText(text: string): Promise<void> {
        const nav = globalThis.navigator as Navigator | undefined;
        if (!nav?.clipboard?.writeText) throw new Error('当前环境不支持写剪贴板');
        await nav.clipboard.writeText(text);
      },
    },

    snippets: {
      // 片段库在手机端先用内存数组：与记录同样是「进程活着就在」的范围控制。
      async list(): Promise<Snippet[]> {
        return [...snippets];
      },

      async save(input: SnippetInput): Promise<Snippet[]> {
        const content = typeof input.content === 'string' ? input.content : '';
        if (content.trim().length === 0) throw new Error('片段内容不能为空');
        const title = typeof input.title === 'string' ? input.title.trim() : '';
        const now = Date.now();
        const existing = input.id ? snippets.find((s) => s.id === input.id) : undefined;
        if (existing) {
          existing.title = title;
          existing.content = content;
          existing.updatedAt = now;
        } else {
          snippets.unshift({
            id: nextId(),
            title,
            content,
            createdAt: now,
            updatedAt: now,
            useCount: 0,
          });
        }
        return [...snippets];
      },

      async remove(id: string): Promise<Snippet[]> {
        const i = snippets.findIndex((s) => s.id === id);
        if (i >= 0) snippets.splice(i, 1);
        return [...snippets];
      },

      async use(id: string): Promise<Snippet[]> {
        const s = snippets.find((x) => x.id === id);
        if (!s) throw new Error('片段不存在');
        s.useCount += 1;
        s.updatedAt = Date.now();
        const nav = globalThis.navigator as Navigator | undefined;
        if (!nav?.clipboard?.writeText) throw new Error('当前环境不支持写剪贴板');
        await nav.clipboard.writeText(s.content);
        return [...snippets];
      },

      onChanged(_cb: () => void): Unsub {
        // 手机端片段变更都在本进程内同步发生，界面自己刷新即可，没有跨进程推送。
        return () => {};
      },
    },

    ai: {
      // 手机端不接 AI：七个方法全部如实报不可用，不返回空数组假装成功。
      async listProviders(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async saveProvider(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async removeProvider(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async listModels(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async test(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async optimize(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async cancel(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async copyAndPaste(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async scenes(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async history(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async historyRemove(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      async historyClear(): Promise<never> {
        throw new Error('手机端暂不支持 AI 提示词优化');
      },
      onChanged: (): Unsub => () => {},
      onOptimizeDelta: (): Unsub => () => {},
    },

    capture: {
      // 截图 overlay 依赖 desktopCapturer 与多显示器窗口：手机端如实报不可用。
      async begin(): Promise<never> {
        throw new Error('手机端不支持桌面截图');
      },
      async target(): Promise<never> {
        throw new Error('手机端不支持桌面截图');
      },
      async finish(): Promise<never> {
        throw new Error('手机端不支持桌面截图');
      },
      async cancel(): Promise<void> {
        // 取消是"什么都不做"的语义：没开过 overlay 就没有可关的，不 throw。
      },
    },

    ocr: {
      // OCR 引擎只在桌面主进程跑（worker + WASM），手机端没有这条通道。
      async status(): Promise<never> {
        throw new Error('手机端暂不支持文字识别');
      },
      async download(): Promise<never> {
        throw new Error('手机端暂不支持文字识别');
      },
      async recognize(): Promise<never> {
        throw new Error('手机端暂不支持文字识别');
      },
      onProgress: (): Unsub => () => {},
    },

    capabilities: { ...CAPABILITIES },
  };

  // 双保险：显式注入 + 全局挂载（core 的 getPlatform() 两条路都能拿到）。
  (globalThis as unknown as { clipchan?: PlatformAdapter }).clipchan = adapter;
  return adapter;
}

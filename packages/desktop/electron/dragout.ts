/**
 * 拖出到外部应用（P1-5）的参数计算。
 *
 * 真正发起拖拽的只能是主进程（`webContents.startDrag`），但"该拖哪个文件、能不能拖"
 * 是纯逻辑，放这里以便 vitest 直接测。本文件不 import electron，也不读文件系统 ——
 * "路径存不存在"由调用方注入 `exists`（主进程传 fs.existsSync）。
 *
 * ★ Electron 的 `Item` 支持 `files: string[]`（`files` 会覆盖 `file`），所以多文件
 *   记录可以一次全拖出去 —— 见 `node_modules/electron/electron.d.ts` 的 `interface Item`。
 *   旧版本这里按"一次只能一个 file"回 null，是错的。
 */

/**
 * `webContents.startDrag` 需要的载荷。
 *
 * `file` 永远是必填的（Electron 的 `interface Item` 把它写成必填，少了连类型都过不去），
 * 多文件时再补 `files`：Electron 里 `files` 会覆盖 `file`，两个都给是合法的。
 */
export interface DragPayload {
  file: string;
  /** 多文件记录才有；单文件时省略。 */
  files?: string[];
  icon: string;
}

/** 记录里没有任何可拖出的文件（文件记录为空 / 文件已被用户在资源管理器里删掉）。 */
export const DRAG_HINT_NO_FILE = '这条记录没有可拖出的文件';

/** 文本类记录（text / link / code / path / number）拖不出去的提示。 */
export const DRAG_HINT_TEXT = '文本记录暂时不能拖出';

/** `dragPayloadFor` 的注入依赖。 */
export interface DragOpts {
  /** 数据目录（只有 imageAbs 用到，本模块不直接读）。 */
  dataDir: string;
  /** 文件记录的绝对路径列表（主进程从 `db.getFilePaths` 取）。 */
  filePaths: string[];
  /** 把库里的相对路径解析成绝对路径。 */
  imageAbs: (rel: string) => string;
  /**
   * 路径是否存在。**必须注入**：`startDrag` 拿到不存在的路径会抛在主进程里，
   * 而那个异常既到不了界面（handler 的 rejection 被界面静默吞掉），也留不下提示。
   * 缺省按"都存在"处理，只给单测图方便。
   */
  exists?: (p: string) => boolean;
}

/**
 * 算 `webContents.startDrag` 的参数。
 *
 * 返回 null 表示"这条记录现在拖不出去"，调用方不要显示可拖动样式。
 *
 * 支持的范围：
 * - `image`：拖出磁盘上的原图。
 * - `files`：拖出库里存的绝对路径，一个或多个都行。
 * - 其余（text / link / code / path / number）：Electron 的 `startDrag` 只认文件，
 *   拖文本要用 OLE 的 `IDataObject`，本应用没有原生助手做这件事，回 null。
 */
export function dragPayloadFor(
  id: string,
  row: { kind: string; image_path: string | null } | null,
  opts: DragOpts,
): DragPayload | null {
  // 记录不存在（刚被删掉的竞态）：没有文件可拖。
  if (!row) return null;
  const exists = opts.exists ?? (() => true);

  if (row.kind === 'image') {
    const rel = row.image_path;
    if (!rel || rel.length === 0) return null;
    const file = opts.imageAbs(rel);
    if (file.length === 0) return null;
    // 原图被清理策略删掉了：拖出去只会让 startDrag 抛在主进程里。
    if (!exists(file)) return null;
    // 图片自己就是图标，不用调用方再补。
    return { file, icon: file };
  }

  if (row.kind === 'files') {
    const paths = opts.filePaths.filter(
      (p) => typeof p === 'string' && p.length > 0 && exists(p),
    );
    const first = paths[0];
    if (first === undefined) return null;
    // 非图片记录没有现成图标，留空串让调用方补默认图标路径。
    // 多文件时 file 仍给第一个 —— Electron 的 Item.file 是必填，files 会覆盖它。
    if (paths.length === 1) return { file: first, icon: '' };
    return { file: first, files: paths, icon: '' };
  }

  return null;
}

/**
 * 这条记录在 UI 上该不该显示"可拖动"。
 *
 * null = 能拖；否则是给用户看的中文原因（不显示成灰按钮却不解释）。
 */
export function dragHintFor(kind: string): string | null {
  if (kind === 'image') return null;
  if (kind === 'files') return null;
  return DRAG_HINT_TEXT;
}

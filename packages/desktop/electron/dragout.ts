/**
 * 拖出到外部应用（P1-5）的参数计算。
 *
 * 真正发起拖拽的只能是主进程（`webContents.startDrag({ file, icon })`），
 * 但"该拖哪个文件、能不能拖"是纯逻辑，放这里以便 vitest 直接测。
 *
 * 本文件不 import electron：`imageAbs` 由调用方注入（`paths.imageAbs(dataDir, rel)`）。
 */

/** 一次拖拽需要的两个路径：被拖的文件 + 拖拽时跟随光标的图标。 */
export interface DragFileSpec {
  /** 磁盘上真实存在的文件绝对路径（startDrag 会校验，不存在则拖拽直接失败）。 */
  path: string;
  /** 拖拽图标（.png/.ico 绝对路径）；文本类记录没有现成图标，由调用方补默认图标。 */
  icon?: string;
}

/** 多文件记录拖不出去的提示（`dragPayloadFor` 回 null 时界面用它，不要笼统说"不能拖"）。 */
export const DRAG_HINT_MULTI_FILE = '多文件暂时不能拖出';

/** 文本类记录（text / link / code / path / number）拖不出去的提示。 */
export const DRAG_HINT_TEXT = '文本记录暂时不能拖出';

/**
 * 算 `webContents.startDrag` 的参数。
 *
 * 返回 null 表示"这条记录现在拖不出去"，调用方**不要**显示可拖动样式。
 *
 * ★ 本轮的三条限制（都是有意的，不是遗漏）：
 * - **多文件不拖**：Electron 的 `startDrag` 一次只能给一个 `file`，多文件要么用原生
 *   helper 提供 IDataObject，要么逐个起拖（会拖出 N 次）。本轮不做，回 null。
 * - **文本不拖**：拖文本要用 `startDrag` 的 `data` 形态（`{ items: [...], files: [] }`
 *   或 `{ file, icon }`），与文件形态互斥；本轮只做文件形态，文本回 null。
 * - `file` 必须是**磁盘上真实存在**的路径：图片用 imageAbs 解析出来的原图，
 *   文件用库里存的绝对路径（文件已被用户删掉时 startDrag 会静默失败）。
 */
export function dragPayloadFor(
  id: string,
  row: { kind: string; image_path: string | null } | null,
  opts: { dataDir: string; filePaths: string[]; imageAbs: (rel: string) => string },
): { file: string; icon: string } | null {
  // 记录不存在（刚被删掉的竞态）：没有文件可拖。
  if (!row) return null;

  if (row.kind === 'image') {
    const rel = row.image_path;
    if (!rel || rel.length === 0) return null;
    const file = opts.imageAbs(rel);
    if (file.length === 0) return null;
    // 图片自己就是图标，不用调用方再补。
    return { file, icon: file };
  }

  if (row.kind === 'files') {
    const paths = opts.filePaths.filter((p) => typeof p === 'string' && p.length > 0);
    // 多文件：startDrag 一次只能一个（见函数头注释）。
    if (paths.length !== 1) return null;
    const file = paths[0];
    if (file === undefined) return null;
    // 非图片记录没有现成图标，留空串让调用方补默认图标路径。
    return { file, icon: '' };
  }

  // text / link / code / path / number：文本形态本轮不做。
  return null;
}

/**
 * 这条记录在 UI 上该不该显示"可拖动"。
 *
 * null = 能拖；否则是给用户看的中文原因（不显示成灰按钮却不解释）。
 * ★ 只按 kind 判定：多文件记录 kind 也是 'files'，界面拿到 `dragPayloadFor` 的 null
 *   之后再用 `DRAG_HINT_MULTI_FILE` 说明具体原因。
 */
export function dragHintFor(kind: string): string | null {
  if (kind === 'image') return null;
  if (kind === 'files') return null;
  return DRAG_HINT_TEXT;
}

import type { ClipItemDTO } from '../types';
import { formatTime } from './util';

/**
 * 回收站视图的纯逻辑：分页游标、清空/永久删除的可见性与文案、空状态判定。
 *
 * ★ 为什么单独抽一个文件：仓库的 vitest 只跑 node 环境、没有 jsdom（见 keymap.ts /
 *   contextMenu.ts 的文件头），组件本身渲染不了，所以判定必须能脱离 DOM 断言。
 */

/** 单页条数。与主列表 PAGE_SIZE 分开：回收站是"临时堆放区"，量级比历史列表小得多。 */
export const TRASH_PAGE_SIZE = 200;
/** 主进程 trashList 的单次硬上限：超过这个数的 limit 会被 IPC 层截断，别拿它当分页依据。 */
export const TRASH_MAX_LIMIT = 500;
/** 「清空回收站」的二次确认窗口：与 Ctrl+Delete / 设置页两个清空按钮同一节奏（3 秒）。 */
export const EMPTY_TRASH_CONFIRM_TTL_MS = 3000;

/** 工具条标题，带真实总数（不是已加载条数）。 */
export function trashTitle(total: number): string {
  return '回收站（' + Math.max(0, total) + ' 条）';
}

/**
 * 清空是破坏性操作：空回收站上不渲染这个按钮。
 * 留一个永远能点的「清空」只会让人在没东西可删时反复点它、怀疑界面坏了。
 */
export function shouldShowEmptyTrash(total: number): boolean {
  return total > 0;
}

/** 空状态判定：加载中一律不算空，否则首屏会先闪一下「回收站是空的」再跳成列表。 */
export function isTrashEmpty(loaded: number, loading: boolean): boolean {
  return !loading && loaded === 0;
}

/**
 * 下一页的 offset；没有下一页返回 null。
 *
 * total < 0 表示 trashCount 没取到（IPC 失败）。此时不敢断言"到底了"，
 * 只在「上一页正好是满页」时才认为可能还有下一页 —— 少翻一页比无限重复拉同一页好。
 */
export function nextTrashOffset(loaded: number, total: number): number | null {
  if (total >= 0) return loaded < total ? loaded : null;
  if (loaded > 0 && loaded % TRASH_PAGE_SIZE === 0) return loaded;
  return null;
}

/**
 * 回收站空态下的补充说明。
 *
 * ★ 视觉仍复用 EmptyState（图标 + 底衬 + 降饱和滤镜），但它的话术是
 *   emptyHintOf(kind) 算出来的，只认 KindFilter —— 'all' 会给出「口袋还是空的，
 *   复制点什么试试」。用户是刚把东西删光才走到这里的，那句"试试复制"答非所问。
 *   EmptyState.tsx 不在本次改动边界内，所以在这里补一句对上场景的说明。
 */
export const EMPTY_TRASH_HINT = '删掉的记录会先在这里留一会儿，可以恢复';

/** 清空按钮文案：待确认态与设置页两个清空按钮逐字一致。 */
export function emptyTrashLabel(pending: boolean): string {
  return pending ? '再点一次确认' : '清空回收站';
}

/** 单条「永久删除」的确认文案（同样走两次点击确认）。 */
export function purgeLabel(pending: boolean): string {
  return pending ? '再点一次确认' : '永久删除';
}

/**
 * 卡片的删除时间行。
 * deletedAt 缺失（v0.2.0 老库迁移过来的行理论上不会缺，但 DTO 上是可选的）时如实说未知，
 * 不拿 createdAt 冒充删除时间 —— 那会让用户以为刚删的东西是去年删的。
 */
export function deletedAtText(item: Pick<ClipItemDTO, 'deletedAt'>, now: number = Date.now()): string {
  if (!item.deletedAt) return '删除时间未知';
  return '删除于 ' + formatTime(item.deletedAt, now);
}

/**
 * 右键菜单的纯逻辑：菜单项装配 + 视口钳位。
 * 单独抽出来的原因：仓库测试跑在 node 环境（无 jsdom），能测的只有纯函数。
 */

export type MenuAction =
  | 'copy'
  | 'paste'
  | 'paste-plain'
  | 'view'
  | 'ocr'
  | 'qr'
  | 'optimize'
  | 'assist'
  | 'tags'
  | 'folder'
  | 'pin'
  | 'remove';

export interface MenuItem {
  action: MenuAction;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
}

/** 装配菜单项所需的卡片信息（与 ClipItemDTO 的对应字段同构）。 */
export interface MenuSource {
  kind: string;
  pinned: boolean;
  truncated?: boolean;
  hasFullText?: boolean;
}

const DEFAULT_MARGIN = 8;

/**
 * 固定顺序：
 * view → ocr → qr → copy → paste → paste-plain → optimize → assist → tags → folder → pin → remove。
 * view 放最前是因为它只在「有更多内容可看」时出现，属于第一意图；
 * ocr 紧跟 view：图片上的第一意图是看图，第二才是把图里的字抠出来；
 * qr 再紧跟 ocr —— 两者都是「把图里的信息抠出来」，用户在这两种意图之间切换时
 * 不该被「复制 / 粘贴」这类通用动作隔开。
 * assist 紧跟 optimize：两者都是「对文本做加工」（optimize 只管提示词，assist 是
 * 翻译 / 总结 / 改写这类通用加工），意图相邻，中间不该被归类动作隔开。
 * tags / folder 排在 optimize / assist 之后、pin 之前：它们与 optimize 同属「对这条记录
 * 做点什么」的加工类动作，而 pin / remove 是改变记录去留的收尾项 —— 破坏性的 remove 永远压末尾。
 */
export function menuItemsFor(item: MenuSource): MenuItem[] {
  const isImage = item.kind === 'image';
  const items: MenuItem[] = [];

  if (isImage || item.truncated === true || item.hasFullText === true) {
    items.push({ action: 'view', label: isImage ? '查看大图' : '查看全文' });
  }

  // 只给图片：OCR 的输入是图片记录，文本记录没有可识别的像素。
  if (isImage) items.push({ action: 'ocr', label: '识别文字' });
  // 同样只给图片：二维码得从像素里解，且文案不带省略号 —— 点了立刻开面板识别，
  // 不像「标签…」那样还要再选一次。
  if (isImage) items.push({ action: 'qr', label: '识别二维码' });

  items.push({ action: 'copy', label: '复制到剪贴板' });
  items.push({ action: 'paste', label: '复制并粘贴' });

  // 只给文本类记录：图片没有"纯文本"可贴，文件列表贴成纯文本会退化成路径串。
  if (!isImage) items.push({ action: 'paste-plain', label: '粘贴为纯文本' });

  if (!isImage) items.push({ action: 'optimize', label: '优化提示词' });

  // 只给文本：AI 助手处理的是文本内容，图片记录没有可翻译/总结的文字。
  // 文案带省略号：点了先开面板选动作，不是立刻执行。
  if (!isImage) items.push({ action: 'assist', label: 'AI 助手…' });

  // ★ 标签与文件夹对文本和图片**都**给：它们是记录级属性（items.tags / items.folder_id
  //   两列与 kind 无关），不是内容级操作。图片记录同样需要"这是哪张图"的归类，
  //   按 kind 砍掉只会逼用户为同一件事准备两种操作路径。
  items.push({ action: 'tags', label: '标签…' });
  items.push({ action: 'folder', label: '移动到文件夹…' });

  items.push({ action: 'pin', label: item.pinned ? '取消收藏' : '收藏', hint: 'Ctrl+D' });
  items.push({ action: 'remove', label: '删除', danger: true });

  return items;
}

/**
 * 把菜单左上角钳进视口；下方放不下时上翻，翻上去仍越界再钳一次（不允许出负坐标）。
 * 视口小于菜单本身时以 margin 为下限，宁可溢出右/下边也不让左上角飞出屏幕。
 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = DEFAULT_MARGIN,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);

  let left = Math.min(Math.max(x, margin), maxX);
  let top = Math.min(Math.max(y, margin), maxY);

  if (y + size.height > viewport.height - margin) {
    top = Math.min(Math.max(y - size.height, margin), maxY);
  }

  return { x: left, y: top };
}

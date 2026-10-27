/**
 * 二维码面板的纯函数。与 ocrView.ts 同一处理：
 * 仓库测试跑在 node 环境（无 jsdom），组件不可测，能测的只有纯函数。
 */

/** 二维码浮层的四种落点 + 未开始。'found' 才算有东西可复制 / 可存。 */
export type QrStatus = 'idle' | 'loading' | 'found' | 'empty' | 'error';

/**
 * 状态归一：error 优先，其次没结果、空白结果、有结果。
 * ★ error 先于一切：识别抛错时 result 往往还是 null，
 *   若先判 null 就会把「识别失败」显示成一句「正在识别…」。
 * ★ 空白串算 empty 而不是 found：主进程约定"未识别到二维码返回空串、永不抛"，
 *   把空串当成有结果会让「复制」「存为记录」按钮亮着却什么都复制不到。
 */
export function qrStatusOf(result: string | null, error: string | null): QrStatus {
  const err = error?.trim() ?? '';
  if (err !== '') return 'error';
  if (result === null) return 'idle';
  if (result.trim() === '') return 'empty';
  return 'found';
}

/** 状态 → 面板中央那句中文。found 不用文案（结果本身就显示在那儿）。 */
export function qrMessageOf(status: QrStatus): string {
  switch (status) {
    case 'loading':
      return '正在识别…';
    case 'empty':
      return '这张图里没找到二维码';
    case 'error':
      return '识别失败';
    default:
      return '';
  }
}

/**
 * 结果看着像不像一个链接（只做前缀判断，不解析 URL）。
 * ★ 只判 http/https：二维码里装的最常见的坑是 tel: / mailto: / WIFI: 这类载荷，
 *   它们同样"能复制"，但提示成「这是一个链接」会让用户以为点得开。
 */
export function qrLooksLikeUrl(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

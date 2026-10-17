/**
 * 静态资源地址。仓库根的 assets/icon.png 是应用图标（spec §6.1：空状态用图标本身，
 * 不做线稿插画）。
 *
 * 这里用 new URL(..., import.meta.url) 交给打包器改写，而不是 import 二进制资源，
 * 因为 core 的 tsconfig 只带 node 类型，没有 vite/client 的 *.png 模块声明。
 */
export const APP_ICON_URL = new URL('../../../../assets/icon.png', import.meta.url).href;

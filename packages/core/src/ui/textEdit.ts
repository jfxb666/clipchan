/**
 * 条目快速编辑再粘贴（v1.2 A2）的纯逻辑。
 *
 * ★ 为什么单独抽文件：仓库测试跑在 node 环境（无 jsdom），组件里的交互判定
 *   必须落成纯函数才能测 —— 与 snippetView.ts 同一条纪律。
 */

/**
 * 编辑态的动作可用性。
 * ★ 内容与原条目相同也算可粘贴：用户可能就是要原样重粘一遍，不做"无变化"拦截。
 */
export function editTextActions(edited: string): { canPaste: boolean } {
  return { canPaste: edited.trim().length > 0 };
}

import type { Scene } from './scenes';
import type { ChatMessage } from './types';

/** 优化目标：用户提示词 / 系统（角色）提示词（需求定稿 Q2：两者都要）。 */
export type TargetMode = 'user' | 'system';

/** 优化器自身的角色说明（消息 0）。 */
const OPTIMIZER_ROLE = [
  '你是提示词优化器，只做一件事：把用户给的零散文字改写成按场景可直接使用的高质量提示词。',
  '你的产出会被原样复制去用，所以不要寒暄、不要解释你的思路、不要评价这份需求。',
  '严格按用户消息里给出的场景方法论规则改写；规则与用户原意冲突时，先满足用户原意。',
].join('\n');

/** 输出格式契约：优化引擎的解析层与 UI 都按这两个标签工作（Task 4 Step 3/4）。 */
const FORMAT_CONTRACT = [
  '输出格式（必须严格遵守，不要输出这两个标签以外的任何文字）：',
  '第一段：<optimized>最终成品写在这里</optimized>；标签内不要出现任何解释、标题或代码块围栏。',
  '第二段：<notes>改动说明</notes>；每条改动一行、以 "- " 开头，没有改动就写 "- 无"。',
];

/** 场景方法论规则逐条注入。 */
function rulesBlock(scene: Scene): string[] {
  return ['场景方法论规则（逐条落实）：', ...scene.rules.map((rule, i) => `${i + 1}. ${rule}`)];
}

/** 用户的附加要求：只在真的传了 extra 时才出现，避免模板里出现字符串 undefined。 */
function extraBlock(extra?: string): string[] {
  return extra ? ['用户附加要求：', extra] : [];
}

/** 素材引用块：原文只在需要它的模式下出现，且用引号围起来避免被当成指令执行。 */
function materialBlock(text: string): string[] {
  return ['原文：', '"""', text, '"""'];
}

/**
 * 组装元提示词：消息 0 是优化器角色，消息 1 是本次任务说明。
 *
 * 两种模式的模板实际不同（Review Focus 5）：
 * - \`user\`：产出可直接发给 AI 的用户提示词，任务说明里带原文。
 * - \`system\`：产出角色 / 约束型 system prompt，只抽象角色与边界，
 *   素材作为背景资料随系统消息下发，任务正文不复述用户的一次性细节。
 */
export function buildMetaPrompt(input: {
  text: string;
  scene: Scene;
  mode: TargetMode;
  extra?: string;
}): ChatMessage[] {
  const { text, scene, mode, extra } = input;

  const systemTail =
    mode === 'system'
      ? [
          '本次要做的是 system prompt（角色设定）：素材只用于推断角色身份与约束边界，不要照抄素材里的具体任务、数字与时间。',
          '背景素材：',
          '"""',
          text,
          '"""',
        ]
      : ['本次要做的是用户提示词：原文会随任务说明一起给你。'];

  const task =
    mode === 'system'
      ? [
          '任务：把上面的背景素材提炼成一段 system prompt，用来定义一个 AI 角色的身份与工作方式。',
          '要求：按「角色身份 → 能力边界 → 输出规范 → 拒答策略」四块组织；写成对 AI 的第二人称指令；只保留可复用的角色与约束，不复述素材里的具体任务；不确定的身份细节用方括号占位（如 [角色名]）。',
        ]
      : [
          '任务：把下面的原文改写成一条可直接发给 AI 的用户提示词。',
          '要求：保留用户原意；补足缺失的角色与目标、上下文、输出格式与长度、约束条件；不确定的细节用方括号占位（如 [受众]），不要编造事实。',
        ];

  const userParts = [
    ...task,
    ...rulesBlock(scene),
    ...extraBlock(extra),
    ...(mode === 'user' ? materialBlock(text) : []),
    ...FORMAT_CONTRACT,
  ];

  return [
    { role: 'system', content: [OPTIMIZER_ROLE, ...systemTail].join('\n\n') },
    { role: 'user', content: userParts.join('\n') },
  ];
}

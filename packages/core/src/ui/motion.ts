/**
 * 动效层共享预设（P3 动效层，MOTION 6「更明显」档）。
 *
 * 设计契约（动效铁律，逐条对齐）：
 *  - 每处动效必须**有动机**（反馈 / 状态过渡 / 层级），动机写在各使用点的注释里；
 *  - framer-motion 只动 transform 与 opacity，绝不动画 top/left/width/height；
 *  - 全部动效在 prefers-reduced-motion 下退化为「无动画」（useRespectReducedMotion
 *    分支：initial=false + 空 animate/exit，元素直接落位）；CSS 动画（FLASH）在
 *    tokens.css 里用 @media (prefers-reduced-motion: no-preference) 包住，同一铁律；
 *  - 家族曲线沿用既有 house spring cubic-bezier(0.22,1.2,0.36,1)（Tailwind ease-spring
 *    与 .cc-pop 的同一根曲线），不引入第二套节奏。
 *
 * 纯预设不依赖组件与 store；useRespectReducedMotion 是 framer-motion useReducedMotion
 * 的薄包装（把 null 归一成 false），除此之外全部是可单测的纯函数（见 motion.spec.ts）。
 */
import { useReducedMotion } from 'framer-motion';
import type { TargetAndTransition, Transition } from 'framer-motion';

/** 家族曲线（= tokens.css .cc-pop / tailwind ease-spring 的同一根三次贝塞尔）。 */
export const HOUSE_EASE: [number, number, number, number] = [0.22, 1.2, 0.36, 1];

/**
 * 浮层进出的 spring（house 曲线 200ms）：带轻微过冲，弹出「到位」而不是「漂到位」。
 * POP_IN 与它同参：浮层入场 = scale 0.96→1 + 淡入，用这一条曲线。
 */
export const SPRING: Transition = { duration: 0.2, ease: HOUSE_EASE };
export const POP_IN: Transition = SPRING;

/** 淡入 160ms / 淡出 150ms：遮罩、提示条这类轻量进出（都在 150-200ms 档内）。 */
export const FADE_IN: Transition = { duration: 0.16, ease: 'easeOut' };
export const FADE_OUT: Transition = { duration: 0.15, ease: 'easeIn' };

/** toast 滑入（y: 8→0 + 淡入）200ms；滑出复用 FADE_OUT。 */
export const RISE: Transition = { duration: 0.2, ease: 'easeOut' };

/**
 * 把 useReducedMotion 的三态（true/false/null）归一成布尔。
 * null = 用户没有表达偏好 → 照常播放。
 */
export function useRespectReducedMotion(): boolean {
  return useReducedMotion() ?? false;
}

/** 一次进/出动画的三件套（spread 到 motion 组件上使用）。 */
export interface PresenceMotion {
  initial: TargetAndTransition | boolean;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

/** reduced-motion 下的降级：不设初始偏移（initial=false 直接落位），进出零时长。 */
const NO_MOTION: PresenceMotion = { initial: false, animate: {}, exit: {} };

/**
 * 浮层弹出（TextViewer / OCR / 二维码 / 整理弹窗 / 右键菜单 / AI 助手页）：
 * scale 0.96→1 + 淡入 200ms house 曲线；退出反向 150ms。
 * 动机（统一）：浮层是「从无到有盖上来」的层级切换，进出都有动画才不会显得突兀。
 */
export function popMotion(reduced: boolean): PresenceMotion {
  if (reduced) return NO_MOTION;
  return {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: POP_IN },
    exit: { opacity: 0, scale: 0.96, transition: FADE_OUT },
  };
}

/** 遮罩淡入淡出：只动 opacity（scrim 本身没有形体，缩放没有意义）。 */
export function fadeMotion(reduced: boolean): PresenceMotion {
  if (reduced) return NO_MOTION;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: FADE_IN },
    exit: { opacity: 0, transition: FADE_OUT },
  };
}

/** toast 滑入滑出：y 8→0 + 淡入 200ms；退出反向（同一副面孔进、同一副面孔出）。 */
export function riseMotion(reduced: boolean): PresenceMotion {
  if (reduced) return NO_MOTION;
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: RISE },
    exit: { opacity: 0, y: 8, transition: FADE_OUT },
  };
}

/**
 * 挂载入场（空状态、搜索语法提示这类只进不出的元素）：fade + 上移 8px，150ms。
 * exit 留空：没有 AnimatePresence 时这个字段是惰性的，保留形状只为 spread 一致。
 */
export function enterMotion(reduced: boolean): PresenceMotion {
  if (reduced) return NO_MOTION;
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.15, ease: 'easeOut' } },
    exit: {},
  };
}

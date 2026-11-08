import { describe, expect, it } from 'vitest';
import {
  enterMotion,
  FADE_IN,
  FADE_OUT,
  fadeMotion,
  HOUSE_EASE,
  POP_IN,
  popMotion,
  RISE,
  riseMotion,
  SPRING,
} from './motion';

/**
 * 动效预设的可测面：只测纯函数（transitions 与 reduced-motion 降级形状）。
 * 组件层的进出场表现归 smoke / 人工验收；这里守住的是「参数契约」与
 * 「reduced-motion 必须退化」这条铁律不被悄悄改掉。
 */
describe('motion 预设', () => {
  it('HOUSE_EASE 是家族曲线 cubic-bezier(0.22, 1.2, 0.36, 1)', () => {
    expect(HOUSE_EASE).toEqual([0.22, 1.2, 0.36, 1]);
  });

  it('SPRING / POP_IN 用 house 曲线，时长 200ms（150-200ms 档）', () => {
    expect(SPRING).toEqual({ duration: 0.2, ease: HOUSE_EASE });
    expect(POP_IN).toBe(SPRING);
  });

  it('FADE_IN / FADE_OUT 时长落在 150-200ms 档', () => {
    expect(FADE_IN.duration).toBeGreaterThanOrEqual(0.15);
    expect(FADE_IN.duration).toBeLessThanOrEqual(0.2);
    expect(FADE_OUT.duration).toBeGreaterThanOrEqual(0.15);
    expect(FADE_OUT.duration).toBeLessThanOrEqual(0.2);
  });

  it('RISE 是 toast 的 200ms 滑入', () => {
    expect(RISE).toEqual({ duration: 0.2, ease: 'easeOut' });
  });
});

describe('popMotion（浮层弹出）', () => {
  it('正常路径：scale 0.96→1 + 淡入，退出反向', () => {
    const motion = popMotion(false);
    expect(motion.initial).toEqual({ opacity: 0, scale: 0.96 });
    expect(motion.animate).toEqual({ opacity: 1, scale: 1, transition: POP_IN });
    expect(motion.exit).toEqual({ opacity: 0, scale: 0.96, transition: FADE_OUT });
  });

  it('reduced-motion：不设初始偏移、进出为空（直接落位，无动画）', () => {
    const motion = popMotion(true);
    expect(motion.initial).toBe(false);
    expect(motion.animate).toEqual({});
    expect(motion.exit).toEqual({});
  });
});

describe('fadeMotion（遮罩淡入淡出）', () => {
  it('正常路径：只动 opacity，进出带 FADE_IN / FADE_OUT', () => {
    const motion = fadeMotion(false);
    expect(motion.initial).toEqual({ opacity: 0 });
    expect(motion.animate).toEqual({ opacity: 1, transition: FADE_IN });
    expect(motion.exit).toEqual({ opacity: 0, transition: FADE_OUT });
  });

  it('reduced-motion：无动画', () => {
    expect(fadeMotion(true)).toEqual({ initial: false, animate: {}, exit: {} });
  });
});

describe('riseMotion（toast 滑入滑出）', () => {
  it('正常路径：y 8→0 + 淡入 200ms，退出反向', () => {
    const motion = riseMotion(false);
    expect(motion.initial).toEqual({ opacity: 0, y: 8 });
    expect(motion.animate).toEqual({ opacity: 1, y: 0, transition: RISE });
    expect(motion.exit).toEqual({ opacity: 0, y: 8, transition: FADE_OUT });
  });

  it('reduced-motion：无动画', () => {
    expect(riseMotion(true)).toEqual({ initial: false, animate: {}, exit: {} });
  });
});

describe('enterMotion（挂载入场）', () => {
  it('正常路径：fade + 上移 8px，150ms', () => {
    const motion = enterMotion(false);
    expect(motion.initial).toEqual({ opacity: 0, y: 8 });
    expect(motion.animate).toEqual({
      opacity: 1,
      y: 0,
      transition: { duration: 0.15, ease: 'easeOut' },
    });
  });

  it('reduced-motion：无动画', () => {
    expect(enterMotion(true)).toEqual({ initial: false, animate: {}, exit: {} });
  });
});

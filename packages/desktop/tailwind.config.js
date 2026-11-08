/**
 * 渲染进程的 Tailwind 配置。
 * ★ 用 Tailwind 3.4（不是 v4），与 packages/core 的 devDependency 对齐。
 * ★ content 必须同时覆盖 core 的组件与 desktop 的入口，否则 core/ui 里的类名会被摇掉。
 * ★ 令牌映射与 packages/core/tailwind.config.ts 保持一致（core 那份是 .ts，Tailwind
 *   读取它要装 jiti；这里用纯 JS 复制一份，避免多一个构建期依赖）。
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../core/src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--cc-bg)',
        surface: 'var(--cc-surface)',
        'surface-2': 'var(--cc-surface-2)',
        ink: 'var(--cc-text)',
        'ink-2': 'var(--cc-text-2)',
        'ink-3': 'var(--cc-text-3)',
        primary: 'var(--cc-primary)',
        'primary-soft': 'var(--cc-primary-soft)',
        accent: 'var(--cc-accent)',
        'accent-soft': 'var(--cc-accent-soft)',
        /* 彩色底上的文字（主/警示按钮标签）与危险语义 —— P1 收口新增。 */
        'on-primary': 'var(--cc-on-primary)',
        'on-accent': 'var(--cc-on-accent)',
        danger: 'var(--cc-danger)',
        warm: 'var(--cc-warm)',
        pink: 'var(--cc-pink)',
        line: 'var(--cc-border)',
        'line-strong': 'var(--cc-border-strong)',
        /* 模态浮层的压暗层。 */
        scrim: 'var(--cc-scrim)',
        /* 六类类型徽章底色（badge fg 走 warm/pink/primary/accent）。 */
        'badge-text': 'var(--cc-badge-text-bg)',
        'badge-link': 'var(--cc-badge-link-bg)',
        'badge-code': 'var(--cc-badge-code-bg)',
        'badge-image': 'var(--cc-badge-image-bg)',
        'badge-path': 'var(--cc-badge-path-bg)',
        'badge-number': 'var(--cc-badge-number-bg)',
      },
      borderRadius: {
        card: 'var(--cc-radius-card)',
        button: 'var(--cc-radius-button)',
        input: 'var(--cc-radius-input)',
      },
      fontFamily: {
        sans: ['var(--cc-font)'],
        mono: ['var(--cc-font-mono)'],
      },
      spacing: {
        micro: '4px',
        tight: '8px',
        snug: '12px',
        base: '16px',
        comfortable: '24px',
        loose: '32px',
        section: '64px',
      },
      boxShadow: {
        card: 'var(--cc-shadow-sm)',
        panel: 'var(--cc-shadow)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.22, 1.2, 0.36, 1)',
      },
    },
  },
  plugins: [],
};

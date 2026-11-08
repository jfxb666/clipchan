import type { Config } from 'tailwindcss';

/**
 * 令牌全部映射到 CSS 变量，变量定义在 src/theme/tokens.css。
 * 这样明暗主题只切换 data-theme，不必重新生成类名。
 */
const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    '../desktop/src/**/*.{ts,tsx}',
    '../mobile/src/**/*.{ts,tsx}',
  ],
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

export default config;

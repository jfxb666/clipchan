import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.spec.ts', 'packages/**/*.spec.tsx'],
    environment: 'node',
    globals: false,
    // 冷启动全量跑时 better-sqlite3 开库 + 建表偶尔超过默认 5s（migrate-runner 单项就要 4.3s），
    // 默认 5s 会假失败。20s 只放宽上限，不放宽断言。
    testTimeout: 20000,
  },
});

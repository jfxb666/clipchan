/// <reference types="vite/client" />

/**
 * Vite 客户端类型（import.meta.env、CSS 副作用导入、?url 后缀等）。
 * 手机端没有 postcss/tailwind 链路，但 main.tsx 需要 `import './index.css'` 这类
 * 副作用导入，缺这份声明 tsc 会报 "找不到模块"。
 */

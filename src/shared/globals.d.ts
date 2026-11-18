/**
 * 构建时注入的全局常量。
 * 具体值由 electron.vite.config.ts / vitest.config.mts 从 package.json 的 version 字段注入，
 * 保证应用内显示的版本号只有一个来源。
 */
declare const __APP_VERSION__: string

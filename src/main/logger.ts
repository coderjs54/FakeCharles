import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 单个日志文件的最大字节数，超过后轮转为 main.1.log */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 导出诊断文件时附带最近多少字节的日志 */
const DIAGNOSTIC_LOG_BYTES = 256 * 1024

let logDirectory = ''
let logFilePath = ''

/** 把未知错误转换成可读的堆栈文本 */
function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** 初始化文件日志：创建目录，并在旧日志过大时轮转 */
export function initLogger(directory: string): string {
  logDirectory = directory
  logFilePath = join(directory, 'main.log')
  try {
    mkdirSync(directory, { recursive: true })
    if (existsSync(logFilePath) && statSync(logFilePath).size > MAX_LOG_BYTES) {
      renameSync(logFilePath, join(directory, 'main.1.log'))
    }
  } catch (error) {
    // 日志目录不可写时只回退到控制台，不能影响应用启动
    console.error(`[logger] 初始化日志目录失败: ${formatError(error)}`)
  }
  return logFilePath
}

export function getLogDirectory(): string {
  return logDirectory
}

/** 追加一行日志到文件；写入失败时静默忽略，避免递归报错 */
function writeLine(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (!logFilePath) return
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
  try {
    appendFileSync(logFilePath, line, 'utf8')
  } catch {
    // 日志写入失败不能影响主流程
  }
}

/** 记录普通运行信息 */
export function logInfo(message: string): void {
  console.log(`[FakeCharles] ${message}`)
  writeLine('INFO', message)
}

/** 记录警告信息 */
export function logWarn(message: string): void {
  console.warn(`[FakeCharles] ${message}`)
  writeLine('WARN', message)
}

/** 记录错误信息与可选异常对象 */
export function logError(message: string, error?: unknown): void {
  const detail = error === undefined ? message : `${message}: ${formatError(error)}`
  console.error(`[FakeCharles] ${detail}`)
  writeLine('ERROR', detail)
}

/** 读取最近一段日志内容，供诊断导出使用 */
export function readRecentLogs(maxBytes = DIAGNOSTIC_LOG_BYTES): string {
  if (!logFilePath || !existsSync(logFilePath)) return ''
  try {
    const content = readFileSync(logFilePath, 'utf8')
    return content.length > maxBytes ? content.slice(-maxBytes) : content
  } catch {
    return ''
  }
}

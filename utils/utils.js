import { spawn } from 'child_process'

/** 延时 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待本地 api 服务就绪（启动竞态修复）。
 * 原先各脚本在 startService() 后盲目 delay(2000)，
 * 在冷启动的 Actions runner 上可能因服务未就绪导致首个请求失败/超时。
 * 改为轮询探测：服务端口可响应任意 HTTP 即视为就绪，最多等待 timeoutMs。
 * @param {string} base 服务地址
 * @param {number} timeoutMs 最长等待毫秒
 */
async function waitForApi(base = 'http://127.0.0.1:3000', timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(base + '/user/detail', { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      // 任意 HTTP 响应（含 4xx/5xx）都说明服务已在监听端口
      return true
    } catch (err) {
      // 连接被拒（ECONNREFUSED）等服务尚未就绪，稍后重试
      await delay(500)
    }
  }
  throw new Error(`本地 API 服务在 ${timeoutMs}ms 内未就绪`)
}

/** 启动 api 服务（detached 使其成为独立进程组，便于整组强杀） */
function startService() {
  // 测试/调试钩子：设置 KUGOU_API_SERVICE_CMD 可直接指定服务启动命令，
  // 便于在没有 npm 的环境或用 mock 服务验证主流程，生产环境不设置即走默认 npm 脚本。
  const customCmd = process.env.KUGOU_API_SERVICE_CMD
  let child
  if (customCmd) {
    child = spawn(customCmd, [], {
      detached: false,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    child = spawn('npm', ['run', 'apiService'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  // 以前只在 stderr 有内容时才打印，且 stdout 直接丢弃：
  // 一旦 api 服务起不来（依赖没装、端口占用、npm 不存在），日志里只剩
  // "子进程退出 code=1"，完全看不出原因。现在把子进程输出转发出来，并捕获 spawn 失败。
  child.stdout.on('data', (data) => {
    const msg = String(data).trimEnd()
    if (msg) console.log('[api]', msg)
  })
  child.stderr.on('data', data => {
    const msg = String(data).trimEnd()
    if (msg) console.log('[api stderr]', msg)
  })
  child.on('error', error => {
    console.log(`[api] 启动失败：${error.code || ''} ${error.message}`)
  })
  child.on('close', code => console.log(`[api] 子进程退出，code=${code}`))

  return child
}

/**
 * 关闭 api 服务。
 * 关键修复：npm 不会把 SIGTERM 转发给它的子进程（真正的 Express 服务），
 * 仅 api.kill() 会导致 3000 端口一直被占 → 下一阶段 startService 报 EADDRINUSE。
 * 因此用 detached 进程组 + process.kill(-pid) 强杀整组。
 */
function close_api(api) {
  if (!api || !api.pid) return
  try {
    process.kill(-api.pid, 'SIGKILL') // 杀掉整个进程组（npm + Express）
  } catch (e) {
    try { api.kill('SIGKILL') } catch (_) { /* 已退出 */ }
  }
}

/**
 * 发送请求到本地 api 服务（带超时 + 重试）
 * 超时 10 秒，失败后指数退避重试最多 3 次
 */
async function send(path, method, headers) {
  const MAX_RETRIES = 3
  const TIMEOUT_MS = 10000
  let lastError

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch('http://127.0.0.1:3000' + path, {
        method,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await resp.json()
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        console.log(`[send] 第 ${attempt + 1} 次请求失败，${waitMs}ms 后重试: ${err.message}`)
        await delay(waitMs)
      }
    }
  }
  throw lastError
}

export { delay, startService, close_api, send, waitForApi }

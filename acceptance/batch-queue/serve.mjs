// Batch 验收用静态服务器：托管 dist/frontend 构建产物 + SPA fallback + stub 注入
// 用法：node serve.mjs <port>   （须先构建前端：pnpm run build:frontend）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本目录固定为 <repo>/acceptance/batch-queue/，dist 在 <repo>/packages/frontend/dist/frontend/
const ROOT = fileURLToPath(new URL('../../packages/frontend/dist/frontend/', import.meta.url))
const STUB = fileURLToPath(new URL('./stub.js', import.meta.url))
const port = Number(process.argv[2] || 5174)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// 普通 script（非 module）在解析到 </body> 前同步执行，早于 head 中 defer 的
// module 入口，可保证 app boot 的 fetch 已被 stub 拦截。
const STUB_TAG = '<script src="/__batch_stub.js"></script>'

async function serveStub(res) {
  try {
    const body = await readFile(STUB)
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('stub not found')
  }
}

async function serveHtml(res) {
  try {
    const idx = (await readFile(join(ROOT, 'index.html'))).toString()
    const injected = idx.includes('</body>')
      ? idx.replace('</body>', STUB_TAG + '</body>')
      : idx + STUB_TAG
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(injected)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = decodeURIComponent(url.pathname)
  if (pathname === '/__batch_stub.js') return serveStub(res)

  let p = pathname
  if (p === '/') p = '/index.html'
  // SPA fallback：无扩展名或未命中文件 → index.html（带 html accept 或 * 均兜底）
  const rel = normalize(p).replace(/^([/\\])+/, '')
  const filePath = join(ROOT, rel)
  try {
    const body = await readFile(filePath)
    // html 命中时同样注入 stub（/ 与 /index.html 会走此分支）
    if (extname(filePath) === '.html') return serveHtml(res)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    await serveHtml(res)
  }
}).listen(port, '127.0.0.1', () => console.log(`batch-verify static server on http://127.0.0.1:${port}`))

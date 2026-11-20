<template>
  <!-- dsh 同款轮子：marked 解析 + DOMPurify 消毒（聊天安全姿态：
       标签/事件属性全剥，仅保留 GFM 结构化输出）。
       交互：代码块带语言标签 + 一键复制；外链强制新开（Electron 里
       经 setWindowOpenHandler 兜底走系统浏览器）。
       C10 增量化：默认（非流式）仍是一次性全量渲染，字节级不变；
       传 streaming 时进入流式模式 —— 16ms 节流合并 delta，按 markdown
       块边界把「稳定前缀」（缓存命中不重解析）与「未定尾段」（每次重解析，
       宁可多留最后一整块）分开渲染；streaming 翻回 false 时无条件做一次
       全量 parse+sanitize，保证最终 HTML 与一次性渲染逐字节一致。 -->
  <div ref="root" class="wb-md" @click="onRootClick" v-html="html"></div>
</template>

<script>
// 普通模块块：导出规范化的一次性渲染与纯函数切块器。增量路径与测试共用
// 同一份实现，保证「增量收敛目标 === 全量渲染」不是测试内复刻出来的巧合。
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// ---------- i18n（轻量：组件内直读 localStorage 语言） ----------
function tt(key, fallbackZh, fallbackEn) {
  try {
    const lang = localStorage.getItem('lang') || 'zh'
    // 文案极短，直接内置双份，避免为两个键挂全局 i18n
    return lang === 'en' ? fallbackEn : fallbackZh
  } catch {
    return fallbackZh
  }
}

// ---------- marked 配置（GFM + breaks + 代码块改造） ----------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const copyLabel = () => tt(null, '复制', 'Copy')
const copiedLabel = () => tt(null, '已复制', 'Copied')

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // marked v16+: token 对象入参；把裸 <pre> 改造成带头部（语言 + 复制按钮）
    // 的卡片结构。按钮不依赖任何 JS 数据——点击时从最近 pre>code 取原文。
    // 复制按钮直接烤进渲染产物 → 增量路径天然自带按钮，无需 DOM 后处理。
    code(token) {
      const lang = (token.lang || '').trim().split(/\s+/)[0] || 'text'
      return (
        `<div class="wb-md-code">` +
        `<div class="wb-md-code-head"><span class="wb-md-lang">${escapeHtml(lang)}</span>` +
        `<button type="button" class="wb-md-copy" data-label="${copyLabel()}">${copyLabel()}</button>` +
        `</div>` +
        `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(token.text)}</code></pre>` +
        `</div>`
      )
    },
  },
})

// ---------- DOMPurify：放行 button 与 A 的 target/rel ----------
let purifyHooked = false
function ensurePurifyHook() {
  if (purifyHooked) return
  purifyHooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'BUTTON') {
      node.setAttribute('type', 'button')
    }
  })
}

/**
 * 规范化渲染（一次性全量 parse + sanitize）。旧版 computed 的唯一实现，
 * 现在同时是：非流式路径、流式结束终态渲染的公共出口。
 */
// FORBID_ATTR style：DOMPurify 默认放行 style（Chromium 实测），聊天源里
// 注入 position:fixed 全屏覆盖即可钓鱼；markdown 正常渲染不产生 style，禁之零损。
const SANITIZE_OPTS = {
  ADD_TAGS: ['button'],
  ADD_ATTR: ['data-label'],
  FORBID_ATTR: ['style'],
}

function parseMarkdown(source) {
  return marked.parse(source, { async: false })
}

export function renderMarkdown(source) {
  if (!source) return ''
  ensurePurifyHook()
  return DOMPurify.sanitize(parseMarkdown(source), SANITIZE_OPTS)
}

// ---------- 块边界切分（纯函数，供流式增量使用） ----------
// 目标：在 source 里找一个「可以安全提交」的前缀切点 stable cut：
//  - 切点必须是块边界（非空行后紧跟空行），且空行之后还有后续内容（保证
//    最后一个完整块永远留在尾段重解析，宁多勿少）；
//  - 切点不能落在未闭合 fenced code 内；
//  - 块尾行是「可能被后续内容续写」的形状时不得提交（列表项 / 引用行 /
//    表格行 / 缩进代码 / 原生 HTML 行 / hr/setext 下划线）——这些结构
//    跨空行仍会和后文合并（松散列表、blockquote 多段等），启发式切块
//    会产生中途视觉偏差，全部保守留尾。
// 最终一致性不依赖该启发式（streaming 结束强制全量重渲染），这里只影响
// 流式过程中的性能与中途观感，因此宁可切得少（尾段变长、每帧多解析）。
const RE_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const RE_QUOTE = /^ {0,3}>/
const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
// hr / setext 下划线行（--- *** ___ ===）——保守不作为块尾
const RE_RULE_LINE = /^ {0,3}[-*_=]{1,}[ \t]*$/
// 链接引用定义行（[label]: url）。引用定义可出现在文档任意块，会给前文中
// 的 [label] 使用处补渲染成链接 → 破坏「前缀渲染不变」前提。源文一旦出现
// 定义行，增量切分整体放弃（cut=0 = 本帧退化为全量渲染，仍安全）。
const RE_REF_DEF = /^ {0,3}\[[^\]\n]+\]:/

function isBlankLine(t) {
  return /^[ \t]*$/.test(t)
}

function isContinuableLastLine(t) {
  if (!t) return true // 空行不当块尾
  if (RE_LIST_ITEM.test(t)) return true // 列表项：空行后可续（松散列表）
  if (RE_QUOTE.test(t)) return true // 引用行：空行后同标记可续
  if (t.includes('|')) return true // 疑似表格行（保守：含竖线即留尾）
  if (/^ {4}/.test(t) || t[0] === '\t') return true // 缩进代码
  if (/^ {0,3}</.test(t)) return true // 原生 HTML 块（可能含跨空行结构）
  if (RE_RULE_LINE.test(t)) return true // hr / setext 下划线（保守）
  return false
}

export function computeStableCut(source) {
  if (!source) return 0
  // 逐行扫描（记录偏移），同时跟踪 fence 开闭状态。text 统一去掉行尾 \r，
  // 判定（含邻居行的空行判定）一律用规范化后的文本。
  const lines = []
  let pos = 0
  while (pos < source.length) {
    const nl = source.indexOf('\n', pos)
    if (nl === -1) {
      lines.push({
        start: pos,
        end: source.length,
        hasNl: false,
        text: source.slice(pos).replace(/\r$/, ''),
      })
      break
    }
    lines.push({ start: pos, end: nl, hasNl: true, text: source.slice(pos, nl).replace(/\r$/, '') })
    pos = nl + 1
  }
  // 引用定义行存在 → 整帧全量（见 RE_REF_DEF 注释）
  for (const line of lines) {
    if (RE_REF_DEF.test(line.text)) return 0
  }
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  // 有界性：只扫描到最后一个非空行为止。随后的 append 不可能改变「最后一个
  // 非空行」之前的历史判定 → 切点随内容单调推进，单条前缀缓存永不失效。
  let lastNonBlank = -1
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i].text)) lastNonBlank = i
  }
  let bestCut = 0
  for (let i = 0; i <= lastNonBlank; i++) {
    const line = lines[i]
    const text = line.text
    if (inFence) {
      // 闭合 fence（同字符、长度不小于开启、无 info 串）→ 落回普通判定；
      // 否则整行是代码内容，跳过（fence 内的空行绝不构成切点）
      if (new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*$`).test(text)) {
        inFence = false
      } else {
        continue
      }
    } else {
      const open = text.match(RE_FENCE_OPEN)
      if (open) {
        inFence = true
        fenceChar = open[1][0]
        fenceLen = open[1].length
        continue
      }
    }
    // 候选切点：非空行 + 紧跟空行 + 空行之后仍有非空内容（尾段非空，
    // 最后一个完整块永远留在尾段）
    if (isBlankLine(text)) continue
    const next = lines[i + 1]
    if (i + 1 > lastNonBlank || !isBlankLine(next.text)) continue
    let hasLater = false
    for (let j = i + 1; j <= lastNonBlank; j++) {
      if (!isBlankLine(lines[j].text)) {
        hasLater = true
        break
      }
    }
    if (!hasLater) continue
    if (isContinuableLastLine(text)) continue
    // 提交：切在该行换行符之后（稳定前缀恒以 \n 结尾，尾段从空行/下块起）。
    // 取最大（最新）合格边界：单调推进、缓存命中率高，首行仍开新块。
    if (line.hasNl) bestCut = line.end + 1
  }
  return bestCut
}
</script>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { message } from 'ant-design-vue'

const props = defineProps({
  source: { type: String, default: '' },
  // C10 流式开关：true 时 delta 走 16ms 节流 + 块边界增量渲染；
  // false / 缺省（既有全部使用方）行为与旧版逐字节一致。
  streaming: { type: Boolean, default: false },
})

const root = ref(null)

// ---------- 渲染状态 ----------
const html = ref('')
let renderCount = 0
function setHtml(next) {
  html.value = next
  renderCount += 1
}

// ---------- 流式增量：稳定前缀缓存 + 尾段重解析 + 16ms 节流 ----------
// 缓存的是稳定前缀的 RAW 解析产物（marked.parse 是主成本，DOMPurify 相对便宜）。
// 每次 flush 只重解析尾段，然后把「稳定 raw + 尾段 raw」做单次整体 sanitize：
//  - 中间帧 HTML 与「对该前缀做一次全量渲染」逐字节一致（sanitize 输入即全量
//    parse 的输出拼接，无分段消毒的边界差异）；
//  - marked 只碰尾段 → 增量的主要收益不变。
const STREAM_FLUSH_MS = 16
let stableCache = { src: '', raw: '' } // 单条缓存：流式 append 时切点单调推进
let lastStreamedSrc = null
let flushTimer = null
// 审查修复 M5:本实例是否真正走过流式增量渲染(终态翻 false 时据此决定
// 是否做全量重渲染——没流过的历史消息跳过,零多余 parse)
let didStream = false

function renderFull(source) {
  cancelFlush()
  // 终态/非流式唯一出口：与一次性全量渲染逐字节一致（结构性保证）
  setHtml(renderMarkdown(source))
}

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    runFlush()
  }, STREAM_FLUSH_MS)
}

function cancelFlush() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function runFlush() {
  if (!props.streaming) return // 终态渲染后迟到的 flush 不覆盖全量结果
  const src = props.source
  if (src === lastStreamedSrc) return // 无新内容的重复 flush：跳过
  lastStreamedSrc = src
  if (!src) {
    stableCache = { src: '', raw: '' }
    setHtml('')
    return
  }
  const cut = computeStableCut(src)
  const stableSrc = cut > 0 ? src.slice(0, cut) : ''
  const tailSrc = cut > 0 ? src.slice(cut) : src
  let stableRaw = ''
  if (stableSrc) {
    if (stableCache.src === stableSrc) {
      stableRaw = stableCache.raw // 前缀未推进：直接复用，不重解析
    } else {
      stableRaw = parseMarkdown(stableSrc)
      stableCache = { src: stableSrc, raw: stableRaw }
    }
  }
  // 尾段重解析（最后一块 + 未完成片段，宁多勿少），整体单次消毒
  ensurePurifyHook()
  const raw = stableRaw + (tailSrc ? parseMarkdown(tailSrc) : '')
  setHtml(DOMPurify.sanitize(raw, SANITIZE_OPTS))
}

watch(
  () => props.source,
  (src) => {
    if (props.streaming) {
      // M5:source 在流式窗口内推进(真正的增量场景)才标记 didStream——
      // 历史消息渲染完成后才进入 busy 的实例不会被误标
      didStream = true
      scheduleFlush()
    } else renderFull(src)
  },
  { immediate: true },
)
watch(
  () => props.streaming,
  (on) => {
    // 翻 true 本身不渲染(等 source 推进);翻 false 按 didStream 决定是否终态全量
    if (on) return
    // 审查修复 M5:run 结束(streaming 翻 false)只对本实例真正走过增量渲染的
    // 消息做终态全量重渲染——历史/回放消息从不进流式模式,零多余 parse。
    if (didStream) {
      didStream = false
      renderFull(props.source)
    }
  },
)
onBeforeUnmount(cancelFlush)

defineExpose({
  // 调试/测试观测点：节流后实际发生的渲染次数（非响应式，仅供读）
  get renderCount() {
    return renderCount
  },
})

// ---------- 事件委托：复制按钮点击（对增量/全量渲染一视同仁） ----------
function onRootClick(e) {
  const btn = e.target?.closest?.('.wb-md-copy')
  if (!btn) return
  const box = btn.closest('.wb-md-code')
  const codeEl = box?.querySelector('pre code')
  if (!codeEl) return
  navigator.clipboard
    .writeText(codeEl.textContent ?? '')
    .then(() => {
      btn.textContent = copiedLabel()
      setTimeout(() => {
        btn.textContent = btn.dataset.label || copyLabel()
      }, 1500)
    })
    .catch(() => message.error(tt(null, '复制失败', 'Copy failed')))
}
</script>

<style>
/* 聊天气泡内的 markdown 排版（紧贴 dsh 侧栏视觉密度） */
.wb-md {
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}
.wb-md > :first-child {
  margin-top: 0;
}
.wb-md > :last-child {
  margin-bottom: 0;
}
.wb-md p {
  margin: 0.4em 0;
}
.wb-md ul,
.wb-md ol {
  margin: 0.4em 0;
  padding-left: 1.4em;
}
.wb-md li {
  margin: 0.15em 0;
}
.wb-md h1,
.wb-md h2,
.wb-md h3,
.wb-md h4 {
  margin: 0.6em 0 0.3em;
  font-weight: 600;
  color: #fff;
}
.wb-md h1 {
  font-size: 1.15em;
}
.wb-md h2 {
  font-size: 1.08em;
}
.wb-md h3 {
  font-size: 1em;
}
.wb-md :not(pre) > code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  border-radius: 4px;
  padding: 0.08em 0.35em;
}
/* 代码块卡片（头部含语言标签与复制按钮） */
.wb-md .wb-md-code {
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  overflow: hidden;
  margin: 0.5em 0;
}
.wb-md .wb-md-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  background: var(--wb-surface-deep);
  border-bottom: 1px solid var(--wb-stroke);
}
.wb-md .wb-md-lang {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--wb-accent);
  letter-spacing: 0.03em;
}
.wb-md .wb-md-copy {
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: var(--wb-r-ctrl);
  border: 1px solid var(--wb-stroke);
  background: transparent;
  color: var(--wb-text);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.wb-md .wb-md-copy:hover {
  color: var(--wb-text);
  border-color: var(--wb-accent);
  background: var(--wb-accent-bg);
}
.wb-md .wb-md-code pre {
  background: #111;
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
}
.wb-md .wb-md-code pre code {
  background: transparent;
  border: none;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.wb-md blockquote {
  margin: 0.5em 0;
  padding: 0.1em 0.9em;
  border-left: 3px solid var(--wb-accent);
  color: var(--wb-text);
  background: var(--wb-accent-bg);
  border-radius: 0 var(--wb-r-ctrl) var(--wb-r-ctrl) 0;
}
.wb-md table {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 12px;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.wb-md th,
.wb-md td {
  border: 1px solid var(--wb-stroke);
  padding: 4px 10px;
  text-align: left;
}
.wb-md th {
  background: var(--wb-surface);
  color: var(--wb-text);
  white-space: nowrap;
}
.wb-md a {
  color: var(--wb-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.wb-md hr {
  border-color: var(--wb-stroke);
  margin: 0.8em 0;
}
/* 任务列表复选框保持只读展示 */
.wb-md input[type='checkbox'] {
  accent-color: var(--wb-accent);
  pointer-events: none;
  vertical-align: -1px;
}
</style>

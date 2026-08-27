<template>
  <!-- dsh 同款轮子：marked 解析 + DOMPurify 消毒（聊天安全姿态：
       标签/事件属性全剥，仅保留 GFM 结构化输出）。
       交互：代码块带语言标签 + 一键复制；外链强制新开（Electron 里
       经 setWindowOpenHandler 兜底走系统浏览器）。 -->
  <div ref="root" class="wb-md" @click="onRootClick" v-html="html"></div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { message } from 'ant-design-vue'

const props = defineProps({
  source: { type: String, default: '' },
})

const root = ref(null)

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
    // marked v16: token 对象入参；把裸 <pre> 改造成带头部（语言 + 复制按钮）
    // 的卡片结构。按钮不依赖任何 JS 数据——点击时从最近 pre>code 取原文。
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

const html = computed(() => {
  if (!props.source) return ''
  ensurePurifyHook()
  const raw = marked.parse(props.source, { async: false })
  return DOMPurify.sanitize(raw, { ADD_TAGS: ['button'], ADD_ATTR: ['data-label'] })
})

// ---------- 事件委托：复制按钮点击 ----------
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
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(56, 70, 102, 0.5);
  border-radius: 4px;
  padding: 0.08em 0.35em;
}
/* 代码块卡片（头部含语言标签与复制按钮） */
.wb-md .wb-md-code {
  border: 1px solid rgba(56, 70, 102, 0.6);
  border-radius: 8px;
  overflow: hidden;
  margin: 0.5em 0;
}
.wb-md .wb-md-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  background: rgba(15, 23, 42, 0.65);
  border-bottom: 1px solid rgba(56, 70, 102, 0.5);
}
.wb-md .wb-md-lang {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #7dd3fc;
  letter-spacing: 0.03em;
}
.wb-md .wb-md-copy {
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid rgba(56, 70, 102, 0.6);
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.wb-md .wb-md-copy:hover {
  color: #fff;
  border-color: #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
}
.wb-md .wb-md-code pre {
  background: rgba(2, 6, 23, 0.6);
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
  border-left: 3px solid #0ea5e9;
  color: #cbd5e1;
  background: rgba(14, 165, 233, 0.06);
  border-radius: 0 6px 6px 0;
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
  border: 1px solid rgba(56, 70, 102, 0.7);
  padding: 4px 10px;
  text-align: left;
}
.wb-md th {
  background: rgba(15, 23, 42, 0.5);
  color: #fff;
  white-space: nowrap;
}
.wb-md a {
  color: #38bdf8;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.wb-md hr {
  border-color: rgba(56, 70, 102, 0.6);
  margin: 0.8em 0;
}
/* 任务列表复选框保持只读展示 */
.wb-md input[type='checkbox'] {
  accent-color: #0ea5e9;
  pointer-events: none;
  vertical-align: -1px;
}
</style>

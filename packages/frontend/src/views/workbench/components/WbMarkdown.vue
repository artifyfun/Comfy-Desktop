<template>
  <!-- dsh 同款轮子：marked 解析 + DOMPurify 消毒（聊天安全姿态：
       标签/事件属性全剥，仅保留 GFM 结构化输出） -->
  <div class="wb-md" v-html="html"></div>
</template>

<script setup>
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps({
  source: { type: String, default: '' },
})

marked.setOptions({ gfm: true, breaks: true })

const html = computed(() => {
  if (!props.source) return ''
  const raw = marked.parse(props.source, { async: false })
  return DOMPurify.sanitize(raw)
})
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
.wb-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(56, 70, 102, 0.5);
  border-radius: 4px;
  padding: 0.08em 0.35em;
}
.wb-md pre {
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid rgba(56, 70, 102, 0.5);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0.5em 0;
}
.wb-md pre code {
  background: transparent;
  border: none;
  padding: 0;
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
</style>

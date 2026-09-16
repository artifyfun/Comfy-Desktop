<template>
  <div class="guide-mask" @mousedown.self="$emit('close')">
    <div class="guide" data-testid="canvas-guide-modal">
      <!-- 侧栏导航 -->
      <aside class="guide-side">
        <div class="guide-side-title">
          <i class="fas fa-compass text-[var(--wb-accent)]"></i>
          <span>{{ lang === 'en' ? 'Canvas Guide' : '画布指南' }}</span>
        </div>
        <template v-for="g in groups" :key="g.key">
          <div class="guide-group">{{ g.label }}</div>
          <button
            v-for="p in g.pages"
            :key="p.id"
            class="guide-nav"
            :class="{ active: p.id === activeId }"
            @click="activeId = p.id"
          >
            <i :class="p.icon"></i>
            <span>{{ p.title }}</span>
          </button>
        </template>
      </aside>

      <!-- 内容页 -->
      <section v-if="page" class="guide-main">
        <header class="guide-head">
          <div class="guide-title">
            <i :class="page.icon"></i>
            <h3>{{ page.title }}</h3>
          </div>
          <button class="guide-close" :title="lang === 'en' ? 'Close' : '关闭'" @click="$emit('close')">
            <i class="fas fa-xmark"></i>
          </button>
        </header>
        <p class="guide-tip">{{ page.tip }}</p>

        <div class="guide-figure">
          <svg :viewBox="`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`" role="img">
            <defs>
              <marker
                id="guide-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 z" class="guide-arrow-head" />
              </marker>
            </defs>
            <!-- 连线 -->
            <g v-for="(l, i) in page.diagram.links" :key="'l' + i">
              <path
                :d="linkPath(l)"
                class="guide-link"
                :class="{ dash: l.dash }"
                :marker-end="l.dash ? undefined : 'url(#guide-arrow)'"
              />
              <text v-if="l.label" :x="linkMid(l).x" :y="linkMid(l).y - 6" class="guide-link-label">
                {{ l.label[lang] || l.label.zh }}
              </text>
            </g>
            <!-- 节点卡片 -->
            <g v-for="(n, i) in page.diagram.nodes" :key="'n' + i">
              <rect
                :x="n.x"
                :y="n.y"
                :width="n.w"
                :height="n.h"
                rx="9"
                class="guide-node"
                :class="'guide-node-' + n.kind"
              />
              <text
                v-if="n.kind === 'frame'"
                :x="n.x + 10"
                :y="n.y + 14"
                class="guide-node-label frame-title"
              >
                {{ n.label }}
              </text>
              <text
                v-else
                :x="n.x + n.w / 2"
                :y="n.y + n.h / 2 + (n.label && n.label.length > 8 ? -4 : 5)"
                class="guide-node-label"
                :class="{ multi: n.label && n.label.length > 8 }"
              >
                <tspan
                  v-for="(line, li) in labelLines(n)"
                  :key="li"
                  :x="n.x + n.w / 2"
                  :dy="li === 0 ? 0 : 15"
                >
                  {{ line }}
                </tspan>
              </text>
            </g>
            <!-- 手势标注 -->
            <g v-for="(ges, i) in page.diagram.gestures" :key="'g' + i">
              <template v-if="ges.type === 'drag'">
                <path
                  :d="`M${ges.x1},${ges.y1} L${ges.x2},${ges.y2}`"
                  class="guide-gesture"
                  marker-end="url(#guide-arrow)"
                />
                <circle :cx="ges.x1" :cy="ges.y1" r="4" class="guide-gesture-dot" />
              </template>
              <circle
                v-else
                :cx="ges.x"
                :cy="ges.y"
                r="12"
                class="guide-gesture-ring"
                marker-end="undefined"
              />
              <text
                v-if="ges.label"
                :x="ges.type === 'drag' ? (ges.x1 + ges.x2) / 2 : ges.x"
                :y="ges.type === 'drag' ? (ges.y1 + ges.y2) / 2 - 10 : ges.y + 4"
                class="guide-gesture-label"
              >
                {{ ges.label }}
              </text>
            </g>
          </svg>
        </div>

        <ol class="guide-steps">
          <li v-for="(s, i) in page.steps" :key="i">{{ s }}</li>
        </ol>

        <footer class="guide-foot">
          <button v-if="pageIndex > 0" class="guide-pager" @click="step(-1)">
            <i class="fas fa-chevron-left"></i>
            {{ lang === 'en' ? 'Prev' : '上一篇' }}
          </button>
          <span class="guide-progress">{{ pageIndex + 1 }} / {{ pages.length }}</span>
          <button v-if="pageIndex < pages.length - 1" class="guide-pager primary" @click="step(1)">
            {{ lang === 'en' ? 'Next' : '下一篇' }}
            <i class="fas fa-chevron-right"></i>
          </button>
          <button v-else class="guide-pager primary" @click="$emit('close')">
            {{ lang === 'en' ? 'Done' : '开始使用' }}
            <i class="fas fa-check"></i
          ></button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 画布用法指南弹窗 —— 节点类型 × 场景玩法百科（内容/几何见 canvasGuide.js）。
 * 组件只负责两件事：导航 + 把 diagram spec 画成 SVG。
 */
import { ref, computed } from 'vue'
import { guidePages, guideGroups } from './canvasGuide'
import { getCurrentLanguage } from '@/utils/i18n'

defineEmits(['close'])

const lang = getCurrentLanguage()
const groups = computed(() => guideGroups(lang))
const pages = computed(() => guidePages(lang))
const activeId = ref(pages.value[0]?.id)
const page = computed(() => pages.value.find((p) => p.id === activeId.value) || pages.value[0])
const pageIndex = computed(() => Math.max(0, pages.value.findIndex((p) => p.id === activeId.value)))

function step(dir) {
  const next = pageIndex.value + dir
  if (next >= 0 && next < pages.value.length) activeId.value = pages.value[next].id
}

const DIAGRAM_W = 330
const DIAGRAM_H = 180

/** spec 坐标 → SVG 路径：右缘中点 → 左缘中点，水平入出的三次贝塞尔 */
function linkPath(l) {
  const a = page.value.diagram.nodes[l.from]
  const b = page.value.diagram.nodes[l.to]
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.45)
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}

function linkMid(l) {
  const a = page.value.diagram.nodes[l.from]
  const b = page.value.diagram.nodes[l.to]
  return { x: (a.x + a.w + b.x) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 }
}

/** 节点标签折行：>8 字符切两行；含空格的英文按词边界折，避免断词 */
function labelLines(n) {
  const s = String(n.label || '')
  if (!s || s.length <= 8) return s ? [s] : []
  if (s.includes(' ')) {
    const words = s.split(' ')
    let best = [s, '']
    let bestDiff = Infinity
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ')
      const b = words.slice(i).join(' ')
      const diff = Math.abs(a.length - b.length)
      if (diff < bestDiff) {
        bestDiff = diff
        best = [a, b]
      }
    }
    return best
  }
  const mid = Math.ceil(s.length / 2)
  return [s.slice(0, mid), s.slice(mid)]
}
</script>

<style scoped>
.guide-mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}
.guide {
  display: flex;
  width: 780px;
  max-width: calc(100vw - 48px);
  height: 560px;
  max-height: calc(100vh - 64px);
  border-radius: 16px;
  border: 1px solid var(--wb-stroke);
  background: var(--wb-surface);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* —— 侧栏 —— */
.guide-side {
  width: 196px;
  flex-shrink: 0;
  border-right: 1px solid var(--wb-stroke);
  background: rgba(0, 0, 0, 0.18);
  padding: 14px 10px;
  overflow-y: auto;
}
.guide-side-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text-1);
  padding: 0 6px 12px;
}
.guide-group {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--wb-text-3);
  padding: 12px 6px 5px;
}
.guide-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--wb-text-2);
  text-align: left;
  transition: background 0.12s, color 0.12s;
}
.guide-nav i {
  width: 16px;
  text-align: center;
  font-size: 12px;
}
.guide-nav:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--wb-text-1);
}
.guide-nav.active {
  background: color-mix(in srgb, var(--wb-accent) 16%, transparent);
  color: var(--wb-accent);
}

/* —— 主区 —— */
.guide-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 20px 24px 16px;
  min-width: 0;
}
.guide-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.guide-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--wb-accent);
}
.guide-title i {
  font-size: 16px;
}
.guide-title h3 {
  font-size: 17px;
  font-weight: 600;
  color: var(--wb-text-1);
}
.guide-close {
  color: var(--wb-text-2);
  transition: color 0.12s;
}
.guide-close:hover {
  color: var(--wb-text-1);
}
.guide-tip {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--wb-text-2);
}

/* —— 示意图 —— */
.guide-figure {
  margin-top: 14px;
  border-radius: 12px;
  border: 1px solid var(--wb-stroke);
  background:
    radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.05) 1px, transparent 0) 0 0 / 18px
      18px,
    rgba(0, 0, 0, 0.16);
  flex-shrink: 0;
}
.guide-figure svg {
  display: block;
  width: 100%;
}
.guide-link {
  fill: none;
  stroke: color-mix(in srgb, var(--wb-accent) 65%, transparent);
  stroke-width: 1.8;
}
.guide-link.dash {
  stroke: var(--wb-text-3);
  stroke-dasharray: 5 4;
}
.guide-arrow-head {
  fill: color-mix(in srgb, var(--wb-accent) 75%, transparent);
}
.guide-link-label {
  font-size: 10px;
  fill: var(--wb-text-2);
  text-anchor: middle;
}
.guide-node {
  fill: rgba(255, 255, 255, 0.055);
  stroke: var(--wb-stroke);
  stroke-width: 1.2;
}
.guide-node-image,
.guide-node-out {
  fill: color-mix(in srgb, var(--wb-accent) 12%, rgba(255, 255, 255, 0.04));
  stroke: color-mix(in srgb, var(--wb-accent) 55%, transparent);
}
.guide-node-out {
  fill: rgba(255, 255, 255, 0.035);
  stroke: var(--wb-text-3);
  stroke-dasharray: 4 3;
}
.guide-node-note {
  fill: color-mix(in srgb, #eab308 14%, transparent);
  stroke: color-mix(in srgb, #eab308 60%, transparent);
}
.guide-node-frame {
  fill: none;
  stroke: var(--wb-text-3);
  stroke-dasharray: 7 5;
}
.guide-node-shot {
  fill: color-mix(in srgb, #8b5cf6 13%, transparent);
  stroke: color-mix(in srgb, #8b5cf6 55%, transparent);
}
.guide-node-label {
  font-size: 11px;
  font-weight: 600;
  fill: var(--wb-text-1);
  text-anchor: middle;
  dominant-baseline: middle;
}
.guide-node-label.multi {
  font-weight: 400;
  font-style: italic;
  font-size: 10px;
  fill: var(--wb-text-2);
}
.guide-node-label.frame-title {
  font-size: 11px;
  fill: var(--wb-text-2);
  text-anchor: start;
  dominant-baseline: auto;
}
.guide-gesture {
  stroke: var(--wb-accent);
  stroke-width: 2;
  stroke-dasharray: 2 4;
  stroke-linecap: round;
  fill: none;
}
.guide-gesture-dot {
  fill: var(--wb-accent);
}
.guide-gesture-ring {
  fill: color-mix(in srgb, var(--wb-accent) 18%, transparent);
  stroke: var(--wb-accent);
  stroke-width: 1.5;
}
.guide-gesture-label {
  font-size: 12px;
  fill: var(--wb-accent);
  text-anchor: middle;
  dominant-baseline: middle;
}

/* —— 步骤 —— */
.guide-steps {
  margin: 14px 0 0;
  padding-left: 0;
  list-style: none;
  counter-reset: guide-step;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.guide-steps li {
  counter-increment: guide-step;
  display: flex;
  gap: 10px;
  padding: 7px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--wb-text-1);
}
.guide-steps li + li {
  border-top: 1px dashed color-mix(in srgb, var(--wb-stroke) 70%, transparent);
}
.guide-steps li::before {
  content: counter(guide-step);
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--wb-accent) 16%, transparent);
  color: var(--wb-accent);
  font-size: 10.5px;
  font-weight: 700;
  display: grid;
  place-items: center;
}

/* —— 底部翻页 —— */
.guide-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--wb-stroke);
  margin-top: 12px;
}
.guide-pager {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--wb-stroke);
  font-size: 12px;
  color: var(--wb-text-2);
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.guide-pager:hover {
  border-color: var(--wb-accent);
  color: var(--wb-text-1);
}
.guide-pager.primary {
  background: var(--wb-accent);
  border-color: var(--wb-accent);
  color: #fff;
}
.guide-pager.primary:hover {
  background: color-mix(in srgb, var(--wb-accent) 85%, #fff);
  color: #fff;
}
.guide-progress {
  font-size: 11px;
  color: var(--wb-text-3);
  font-variant-numeric: tabular-nums;
}

/* 窄高度收紧 */
@media (max-height: 640px) {
  .guide {
    height: calc(100vh - 40px);
  }
  .guide-figure {
    margin-top: 10px;
  }
}
</style>

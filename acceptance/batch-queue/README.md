# 批量队列 UI 浏览器验收（Batch Queue Browser Acceptance）

A 面板批量队列前端在**真实浏览器**（agent-browser + Chromium）下的端到端验收环境。
所有后端行为由 `stub.js` 在页面内 mock，**不启动真实应用、不触碰真实关机**（`/api/shutdown` 仅记录到 `__batchCtl.shutdownCalls`）。

- 验收日期：2026-09-03（基于 upstream v1.0.47-rc.1 merge 后的 dist）
- 产品代码改动：0（验收纯只读，工作区无 diff）

## 目录

```
acceptance/batch-queue/
├── serve.mjs      # 静态服务器：托管 dist/frontend + SPA fallback + stub 注入
├── stub.js        # 页面内 IIFE：fetch 桩 + electronAPI mock + 队列状态机 + __batchCtl 句柄
├── screenshots/   # T1/T2/T3/T4/T5/T7 验收截图
└── README.md
```

## 复跑（一键）

前置：先构建前端产物（stub 服务器托管的是 `packages/frontend/dist/frontend/`）：

```bash
cd /d/artifyfun/Comfy-Desktop && pnpm run build:frontend
cd acceptance/batch-queue && node serve.mjs 5174        # 起服务
```

另开终端（agent-browser daemon）：

```bash
agent-browser open http://127.0.0.1:5174/batch/detail   # detail 页（stub auto-seed 一个 running 45% 任务）
agent-browser open http://127.0.0.1:5174/               # 首页（验证全局浮层）
```

页面内可用句柄（配合 `agent-browser eval` 驱动场景）：

```js
window.__batchCtl               // { jobs, paused, shutdownCalls, configCalls, queueConfig }
window.__batchCtl.reset()       // 清空队列/统计
window.__batchCtl.seedRunningJob(45)   // 造一个 running 中段任务
window.__batchCtl.seedPausedQueue(3)   // 造 3 个 queued 且队列 paused（模拟应用重启后）
```

## 验收矩阵（2026-09-03 全绿）

| # | 场景 | 触发路径 | 断言 | 截图 |
|---|---|---|---|---|
| T1 | 三步向导→执行→完成 | index 页选目录→映射→手动值→开始 | queued→running→completed，显示关机/通知标识 | `t1-completed.png` |
| T2 | 暂停冻结/恢复推进 | detail 页对 running job 点 ⏸暂停 | badge「已暂停」+ percent 冻结（3s 无推进）→ ▶继续 后推进至 100% | `t2-paused.png` |
| T3 | 一键重跑 | completed job 点 🔁重新运行（Modal 确认） | 队列 +1，新 job 进入 running | `t3-rerun.png` |
| T4 | 重启暂停 banner | `seedPausedQueue(3)` | 顶部「应用重启后队列已暂停…」+ ▶继续执行 → paused=false | `t4-paused-banner.png` |
| T5 | 关机/通知配置即时生效 | 队列设置开关 | POST /api/batch/config → queueConfig.autoShutdown=true | `t5-config-applied.png` |
| T6 | 队列管理 | 置顶 / 删除出队 / 清空已完成 | moveTop 顺序变化；删除弹 Modal；清空 3→0 | —（T4/T5 截图中可见） |
| T7 | 全局浮层 BatchTaskFloat | 首页 `/` pill → 展开面板 → 📋批量队列详情 | 非 batch 页可见「1/3 · 45%」→ 面板含操作按钮 → router.push 到 /batch/detail | `t7-global-float.png` |

**安全铁律**：全部场景断言 `__batchCtl.shutdownCalls.length === 0`（真关机从未被触发）。

## stub 已知差异（仅验收桩，非产品缺陷）

- `cancel`（删除出队）对 queued/paused job 置 `stopped` 而非真正 splice —— 后端 `batchRunner.ts` 按产品语义处理，桩只是便于 UI 呈现。
- 前端 `apiURL` 通过 `location.pathname` 推导 base（如 `/batch`），stub 路由匹配已做 `p.replace(/^\/batch/,'')` 前缀剥离。

## agent-browser 经验（Windows）

- 截图路径必须 `D:/...`（`/d/...` 报 os error 3）。
- ant-design 按钮文本含空格（"置 顶"），过滤用 `/置\s*顶/` 正则。
- 触发 vue @click 用 `dispatchEvent(new MouseEvent('click',{bubbles:true}))`，直接 `.click()` 可能不生效。
- 改 stub.js 后须重新 `agent-browser open`（stub 是 IIFE，仅页面加载时执行）。

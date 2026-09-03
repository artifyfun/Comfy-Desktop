// Batch 批量页浏览器验收桩：mock Electron 桥 + boot/config + /api/apps/detail
// + /api/batch/* 队列引擎（内存状态机，慢速自动演进，支持暂停/继续/重跑/出队/置顶/清空/配置）
// 注意：/api/shutdown 永远只 stub 记录，绝不真正关机（验收铁律）
;(() => {
  if (window.__batchStubInstalled) return
  window.__batchStubInstalled = true

  const ORIGIN = location.origin // http://127.0.0.1:<port>
  const origFetch = window.fetch.bind(window)
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const ok = (data) => ({ ok: true, success: true, code: 200, data })
  const now = () => new Date().toLocaleTimeString()

  // ============ Electron 桥 mock（isElectron = !!window.electronAPI 走真机路径） ============
  const SERVER = {
    server_origin: ORIGIN,
    serverHost: ORIGIN,
    comfyHost: null,
    activeAppId: 'app-batch-demo',
    lang: 'zh',
    theme: 'dark',
    api_key: 'sk-test',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
    provider: 'deepseek',
  }
  const FS_FILES = ['cat_001.jpg', 'cat_002.png', 'cat_003.jpg', 'cat_004.png'].map((name, i) => ({
    fileName: name,
    fullPath: `D:\\\\批量验收图集\\\\${name}`,
    size: 204800 + i * 10240,
    isDirectory: false,
    extension: '.' + name.split('.').pop(),
    lastModified: Date.now() - (4 - i) * 3600_000,
    relativePath: name,
  }))
  window.electronAPI = {
    ArtifyLab: {
      getConfig: async () => ({ ...SERVER, lang: 'zh', theme: 'dark' }),
      getAppInfo: async () => ({ name: 'Artify Lab', version: 'verify' }),
      selectFile: async () => 'D:\\批量验收图集',
      selectFolder: async () => 'D:\\批量验收图集',
      scanFolder: async () => FS_FILES,
      openOutputFolder: async () => undefined,
      openRootFolder: async () => undefined,
      openCMD: async () => undefined,
      loadComfyUI: async () => ({ url: ORIGIN }),
      saveArtifact: async () => undefined,
    },
  }

  // ============ Fake App（template.prompt + paramsNodes 供 genMeta） ============
  const FAKE_APP = {
    id: 'app-batch-demo',
    name: '批量验收演示',
    description: '浏览器验收用演示工作流',
    template: {
      prompt: {
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat, masterpiece' } },
        '6': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 7 } },
        '9': { class_type: 'SaveImage', inputs: {} },
      },
      paramsNodes: [
        {
          id: '3',
          category: 'input',
          type: 'CLIPTextEncode',
          description: '正向提示词',
          title: 'Prompt',
          selectedWidget: { name: 'text', type: 'text' },
        },
        {
          id: '6',
          category: 'input',
          type: 'KSampler',
          description: '随机种子',
          title: 'Seed',
          selectedWidget: { name: 'seed', type: 'number' },
        },
      ],
    },
  }

  // ============ 队列引擎内存状态机 ============
  const jobs = [] // BatchJob 形状
  let paused = false // 队列级暂停（重启恢复场景）
  let seq = 100
  const shutdownCalls = [] // 记录 autoShutdown 触发（绝不真关机）
  const configCalls = [] // 记录 /api/batch/config 请求
  let queueConfig = { autoShutdown: false, notifyUrl: '' }
  let autoTick = null

  const jobSummary = (j) => {
    const s = {
      id: j.id,
      status: j.status,
      appId: j.appId,
      appName: j.appName,
      autoShutdown: j.autoShutdown,
      notifyUrl: j.notifyUrl,
      total: j.total,
      processed: j.processed,
      success: j.success,
      failed: j.failed,
      percent: j.percent,
      currentIndex: j.currentIndex,
      currentPreview: j.currentPreview,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      updatedAt: j.updatedAt,
      logs: j.logs,
      results: j.results,
    }
    return s
  }
  const listQueue = () => jobs.map(jobSummary)

  function makeJob(payload, opts = {}) {
    const items = payload.items || []
    const id = 'job-' + seq++
    const job = {
      id,
      status: 'queued',
      prompt: payload.prompt || FAKE_APP.template.prompt,
      inputsMapping: payload.inputsMapping || [],
      items,
      startFrom: payload.startFrom || 1,
      notifyUrl: payload.notifyUrl || '',
      autoShutdown: !!payload.autoShutdown,
      appId: payload.appId || FAKE_APP.id,
      appName: payload.appName || FAKE_APP.name,
      total: items.length,
      processed: 0,
      success: 0,
      failed: 0,
      percent: 0,
      currentIndex: 0,
      currentPreview: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [{ time: now(), type: 'info', message: `任务入队（共 ${items.length} 项）` }],
      results: [],
      ...opts,
    }
    jobs.push(job)
    return job
  }

  function log(job, type, message) {
    job.logs.push({ time: now(), type, message })
    if (job.logs.length > 60) job.logs = job.logs.slice(-60)
  }

  function setStatus(job, status) {
    job.status = status
    job.updatedAt = new Date().toISOString()
    if (status === 'running' && !job.startedAt) job.startedAt = new Date().toISOString()
    if (['completed', 'stopped', 'failed'].includes(status) && !job.finishedAt)
      job.finishedAt = new Date().toISOString()
  }

  // 引擎 tick：推进当前 running job 的 percent（模拟执行），100% 后 completed
  function tick() {
    const running = jobs.find((j) => j.status === 'running')
    if (running) {
      running.percent = Math.min(100, running.percent + 7)
      const progressed = Math.floor((running.percent / 100) * running.total)
      if (progressed > running.processed) {
        running.processed = progressed
        running.success = progressed // 简化：全成功
        running.currentIndex = progressed
        running.currentPreview =
          running.items[progressed - 1]?.fileName || running.items[progressed - 1]?.name || ''
        log(running, 'success', `完成第 ${progressed}/${running.total} 项`)
      }
      running.updatedAt = new Date().toISOString()
      if (running.percent >= 100) {
        setStatus(running, 'completed')
        log(running, 'info', '全部完成')
        running.results = Array.from({ length: running.total }, (_, i) => ({
          index: i + 1,
          success: true,
          durationMs: 800 + i * 137,
        }))
        // autoShutdown：整队列空闲时记录（stub 绝不真关机）
        if (running.autoShutdown && !jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status))) {
          shutdownCalls.push({ at: now(), jobId: running.id, note: '队列空闲触发 autoShutdown（stub 仅记录）' })
        }
      }
      return
    }
    // 无 running 且未暂停 → 取队首 queued
    if (!paused) {
      const next = jobs.find((j) => j.status === 'queued')
      if (next) {
        setStatus(next, 'running')
        log(next, 'info', '开始执行')
      } else if (autoTick) {
        stopTick()
      }
    }
  }

  function startTick() {
    if (autoTick) return
    autoTick = setInterval(tick, 800) // 800ms/次 → 100% 约 12s
  }
  function stopTick() {
    if (autoTick) {
      clearInterval(autoTick)
      autoTick = null
    }
  }
  function ensureTick() {
    if (jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status))) startTick()
    else stopTick()
  }

  // ============ 全局控制句柄（验收断言用） ============
  window.__batchCtl = {
    get jobs() {
      return jobs.map(jobSummary)
    },
    get paused() {
      return paused
    },
    get shutdownCalls() {
      return shutdownCalls
    },
    get configCalls() {
      return configCalls
    },
    get queueConfig() {
      return queueConfig
    },
    tick,
    startTick,
    stopTick,
    // 手动造场景：一个排队任务 + 队列暂停（模拟重启恢复）
    seedPausedQueue(n = 2) {
      paused = true
      for (let i = 0; i < n; i++) {
        makeJob(
          { items: [{ fileName: `paused_${i}.jpg` }, { fileName: `paused_${i}b.jpg` }], appId: FAKE_APP.id, appName: FAKE_APP.name },
          { id: 'seed-' + (i + 1) },
        )
      }
      ensureTick()
    },
    /** 直接造一个 running 中段任务（percent 可调），便于截图暂停按钮 */
    seedRunningJob(percent = 35) {
      const j = makeJob(
        { items: [{ fileName: 'seed_a.jpg' }, { fileName: 'seed_b.jpg' }, { fileName: 'seed_c.jpg' }], appId: FAKE_APP.id, appName: FAKE_APP.name },
      )
      setStatus(j, 'running')
      j.startedAt = new Date().toISOString()
      j.percent = percent
      j.processed = Math.floor((percent / 100) * j.total)
      j.success = j.processed
      j.currentIndex = j.processed
      j.currentPreview = j.items[j.processed - 1]?.fileName || ''
      log(j, 'info', `已处理 ${j.processed}/${j.total}`)
      stopTick()
      return j.id
    },
    /** 造一个已完成任务 */
    seedCompletedJob() {
      const j = makeJob(
        { items: [{ fileName: 'finished_1.jpg' }, { fileName: 'finished_2.jpg' }], appId: FAKE_APP.id, appName: FAKE_APP.name },
      )
      setStatus(j, 'running')
      j.percent = 100
      j.processed = j.total
      j.success = j.processed
      j.results = Array.from({ length: j.total }, (_, i) => ({ index: i + 1, success: true, durationMs: 800 }))
      setStatus(j, 'completed')
      stopTick()
      return j.id
    },
    reset() {
      jobs.length = 0
      paused = false
      queueConfig = { autoShutdown: false, notifyUrl: '' }
      shutdownCalls.length = 0
      configCalls.length = 0
      stopTick()
    },
  }

  // ============ fetch 拦截 ============
  window.fetch = async (url, opts = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url, ORIGIN)
    const p = u.pathname
    const m = (opts.method || 'GET').toUpperCase()
    let body = {}
    try {
      const bodyText = typeof opts.body === 'string' ? opts.body : ''
      if (bodyText) body = JSON.parse(bodyText)
    } catch {
      /* ignore */
    }
    // 前端 apiURL 通过 location.pathname 推导出 base（如 /batch），
    // 因此真请求是 /batch/api/...；此处去掉该前缀以匹配 stub 路由表
    const route = `${m} ${p.replace(/^\/batch/, '')}`

    // ---- boot / config ----
    if (route === 'POST /api/config') return json(ok(SERVER))
    if (route === 'GET /api/config') return json(ok(SERVER))
    if (route === 'POST /api/apps/detail' || route === 'GET /api/apps/detail') {
      return json(ok(body.id && body.id !== FAKE_APP.id ? null : FAKE_APP))
    }
    if (p.startsWith('/api/apps')) return json(ok(body.id ? FAKE_APP : [FAKE_APP]))

    // ---- batch 队列 API ----
    if (route === 'POST /api/batch/start') {
      const job = makeJob(body)
      ensureTick()
      return json(
        ok({
          status: null,
          queue: listQueue(),
          jobId: job.id,
        }),
      )
    }
    if (route === 'GET /api/batch/queue') {
      return json(ok({ jobs: listQueue(), running: !!jobs.find((j) => j.status === 'running'), paused }))
    }
    if (route === 'GET /api/batch/status') {
      return json(ok(jobs.find((j) => j.status === 'running') || null))
    }
    if (route === 'POST /api/batch/stop') {
      const stopAll = !!body.stopAll
      const running = jobs.find((j) => j.status === 'running')
      if (running) {
        setStatus(running, 'stopped')
        log(running, 'warn', '用户停止')
      }
      if (stopAll) {
        jobs.forEach((j) => {
          if (j.status === 'queued' || j.status === 'paused') {
            setStatus(j, 'stopped')
            log(j, 'warn', '队列停止（stopAll）')
          }
        })
      }
      ensureTick()
      return json(ok(jobs.find((j) => j.status === 'running') || null))
    }
    if (route === 'POST /api/batch/cancel') {
      const j = jobs.find((x) => x.id === body.id)
      if (!j) return json(ok({ jobs: listQueue() }))
      if (j.status === 'queued' || j.status === 'paused') {
        log(j, 'warn', '任务出队（cancel）')
        setStatus(j, 'stopped')
      } else if (j.status === 'running') {
        setStatus(j, 'stopped')
        log(j, 'warn', '运行中被取消')
      }
      ensureTick()
      return json(ok({ jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/delete') {
      const idx = jobs.findIndex((x) => x.id === body.id)
      if (idx >= 0) jobs.splice(idx, 1)
      ensureTick()
      return json(ok({ jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/clear') {
      let removed = 0
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (['completed', 'stopped', 'failed'].includes(jobs[i].status)) {
          jobs.splice(i, 1)
          removed++
        }
      }
      ensureTick()
      return json(ok({ removed, jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/move') {
      const j = jobs.find((x) => x.id === body.id)
      if (j) {
        jobs.splice(jobs.indexOf(j), 1)
        jobs.unshift(j)
      }
      return json(ok({ jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/pause') {
      const j = jobs.find((x) => body.id ? x.id === body.id : x.status === 'running')
      if (!j) return json(ok({ jobs: listQueue(), paused }))
      setStatus(j, 'paused')
      log(j, 'warn', '已暂停（进度保留）')
      ensureTick()
      return json(ok({ jobs: listQueue(), paused }))
    }
    if (route === 'POST /api/batch/job-resume') {
      const j = jobs.find((x) => x.id === body.id)
      if (j && j.status === 'paused') {
        setStatus(j, 'running')
        log(j, 'info', '继续执行')
      }
      ensureTick()
      return json(ok({ jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/resume') {
      paused = false
      ensureTick()
      return json(ok({ resumed: true, paused: false, jobs: listQueue() }))
    }
    if (route === 'POST /api/batch/rerun') {
      const src = jobs.find((x) => x.id === body.id)
      if (!src || ['queued', 'running', 'paused'].includes(src.status)) {
        return json({ ok: false, success: false, code: 404, message: 'batch job not found or still active' }, 404)
      }
      const job = makeJob({
        items: src.items,
        prompt: src.prompt,
        inputsMapping: src.inputsMapping,
        startFrom: src.startFrom,
        notifyUrl: src.notifyUrl,
        autoShutdown: src.autoShutdown,
        appId: src.appId,
        appName: src.appName,
      })
      log(job, 'info', `一键重跑（源 ${src.id}）`)
      ensureTick()
      return json(ok({ jobId: job.id, queue: listQueue() }))
    }
    if (route === 'POST /api/batch/config') {
      if (typeof body.autoShutdown === 'boolean') queueConfig.autoShutdown = body.autoShutdown
      if (typeof body.notifyUrl === 'string') queueConfig.notifyUrl = body.notifyUrl
      configCalls.push({ at: now(), ...body })
      // 应用到活跃任务（与后端 setQueueConfig 一致：对排队中/运行中即时生效）
      jobs.forEach((j) => {
        if (['queued', 'running', 'paused'].includes(j.status)) {
          if (typeof body.autoShutdown === 'boolean') j.autoShutdown = body.autoShutdown
          if (typeof body.notifyUrl === 'string') j.notifyUrl = body.notifyUrl
        }
      })
      return json(ok({ config: { ...queueConfig }, jobs: listQueue() }))
    }

    // ---- shutdown：只记录，绝不真正关机 ----
    if (p.startsWith('/api/shutdown')) {
      shutdownCalls.push({ at: now(), route, body })
      return json(ok({ scheduled: true, stub: true }))
    }

    // 其余放行（不存在网络则 404 兜底，避免页面静默失败）
    try {
      return await origFetch(url, opts)
    } catch {
      return json(ok(null))
    }
  }

  console.log('[batch-stub] installed, origin =', ORIGIN)

  // 自动种子一个 running 中段任务（便于浏览器验收 UI 立即看到暂停按钮，无需三步向导）
  try {
    __batchCtl.seedRunningJob(45)
  } catch (e) {
    console.warn('[batch-stub] auto seed failed', e)
  }
})()

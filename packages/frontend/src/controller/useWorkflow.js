import { reactive, ref, onMounted, onUnmounted } from 'vue'
import dayjs from 'dayjs'
import localforage from 'localforage'
import { ComfyUIClient } from '@artifyfun/comfy-ui-client'
import { getQueryParam, downloadJSON, previewImageFullscreen, uuidv4, getSeed, postFile, createGlassAlert, getFile } from '@/utils'

export default function useWorkflow() {
  const app = window.appTemplate
  const LAST_STATE_KEY = `workflows/state/${app.id}`

  const state = reactive({
    inputs: app.state.inputs,
    outputs: app.state.outputs,
    clientId: null,
    promptId: null,
    config: {
      ...app.config,
      serverHost: getQueryParam('server_origin') || app.config?.serverHost,
      comfyHost: getQueryParam('comfy_origin') || app.config?.comfyHost,
    },
    history: [],
    loading: false,
    executing: false,
    done: false,
    progress: 0,
    pending: 0,
    showHistoryModal: false,
  })

  const loopGetStateTimerId = ref(0)

  const emitError = (message) => {
    state.loading = false
    state.executing = false
    state.progress = 0
    state.done = false
    createGlassAlert(message, state.config.lang === 'zh' ? '错误' : 'Error')
  }

  const totalSteps = ref(Object.keys(app.template.prompt).reduce((acc, key) => acc + (app.template.prompt[key].inputs?.steps || 1), 0))
  const finishedSteps = ref(0)
  const cachedIds = ref([])
  const addIds = ref([])

  const client = ref(null)

  const getClient = () => {
    if (!client.value) {
      // comfy-ui-client >= 0.4: 构造第三参为 options，事件经 client.on(event, data)
      // 订阅（event 即旧 eventEmitter 里 message.type 的值）
      client.value = new ComfyUIClient(state.config.comfyHost, state.clientId, {
        logger: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} }
      })
      client.value.on('status', () => {
        // 兼容旧 eventEmitter('message') 分支里的通用状态
        state.executing = true
        state.done = false
      })
      for (const evt of [
        'execution_start',
        'execution_cached',
        'progress',
        'execution_success',
        'execution_error',
        'execution_interrupted'
      ]) {
        client.value.on(evt, (data) => handleWsEvent(evt, data))
      }
      client.value.on('disconnected', () => {})
    }
    return client.value
  }

  // 0.3.x eventEmitter('message', rawJson) 的等价实现：
  // 0.5.x 直接按事件名分发，data 即 message.data
  const handleWsEvent = (type, data) => {
    if (type === 'execution_start') {
      state.promptId = data.prompt_id
    }
    if (type === 'execution_cached') {
      data.nodes.forEach(id => {
        if (!cachedIds.value.includes(id)) {
          cachedIds.value.push(id)
        }
      })
      cachedIds.value.forEach(id => {
        if (Object.keys(app.template.prompt).includes(id)) {
          if (app.template.prompt[id]?.inputs?.steps) {
            if (!addIds.value.includes(id)) {
              if (!['BasicScheduler'].includes(app.template.prompt[id].class_type)) {
                finishedSteps.value += app.template.prompt[id].inputs.steps
              }
              addIds.value.push(id)
            }
          } else {
            if (!addIds.value.includes(id)) {
              finishedSteps.value += 1
              addIds.value.push(id)
            }
          }
        }
      })
    }
    if (type === 'progress') {
      if (['SamplerCustomAdvanced'].includes(app.template.prompt[data.node]?.class_type)) {
        finishedSteps.value += 1
      } else if (Object.keys(app.template.prompt).includes(data.node) && app.template.prompt[data.node]?.inputs?.steps && finishedSteps.value < totalSteps.value) {
        finishedSteps.value += 1
      } else if (!addIds.value.includes(data.node)) {
        finishedSteps.value += 1
      }
      if (!addIds.value.includes(data.node)) {
        addIds.value.push(data.node)
      }
    }
    state.progress = Number((finishedSteps.value / totalSteps.value) * 100).toFixed(2)
    if (type === 'execution_success') {
      state.progress = 100
    }
    state.executing = true
    state.done = false
  }

  const uploadImage = (file) => {
    const client = getClient()
    return client.uploadImage(file, file.name, true)
  }

  function getQueueState() {
    const client = getClient()
    return client.getQueue()
  }

  function deleteQueue() {
    const client = getClient()
    return client.editQueue({ delete: [state.promptId] })
  }

  function interrupt() {
    const client = getClient()
    return client.interrupt()
  }

  function getHistoryByPromptId() {
    const client = getClient()
    return client.getHistory(state.promptId)
  }

  function getImageUrl(data, type) {
    if (type === 'output') {
      const { filename, subfolder } = data || {}
      return filename ? `${state.config.serverHost}/view?type=${type}&filename=${filename}&subfolder=${subfolder || ''}` : null
    }
    return data ? `${state.config.serverHost}/view?type=${type}&filename=${data}` : null
  }

  function getFileUrl(data, type) {
    if (type === 'output') {
      const { filename, subfolder } = data || {}
      return filename ? `${state.config.comfyHost}/view?type=${type}&filename=${filename}&subfolder=${subfolder || ''}` : null
    }
    return data ? `${state.config.comfyHost}/view?type=${type}&filename=${data}` : null
  }

  const getState = async () => {
    const res = await getQueueState()
    state.pending = res.queue_pending.length
    state.running = res.queue_running.length
  }

  const getOutputs = async (prompt) => {
    const client = getClient()
    try {
      await client.connect()
      // 0.3.x getResult(fetchOption, prompt) = queue + wait + history 条目
      // 0.5.x 等价物：waitForPrompt(prompt)（内部 queuePrompt + WS 等待 + 取 history）
      return await client.waitForPrompt(prompt)
    } catch (error) {
      console.log(error)
      throw error
    } finally {
      // 0.5.x disconnect 是同步的
      client.disconnect()
    }
  }

  const handleSaveState = () => {
    const lastState = JSON.parse(JSON.stringify(state))
    localforage.setItem(LAST_STATE_KEY, lastState)
  }

  const handleResult = (res) => {
    const { outputs } = res
    const outputKeys = Object.keys(app.state.outputs)
    const response = {}
    Object.keys(outputs).forEach((key) => {
      if (outputKeys.includes(key)) {
        Object.values(outputs[key]).forEach(item => {
          if (Array.isArray(item)) {
            const outputItem = item.find((item) => typeof item === 'object' && item.type === 'output')
            if (outputItem) {
              response[key] = outputItem
            }
          }
        })
        response[key] = response[key] || Object.values(outputs[key]).find((item) => Array.isArray(item))?.join('\n')
      }
    })
    return response
  }

  const start = async () => {
    state.loading = true
    let response = null
    try {
      Object.keys(app.template.prompt).forEach((key) => {
        const item = app.template.prompt[key]
        Object.keys(item.inputs).forEach(inputKey => {
          if (inputKey.includes('seed') && typeof item.inputs[inputKey] === 'number') {
            item.inputs[inputKey] = getSeed(15)
          }
        })
      })
      Object.keys(state.inputs).forEach((key) => {
        if (app.template.prompt[key]?.inputs && typeof app.template.prompt[key].inputs === 'object') {
          Object.assign(app.template.prompt[key].inputs, state.inputs[key])
        }
      })
      finishedSteps.value = 0
      const res = await getOutputs(app.template.prompt)
      response = handleResult(res)
    } catch (e) {
      const message = state.config.lang === 'zh' ? `工作流执行失败` : `Workflow execution failed`
      console.log(e)
      emitError(message)
      throw new Error(message)
    }

    if (!response) {
      const message = state.config.lang === 'zh' ? `工作流执行失败: 未获取到输出数据` : `Workflow execution failed: No output data`
      emitError(message)
      throw new Error(message)
    }
    // 缓存历史数据
    const newItem = JSON.parse(
      JSON.stringify({
        createTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        inputs: state.inputs,
        outputs: response,
      }),
    )
    state.history.unshift(newItem)

    // 上报 Gallery 资产库：参数/工作流快照 + 输出文件（失败静默，不影响主流程）
    try {
      const outputsFlat = Object.values(response)
        .filter(item => item && typeof item === 'object' && item.filename)
        .map(item => ({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' }))
      if (outputsFlat.length && state.config.serverHost) {
        fetch(`${state.config.serverHost}/api/gallery/record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app: { id: app.id, name: app.name },
            inputs: state.inputs,
            prompt: app.template.prompt,
            outputs: outputsFlat
          })
        }).catch(() => {})
      }
    } catch (e) { console.warn('gallery record failed', e) }

    if (Object.keys(response).length) {
      Object.assign(state.outputs, response)
      state.progress = 100
    } else {
      state.progress = 0
    }
    state.executing = false
    state.loading = false
    state.done = true

    handleSaveState()

    return response
  }

  const stop = () => {
    const callback = () => {
      Object.assign(state, {
        loading: false,
        executing: false,
        progress: 0,
      })
    }
    if (state.promptId && state.executing) {
      interrupt().finally(callback)
    } else {
      deleteQueue().finally(callback)
    }
  }

  const getLastState = async () => {
    const lastState = (await localforage.getItem(LAST_STATE_KEY))
    if (lastState) {
      const needAssignKeys = ['promptId', 'clientId', 'inputs', 'outputs', 'history']
      needAssignKeys.forEach(key => {
        if (state[key] && typeof state[key] === 'object') {
          Object.assign(state[key], lastState[key])
        } else {
          state[key] = lastState[key]
        }
      })
    }

    state.clientId = state.clientId || uuidv4()

    if (state.promptId) {
      const lastHistoryResult = await getHistoryByPromptId()
      const res = lastHistoryResult[state.promptId] || { outputs: [] }
      const outputs = handleResult(res)
      if (Object.keys(outputs).length) {
        state.outputs = outputs
      }
    }
  }

  const removeHistory = async (item) => {
    const history = state.history
    const index = history.indexOf(item)
    if (index > -1) {
      history.splice(index, 1)
    }
  }

  // 处理图片上传
  const onUploadImageChange = async (event, id) => {
    const file = event.target.files[0]
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        alert('文件大小不能超过10MB')
        return
      }
      const res = await uploadImage(file)
      state.inputs[id].image = res.name
    }
  }

  // 处理音频上传
  const onUploadAudioChange = async (event, id) => {
    const file = event.target.files[0]
    if (file) {
      if (file.size > 100 * 1024 * 1024) {
        alert('文件大小不能超过100MB')
        return
      }
      const res = await uploadImage(file)
      state.inputs[id].audio = res.name
    }
  }

  // 处理视频上传
  const onUploadVideoChange = async (event, id) => {
    const file = event.target.files[0]
    if (file) {
      if (file.size > 100 * 1024 * 1024) {
        alert('文件大小不能超过100MB')
        return
      }
      const res = await uploadImage(file)
      state.inputs[id].file = res.name
    }
  }

  const removeImage = (id) => {
    state.inputs[id].image = ''
  }

  const removeAudio = (id) => {
    state.inputs[id].audio = ''
  }

  const removeVideo = (id) => {
    state.inputs[id].file = ''
  }

  const downloadImage = (id) => {
    const data = state.outputs[id]
    const url = getImageUrl(data, 'output')
    postFile(url, data.filename)
  }

  const downloadFile = (id) => {
    const data = state.outputs[id]
    const url = getFileUrl(data, 'output')
    getFile(url, data.filename)
  }

  const previewImage = async (id) => {
    const data = state.outputs[id]
    const url = getImageUrl(data, 'output')
    await previewImageFullscreen(url)
  }

  // 切换历史记录弹窗
  const toggleHistoryModal = () => {
    state.showHistoryModal = !state.showHistoryModal
  }

  // 处理历史记录项点击
  const onHistoryItemSelect = (item) => {
    Object.assign(state.inputs, item.inputs)
    Object.assign(state.outputs, item.outputs)
    state.showHistoryModal = false
  }

  const downloadWorkflow = () => {
    downloadJSON(app.template.workflow, app.name)
  }

  const loopGetState = async () => {
    clearTimeout(loopGetStateTimerId.value)
    getState()
    loopGetStateTimerId.value = setTimeout(() => {
      loopGetState()
    }, 5000)
  }

  const init = async () => {
    await getLastState()
    loopGetState()
    window.addEventListener('beforeunload', handleSaveState)
  }

  onMounted(() => {
    init()
  })

  onUnmounted(() => {
    stop()
    clearTimeout(loopGetStateTimerId.value)
    handleSaveState()
    window.removeEventListener('beforeunload', handleSaveState)
  })

  return {
    state,
    onUploadImageChange,
    onUploadAudioChange,
    onUploadVideoChange,
    getImageUrl,
    getFileUrl,
    downloadImage,
    downloadFile,
    previewImage,
    start,
    stop,
    removeImage,
    removeAudio,
    removeVideo,
    toggleHistoryModal,
    onHistoryItemSelect,
    removeHistory,
    downloadWorkflow,
  }
}

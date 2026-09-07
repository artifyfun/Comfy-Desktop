// 工作流节点 → 表单 UI 控件映射（App 生成器的参数面板域逻辑）。
export const getRenderComponent = (node) => {
  const { category, type, selectedWidget } = node

  switch (category) {
    case 'input': {
      switch (selectedWidget.type) {
        case 'customtext':
        case 'string':
        case 'text': {
          return 'textarea'
        }
        case 'toggle': {
          return 'switch'
        }
        case 'slider': {
          return 'slider'
        }
        case 'number': {
          return 'input-number'
        }
        case 'combo': {
          // 图片/视频/音频加载类 widget → 上传控件。type 前缀匹配以兼容
          // 自定义节点（LoadImageFromPath、LoadImageBase64 等）：只认
          // `LoadImage` 会把图片加载节点误判成 select/customtext，
          // 模型把中文提示词当文件名传进 image 槽 → No such file。
          const t = String(type ?? '').toLowerCase()
          const w = String(selectedWidget.name ?? '').toLowerCase()
          if (t.includes('loadimage') || (t.includes('load') && w === 'image')) {
            return 'image-uploader'
          } else if (t.includes('loadaudio') || (t.includes('load') && w === 'audio')) {
            return 'audio-uploader'
          } else if (t.includes('loadvideo') || (t.includes('load') && w === 'file')) {
            return 'video-uploader'
          } else {
            return 'select'
          }
        }
        default: {
          return null
        }
      }
    }
    case 'output': {
      switch (selectedWidget.type) {
        case 'SaveImage':
        case 'Save Images Mikey': {
          return 'post-image'
        }
        case 'SaveAudio': {
          return 'audio'
        }
        case 'SaveVideo': {
          return 'video'
        }
        default: {
          return 'text'
        }
      }
    }
  }
}

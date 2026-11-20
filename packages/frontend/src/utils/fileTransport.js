// ComfyUI 文件传输域：种子生成 + /view 类文件取回与下载。
export function getSeed(n) {
  let num = ''
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      num += Math.floor(Math.random() * 9 + 1)
    } else {
      num += Math.floor(Math.random() * 10)
    }
  }
  return Number(num)
}

export function getFile(url, filename) {
  fetchFile({ url, filename, method: 'GET' })
}

export function postFile(url, filename) {
  fetchFile({ url, filename, method: 'POST' })
}

export async function fetchFile({ url, filename, method }) {
  try {
    // 1. 使用fetch发送POST请求
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json', // 根据实际API调整
      },
    }
    if (method === 'POST') {
      // 如果API需要参数，在此处添加
      options.body = JSON.stringify({})
    }
    const response = await fetch(url, options)

    // 2. 检查请求是否成功
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`)
    }

    // 3. 获取Blob数据
    const blob = await response.blob()

    // 4. 创建临时下载链接
    const blobUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename || 'download.jpg' // 默认文件名

    // 5. 触发下载
    document.body.appendChild(link)
    link.click()

    // 6. 清理资源
    setTimeout(() => {
      document.body.removeChild(link)
      URL.revokeObjectURL(blobUrl)
    }, 100)
  } catch (error) {
    console.error('图片下载失败:', error)
    throw error // 可根据需求改为友好提示
  }
}

// 全屏图片预览：命令式 DOM overlay（POST 取图 → 模态查看器）。
// 创建图像 URL（支持 POST 请求）
const createImageUrl = async (url) => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch (error) {
    console.error('Image load failed:', error)
  }
}

export async function previewImageFullscreen(url) {
  const imageUrl = await createImageUrl(url)
  // 检查是否已存在预览层
  if (document.getElementById('fullscreen-preview')) {
    return
  }

  // 创建样式（如果尚未添加）
  if (!document.getElementById('fullscreen-preview-styles')) {
    const style = document.createElement('style')
    style.id = 'fullscreen-preview-styles'
    style.textContent = `
          .fullscreen-overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0, 0, 0, 0.95);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 10000;
              cursor: pointer;
              opacity: 0;
              animation: fadeIn 0.3s forwards;
          }

          @keyframes fadeIn {
              to { opacity: 1; }
          }

          .fullscreen-image-container {
              max-width: 95%;
              max-height: 95%;
              position: relative;
              cursor: default;
          }

          .fullscreen-image {
              max-width: 100%;
              max-height: 90vh;
              object-fit: contain;
              box-shadow: 0 5px 30px rgba(0,0,0,0.5);
              border-radius: 8px;
              transform: scale(0.95);
              animation: zoomIn 0.4s 0.2s forwards;
          }

          @keyframes zoomIn {
              to { transform: scale(1); }
          }

          .close-button {
              position: fixed;
              top: 25px;
              right: 25px;
              width: 50px;
              height: 50px;
              background: rgba(255, 255, 255, 0.15);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              z-index: 10001;
              transition: all 0.3s;
              backdrop-filter: blur(5px);
              border: 1px solid rgba(255,255,255,0.1);
          }

          .close-button:hover {
              background: rgba(255, 255, 255, 0.25);
              transform: rotate(90deg);
          }

          .close-button::before,
          .close-button::after {
              content: '';
              position: absolute;
              width: 25px;
              height: 2px;
              background: white;
          }

          .close-button::before {
              transform: rotate(45deg);
          }

          .close-button::after {
              transform: rotate(-45deg);
          }

          @media (max-width: 768px) {
              .close-button {
                  top: 15px;
                  right: 15px;
                  width: 40px;
                  height: 40px;
              }

              .close-button::before,
              .close-button::after {
                  width: 20px;
              }
          }
      `
    document.head.appendChild(style)
  }

  // 创建遮罩层
  const overlay = document.createElement('div')
  overlay.id = 'fullscreen-preview'
  overlay.className = 'fullscreen-overlay'

  // 创建图片容器
  const imageContainer = document.createElement('div')
  imageContainer.className = 'fullscreen-image-container'

  // 创建图片元素
  const image = new Image()
  image.src = imageUrl
  image.className = 'fullscreen-image'
  image.alt = 'preview'

  // 创建关闭按钮
  const closeButton = document.createElement('div')
  closeButton.className = 'close-button'
  closeButton.title = 'close'

  // 组装元素
  imageContainer.appendChild(image)
  overlay.appendChild(imageContainer)
  overlay.appendChild(closeButton)
  document.body.appendChild(overlay)

  // 添加滚动锁定
  document.body.style.overflow = 'hidden'

  // 关闭函数
  const closePreview = () => {
    overlay.style.animation = 'none'
    overlay.style.opacity = '1'
    overlay.style.animation = 'fadeOut 0.3s forwards'

    // 添加淡出动画
    const fadeOutStyle = document.createElement('style')
    fadeOutStyle.textContent = `
          @keyframes fadeOut {
              to { opacity: 0; }
          }
      `
    document.head.appendChild(fadeOutStyle)

    setTimeout(() => {
      document.body.removeChild(overlay)
      document.body.style.overflow = ''
      document.head.removeChild(fadeOutStyle)

      // 移除事件监听器
      closeButton.removeEventListener('click', closePreview)
      overlay.removeEventListener('click', handleOverlayClick)
      window.removeEventListener('keydown', handleKeyDown)
    }, 300)
  }

  // 点击遮罩层关闭（排除图片和按钮）
  const handleOverlayClick = (e) => {
    if (e.target === overlay) {
      closePreview()
    }
  }

  // 键盘支持（ESC键关闭）
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      closePreview()
    }
  }

  // 添加事件监听
  closeButton.addEventListener('click', closePreview)
  overlay.addEventListener('click', handleOverlayClick)
  window.addEventListener('keydown', handleKeyDown)

  // 移动端滑动关闭支持
  let startY = 0
  overlay.addEventListener(
    'touchstart',
    (e) => {
      startY = e.touches[0].clientY
    },
    { passive: true },
  )

  overlay.addEventListener(
    'touchend',
    (e) => {
      const endY = e.changedTouches[0].clientY
      const diffY = endY - startY
      // 快速向下滑动关闭（超过50px）
      if (diffY > 50) {
        closePreview()
      }
    },
    { passive: true },
  )
}

// 玻璃拟态提示弹窗：命令式 DOM modal。
// 提示框生成函数
export function createGlassAlert(message, title = '提示') {
  // 创建遮罩层
  const overlay = document.createElement('div')
  overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      animation: fadeIn 0.4s forwards;
      backdrop-filter: blur(4px);
  `

  // 创建玻璃拟态弹窗
  const alertBox = document.createElement('div')
  alertBox.style.cssText = `
      background: rgba(15, 23, 42, 0.65);
      backdrop-filter: blur(12px);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(2, 8, 32, 0.4);
      width: 90%;
      max-width: 500px;
      overflow: hidden;
      border: 1px solid rgba(56, 70, 102, 0.4);
      transform: translateY(20px);
      opacity: 0;
      animation: slideIn 0.4s 0.1s forwards;
  `

  // 创建标题栏
  const header = document.createElement('div')
  header.style.cssText = `
      padding: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(56, 70, 102, 0.4);
  `

  const titleEl = document.createElement('h3')
  titleEl.style.cssText = `
      font-size: 1.4rem;
      color: #f8fafc;
      font-weight: 600;
      margin: 0;
  `
  titleEl.textContent = title

  const closeBtn = document.createElement('button')
  closeBtn.innerHTML = ``
  closeBtn.style.cssText = `
      background: rgba(56, 70, 102, 0.5);
      border: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      color: #94a3b8;
      font-size: 1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
  `
  closeBtn.onmouseenter = () => {
    closeBtn.style.background = 'rgba(239, 68, 68, 0.8)'
    closeBtn.style.color = 'white'
  }
  closeBtn.onmouseleave = () => {
    closeBtn.style.background = 'rgba(56, 70, 102, 0.5)'
    closeBtn.style.color = '#94a3b8'
  }

  // 创建内容区域
  const content = document.createElement('div')
  content.style.cssText = `
      padding: 30px 20px;
      font-size: 1.1rem;
      line-height: 1.6;
      color: #e2e8f0;
      text-align: center;
  `
  content.textContent = message

  // 创建操作按钮
  const actions = document.createElement('div')
  actions.style.cssText = `
      padding: 20px;
      display: flex;
      justify-content: center;
      border-top: 1px solid rgba(56, 70, 102, 0.4);
  `

  const confirmBtn = document.createElement('button')
  confirmBtn.textContent = 'Ok'
  confirmBtn.style.cssText = `
      background: linear-gradient(to right, #0ea5e9, #6366f1);
      color: white;
      border: none;
      padding: 12px 40px;
      font-size: 1rem;
      border-radius: 50px;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(37, 99, 235, 0.4);
      font-weight: 500;
  `
  confirmBtn.onmouseenter = () => {
    confirmBtn.style.transform = 'translateY(-2px)'
    confirmBtn.style.boxShadow = '0 6px 20px rgba(37, 99, 235, 0.6)'
  }
  confirmBtn.onmouseleave = () => {
    confirmBtn.style.transform = 'translateY(0)'
    confirmBtn.style.boxShadow = '0 4px 15px rgba(37, 99, 235, 0.4)'
  }

  // 添加关闭功能
  const closeAlert = () => {
    alertBox.style.animation = 'slideOut 0.3s forwards'
    overlay.style.animation = 'fadeOut 0.3s forwards'

    setTimeout(() => {
      document.body.removeChild(overlay)
      document.body.style.overflow = ''
    }, 300)
  }

  closeBtn.onclick = closeAlert
  confirmBtn.onclick = closeAlert

  // 组装元素
  header.appendChild(titleEl)
  header.appendChild(closeBtn)
  actions.appendChild(confirmBtn)

  alertBox.appendChild(header)
  alertBox.appendChild(content)
  alertBox.appendChild(actions)
  overlay.appendChild(alertBox)

  // 添加全局样式
  if (!document.getElementById('glass-alert-styles')) {
    const style = document.createElement('style')
    style.id = 'glass-alert-styles'
    style.textContent = `
          @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
          }
          @keyframes fadeOut {
              from { opacity: 1; }
              to { opacity: 0; }
          }
          @keyframes slideIn {
              from { transform: translateY(20px); opacity: 0; }
              to { transform: translateY(0); opacity: 1; }
          }
          @keyframes slideOut {
              from { transform: translateY(0); opacity: 1; }
              to { transform: translateY(20px); opacity: 0; }
          }
      `
    document.head.appendChild(style)
  }

  // 添加到文档并阻止背景滚动
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
}

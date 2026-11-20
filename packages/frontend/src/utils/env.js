// 环境探测：Electron 宿主与窗口查询参数。
export async function getElectronConfig() {
  let config
  try {
    config = await window.electronAPI.ArtifyLab.getConfig()
  } catch {
    // console.log(_e)
  }
  return config
}

export const isElectron = !!window.electronAPI

export const getAppInfo = async () => {
  let appInfo
  try {
    appInfo = await window.electronAPI.ArtifyLab.getAppInfo()
  } catch {
    // console.log(_e)
  }
  return appInfo
}

export function getQueryParam(key) {
  const params = new URLSearchParams(window.location.search)
  return params.get(key)
}

import { theme } from 'ant-design-vue'

/**
 * Comfy 风格设计令牌（与 docs/ui-redesign/PROPOSAL.md §2.1 一一对应）。
 * 事实源：ComfyUI 前端 main-*.css 的 charcoal/smoke/azure 色阶。
 * 本文件只管 antd 组件换肤；CSS 变量在 theme/comfy.css，两处同值。
 */
export const comfyTokens = {
  // surfaces
  bgBase: '#171718',
  surfaceDeep: '#202121',
  surface: '#262729',
  surfaceHover: '#313235',
  surfaceActive: '#3c3d42',
  // strokes
  stroke: '#313235',
  strokeStrong: '#494a50',
  selected: '#ffffff',
  // text
  text: '#ffffff',
  text2: '#a0a0a0',
  text3: '#8a8a8a',
  // accent
  accent: '#0b8ce9',
  accentHover: '#31b9f4',
  // brand（仅 logo，不做功能色）
  brand: '#f0ff41',
  ink: '#211927',
}

// 兼容旧引用（tech-* 命名退役过渡期）：指向新令牌
export const themeColors = {
  primary: comfyTokens.accent,
  primaryHover: comfyTokens.accentHover,
  primaryActive: comfyTokens.accent,
  success: '#4ade80',
  warning: comfyTokens.brand,
  error: '#f56c6c',
  info: comfyTokens.accent,
}

export const createThemeConfig = (isDark = false) => {
  if (!isDark) {
    // 浅色模式沿用 ComfyUI smoke 体系（当前应用以暗色为主，浅色仅保底不花精力）
    return {
      algorithm: theme.defaultAlgorithm,
      token: {
        colorPrimary: comfyTokens.accent,
        borderRadius: 6,
        fontFamily: "'Inter', -apple-system, 'PingFang SC', sans-serif",
        wireframe: false,
      },
    }
  }
  return {
    algorithm: theme.darkAlgorithm,
    token: {
      // 主色调：Comfy azure
      colorPrimary: comfyTokens.accent,
      colorPrimaryHover: comfyTokens.accentHover,
      colorPrimaryActive: comfyTokens.accentHover,

      // 功能色（Comfy 语义：语义色克制，不掺紫粉）
      colorSuccess: '#4ade80',
      colorWarning: comfyTokens.brand,
      colorError: '#f56c6c',
      colorInfo: comfyTokens.accent,

      // Comfy 表面阶梯
      colorBgBase: comfyTokens.bgBase,
      colorBgContainer: comfyTokens.surfaceDeep,
      colorBgElevated: comfyTokens.surfaceHover,
      colorBgLayout: comfyTokens.bgBase,
      colorBgSpotlight: comfyTokens.surfaceHover,
      colorBgMask: 'rgba(0, 0, 0, 0.72)',

      // 文字
      colorText: comfyTokens.text,
      colorTextSecondary: comfyTokens.text2,
      colorTextTertiary: comfyTokens.text3,
      colorTextQuaternary: comfyTokens.text3,

      // 描边：Comfy 1px 细描边体系
      colorBorder: comfyTokens.stroke,
      colorBorderSecondary: comfyTokens.stroke,
      colorSplit: comfyTokens.stroke,

      // 圆角阶梯：控件 6
      borderRadius: 6,
      borderRadiusLG: 10,
      borderRadiusSM: 4,

      fontFamily: "'Inter', -apple-system, 'PingFang SC', sans-serif",
      wireframe: false,
    },
    components: {
      Button: {
        borderRadius: 6,
        controlHeight: 32,
        fontSize: 13,
        fontWeight: 500,
        defaultBg: comfyTokens.surface,
        defaultBorderColor: comfyTokens.stroke,
      },
      Input: {
        borderRadius: 6,
        controlHeight: 32,
        fontSize: 13,
        colorBgContainer: comfyTokens.surface,
        colorBorder: comfyTokens.stroke,
        activeBorderColor: comfyTokens.accent,
        hoverBorderColor: comfyTokens.strokeStrong,
      },
      Select: {
        borderRadius: 6,
        controlHeight: 32,
        fontSize: 13,
        optionSelectedBg: comfyTokens.surfaceHover,
      },
      Modal: {
        borderRadiusLG: 14,
        headerBg: comfyTokens.surfaceDeep,
        contentBg: comfyTokens.surfaceDeep,
      },
      Card: {
        borderRadiusLG: 10,
        headerBg: comfyTokens.surfaceDeep,
        colorBgContainer: comfyTokens.surfaceDeep,
        colorBorderSecondary: comfyTokens.stroke,
      },
      Drawer: {
        borderRadiusLG: 10,
        headerBg: comfyTokens.surfaceDeep,
        bodyBg: comfyTokens.surfaceDeep,
      },
      Dropdown: {
        borderRadiusLG: 10,
        colorBgElevated: comfyTokens.surfaceHover,
      },
      Menu: {
        itemBg: 'transparent',
        itemSelectedBg: comfyTokens.surfaceHover,
        itemSelectedColor: comfyTokens.text,
        itemBorderRadius: 6,
      },
      Tooltip: {
        borderRadius: 6,
        colorBgSpotlight: comfyTokens.surfaceHover,
      },
      Table: {
        borderRadius: 6,
        headerBg: comfyTokens.surfaceDeep,
        headerColor: comfyTokens.text,
        colorBorderSecondary: comfyTokens.stroke,
      },
      Tabs: {
        cardBg: comfyTokens.surfaceDeep,
        itemSelectedColor: comfyTokens.text,
        itemHoverColor: comfyTokens.text,
        inkBarColor: comfyTokens.accent,
      },
      Progress: { borderRadius: 4 },
      Slider: { borderRadius: 4 },
      Switch: { borderRadius: 12 },
      Pagination: { borderRadius: 6 },
    },
  }
}

export const defaultThemeConfig = createThemeConfig(false)
export const darkThemeConfig = createThemeConfig(true)

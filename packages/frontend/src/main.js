import './assets/main.css'
import './assets/antd-custom.css'
import './assets/global.less'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import VueKonva from 'vue-konva'

import { applyThemeColors } from '@/utils/theme-utils'

import App from './App.vue'
import router from './router'

const app = createApp(App)

// 应用主题色
applyThemeColors()

app.use(createPinia())
app.use(router)
// A 界面无限画布（/canvas）的 Konva 渲染层
app.use(VueKonva)

app.mount('#app')

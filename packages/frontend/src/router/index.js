import { createRouter, createWebHistory } from 'vue-router'
import { isElectron } from '@/utils'

// 布局层只挂一次 header，路由切换只替换内容区（参考 vue-router 嵌套路由
// + Vben Admin / vue-naive-admin 的 LAYOUT 父路由模式）：
// 带顶导航的 5 个页面嵌套在 AppLayout 下；web/batch/about/404 是全屏工作页，保持平级。
const AppLayout = () => import('@/layouts/AppLayout.vue')

export const constantRoutes = [
  {
    path: '/',
    component: AppLayout,
    children: [
      {
        // 应用中心（首页）：header 首导航指向市场，避免自指
        path: '',
        component: () => import('@/views/apps/index.vue'),
        meta: {
          headerFirstNav: '/market',
          headerFirstNavKey: 'market',
          headerFirstNavIcon: 'mr-2 fas fa-store',
        },
      },
      {
        path: 'market',
        component: () => import('@/views/market/index.vue'),
      },
      {
        path: 'workbench',
        component: () => import('@/views/workbench/index.vue'),
        // 路由的 workbench 仅独立窗口形态；iframe 嵌入（C 宿主）由 AppLayout 按 query/iframe 隐藏 header
        // 页面内部自滚（消息区/会话列表 flex 内滚），布局壳锁高不产生外层滚动条
        meta: { scrollable: false },
      },
      {
        path: 'canvas',
        component: () => import('@/views/canvas/index.vue'),
        // 画布是自管交互区（内部 stage/滚动自理），布局层不提供外层滚动
        meta: { scrollable: false },
      },
      {
        path: 'gallery',
        component: () => import('@/views/gallery/index.vue'),
      },
    ],
  },
  {
    path: '/web',
    component: () => import('@/views/web/index.vue'),
  },
  {
    path: '/batch',
    component: () => import('@/views/batch/index.vue'),
  },
  {
    path: '/batch/detail',
    component: () => import('@/views/batch/detail.vue'),
  },
  {
    path: '/about',
    component: () => import('@/views/about/index.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    component: () => import('@/views/404/index.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: constantRoutes,
})

// 全局前置守卫
router.beforeEach((to, from, next) => {
  if (to.path === '/market') {
    if (!isElectron) {
      next('/')
      return
    }
  }

  next()
})

export default router

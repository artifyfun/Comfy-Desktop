import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

import Components from 'unplugin-vue-components/vite'
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const isLibBuild = process.env.BUILD_LIB === 'true'

  return {
    base: '/',
    build: isLibBuild
      ? {
          // 库模式构建配置
          outDir: 'dist/lib',
          entry: './src/index.js',
          lib: {
            entry: './src/index.js', // 库的入口文件
            name: 'ArtifyLib', // 库的全局变量名
            formats: ['es', 'umd'], // 支持的输出格式
            fileName: (format) => `index.${format === 'es' ? 'es' : 'global'}.js`, // 输出文件名
            cssFileName: 'index', // 输出css文件名
          },
          rollupOptions: {
            // 确保外部化处理那些你不想打包进库的依赖
            external: ['vue', 'vue-router', 'pinia', 'ant-design-vue', '@ant-design/icons-vue'],
            output: {
              sourcemap: false,
              exports: 'named',
              // 在 UMD 构建模式下为这些外部化的依赖提供一个全局变量
              globals: {
                vue: 'Vue',
                'vue-router': 'VueRouter',
                pinia: 'Pinia',
                'ant-design-vue': 'antd',
                '@ant-design/icons-vue': 'AntDesignIcons',
              },
            },
          },
          // 排除不需要的文件
          assetsInlineLimit: 0,
          copyPublicDir: false,
        }
      : {
          // 应用模式构建配置
          outDir: 'dist/frontend', // 修改输出目录
          entry: './src/main.js',
          rollupOptions: {
            output: {
              // 社区常见 vendor 分包：稳定第三方库单独成 chunk，
              // 业务迭代时浏览器可继续命中缓存
                manualChunks(id) {
                  if (!id.includes('node_modules')) return undefined
                  if (
                    id.includes('node_modules/vue/') ||
                    id.includes('node_modules/vue-router/') ||
                    id.includes('node_modules/pinia/') ||
                    id.includes('node_modules/@vueuse/')
                  ) {
                    return 'vue-vendor'
                  }
                  if (
                    id.includes('node_modules/ant-design-vue/') ||
                    id.includes('node_modules/@ant-design/icons-vue/')
                  ) {
                    return 'antd-vendor'
                  }
                  if (id.includes('node_modules/monaco-editor/')) {
                    return 'monaco-vendor'
                  }
                  if (id.includes('node_modules/xlsx/')) {
                    return 'xlsx-vendor'
                  }
                  if (
                    id.includes('node_modules/viewerjs/') ||
                    id.includes('node_modules/vue-json-pretty/')
                  ) {
                    return 'gallery-vendor'
                  }
                  if (
                    id.includes('node_modules/dayjs/') ||
                    id.includes('node_modules/localforage/') ||
                    id.includes('node_modules/axios/') ||
                    id.includes('node_modules/splitpanes/')
                  ) {
                    return 'utils-vendor'
                  }
                  return undefined
                },
            },
          },
        },
    server: {
      proxy: {
        // 画布「圈选裁剪」用同源 /view 取图（ComfyUI 直链会污染 canvas）
        '/view': {
          target: 'http://localhost:3008',
          changeOrigin: true,
        },
        // "/comfyui": {
        //   target: "http://localhost:9528",
        //   changeOrigin: false,
        //   ws: false,
        //   // rewrite: (path) => path.replace(/^\/comfyui/, ""),
        // },
        // '/api': 'http://localhost:3010',
      },
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag) => ['micro-app'].includes(tag),
          },
        },
      }),
      vueJsx(),
      Components({
        resolvers: [
          AntDesignVueResolver({
            importStyle: false, // css in js
          }),
        ],
      }),
      vueDevTools(),
      tailwindcss(),
      // 只在库构建时添加dts插件
      isLibBuild &&
        dts({
          outDir: 'dist/lib',
          include: ['src/**/*.vue', 'src/**/*.js'],
          exclude: ['src/main.js', 'src/router/**', 'src/stores/**'],
          insertTypesEntry: true,
        }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
    },
  }
})

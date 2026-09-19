import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import pluginOxlint from 'eslint-plugin-oxlint'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx,vue}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**']),

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        // Vite define 注入的构建常量（canvas/index.vue 使用）
        __APP_VERSION__: 'readonly',
      },
    },
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  ...pluginOxlint.configs['flat/recommended'],
  skipFormatting,
  {
    name: 'app/project-rules',
    rules: {
      // 页面/组件按目录命名为 index.vue、Composer.vue 等是项目惯例，不是缺陷
      'vue/multi-word-component-names': 'off',
      // 存量死代码（96 处）渐进清理：保持警告可见，不阻塞提交；
      // 新增的会在编辑器/CI 输出里露头
      'no-unused-vars': 'warn',
    },
  },
  {
    // vitest 测试文件里的 CommonJS require（迁移到 ESM 前的存量写法）
    name: 'app/test-globals',
    files: ['**/*.test.js', '**/*.test.ts'],
    languageOptions: {
      globals: {
        require: 'readonly',
      },
    },
  },
])

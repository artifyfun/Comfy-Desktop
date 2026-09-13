import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import unusedImports from 'eslint-plugin-unused-imports'
import pluginVue from 'eslint-plugin-vue'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import { configs as tseslintConfigs, parser as tseslintParser } from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

const extraFileExtensions = ['.vue']

const commonParserOptions = {
  parser: tseslintParser,
  projectService: true,
  tsconfigRootDir: import.meta.dirname,
  ecmaVersion: 2020,
  sourceType: 'module',
  extraFileExtensions
} as const

export default defineConfig([
  {
    ignores: [
      // 构建产物/依赖：必须 `**` 递归——`out/*` 只忽略第一层，曾导致 lint 扫进
      // out/main/index.js，报一堆 window/document 未定义
      'out/**',
      'dist/**',
      'node_modules/**',
      '.claude/**',
      '.worktrees/**',
      '.pnpm-store/**',
      'electron.vite.config.*.mjs',
      'packages/comfyui-desktop-bridge-types/*.d.ts',
      'acceptance/**',
      // 前端包自带 eslint 配置（packages/frontend/eslint.config.js），独立口径
      'packages/frontend/**',
      // 随包分发的前端产物 + vendored 第三方代码
      'src/main/artifylab/public/frontend/**',
      'src/main/artifylab/vendor/mimo2codex/**',
      // 一次性/独立 Node 脚本（.mts 未纳入 tsconfig project service）
      'scripts/*.mts',
      'scripts/wb-*.mjs',
      'scripts/wb-*.cjs'
    ]
  },
  {
    files: ['./**/*.{ts,mts}'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        ...commonParserOptions,
        projectService: {
          allowDefaultProject: ['eslint.config.ts', 'vitest.config.ts', 'vitest.setup.ts']
        }
      }
    }
  },
  {
    files: ['./scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ['./**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
      parser: vueParser,
      parserOptions: commonParserOptions
    }
  },
  pluginJs.configs.recommended,
  tseslintConfigs.recommended,
  pluginVue.configs['flat/recommended'],
  eslintConfigPrettier,
  {
    plugins: {
      'unused-imports': unusedImports
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      'unused-imports/no-unused-imports': 'error',
      'vue/no-v-html': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/match-component-import-name': 'error',
      'vue/no-unused-properties': 'error',
      'vue/no-unused-refs': 'error',
      'vue/no-useless-mustaches': 'error',
      'vue/no-useless-v-bind': 'error',
      'vue/no-unused-emit-declarations': 'error',
      'vue/no-use-v-else-with-v-for': 'error',
      'vue/one-component-per-file': 'error'
    }
  }
])

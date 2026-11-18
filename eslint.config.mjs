import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 构建产物、依赖与自测产物不需要参与静态检查
    ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', '.selftest/**', 'resources/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // .vue 单文件组件里的 <script lang="ts"> 交由 TypeScript 解析器处理
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue']
      }
    }
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      // 处理动态 JSON / 测试桩时允许显式 any
      '@typescript-eslint/no-explicit-any': 'off',
      // 以下划线开头的参数或变量表示有意忽略
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // 组件按业务语义命名（如 Sidebar.vue），不强制多单词
      'vue/multi-word-component-names': 'off',
      // BodyViewer 已先做 HTML 转义，允许使用 v-html
      'vue/no-v-html': 'off',
      // 允许只写了注释的 catch 块
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  // 必须放在最后，关闭与 Prettier 冲突的格式类规则
  prettier
)

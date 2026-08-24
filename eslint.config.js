import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

const nodeGlobals = {
  Buffer: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  Response: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
}

const browserGlobals = {
  ...nodeGlobals,
  document: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  matchMedia: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  window: 'readonly',
}

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'shared/generated/**',
      'coverage/**',
      '.dsh/**',
      '.agents/**',
      '.claude/**',
      '.open-design/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.test.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
]

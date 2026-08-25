import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {ignores: ['coverage', 'dist', 'dist-server', 'playwright-report', 'test-results']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The game server runs under Node.
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: {
      globals: {
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        {allowConstantExport: true},
      ],
    },
  },
)

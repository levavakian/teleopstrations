import react from '@vitejs/plugin-react'
import {defineConfig} from 'vitest/config'

export default defineConfig(({command}) => ({
  base: command === 'build' ? '/teleopstrations/' : '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: './src/test/setup.ts',
    css: true,
  },
}))

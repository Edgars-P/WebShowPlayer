/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        screen: 'screen.html',
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // The modules under test are plain logic over stubbed Web Audio and File
    // System Access globals, so they need no DOM. The svelte plugin above
    // compiles the runes in *.svelte.ts for us.
    environment: 'node',
  },
})

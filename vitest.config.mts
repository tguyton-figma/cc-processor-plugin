import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

// The engine imports `*.svg` as raw text (esbuild `loader: { '.svg': 'text' }`).
// Mirror that here so importing the engine under Vitest resolves icons the same
// way the shipped bundle does — otherwise `import x from './x.svg'` throws.
function svgAsText(): Plugin {
  return {
    name: 'svg-as-text',
    transform(_code, id) {
      if (!id.endsWith('.svg')) return null
      const svg = readFileSync(id, 'utf8')
      return { code: `export default ${JSON.stringify(svg)}`, map: null }
    },
  }
}

export default defineConfig({
  plugins: [svgAsText()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})

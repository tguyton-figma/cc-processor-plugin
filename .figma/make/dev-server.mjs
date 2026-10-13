// Dev server for the Code Connect plugin.
// - Bundles the plugin main thread (code.ts -> code.js) and rebuilds on change.
// - Bundles the validation engine (src/engine -> inlined into ui.html) on change.
// - Serves the plugin folder so ui.html is viewable in the browser preview.
// Uses esbuild's JS API (not the CLI) so it does not stop when stdin closes,
// which matters because the host runs this as a detached background process.
import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { inlineBundleIntoUI } from './build-ui.mjs'

// repo root = two levels up from .figma/make/
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)

const port = Number(process.env.PORT || 5173)
const host = '127.0.0.1'

const ctx = await esbuild.context({
  entryPoints: ['code.ts'],
  bundle: true,
  outfile: 'code.js',
  target: ['es2017'],
  // code.ts now shares the real validation engine (src/engine), which pulls in
  // icons.ts's inline .svg imports — load them as text just like the UI bundles.
  loader: { '.svg': 'text' },
  logLevel: 'info',
})

// One watch context per inlinable browser bundle; onEnd re-inlines the fresh
// bundle into ui.html so the panel controllers always see current globals
// (window.CCValidation from the engine, window.CCEditor from the editor).
const INLINE_BUNDLES = [
  { name: 'cc-engine', label: 'engine', entry: 'src/engine/index.ts' },
  { name: 'cc-editor', label: 'editor', entry: 'src/editor/index.ts' },
]

const inlineCtxs = await Promise.all(
  INLINE_BUNDLES.map(({ name, label, entry }) =>
    esbuild.context({
      entryPoints: [resolve(root, entry)],
      bundle: true,
      write: false,
      outdir: resolve(root, `.figma/make/.${label}-tmp`),
      target: ['es2020'],
      loader: { '.svg': 'text' },
      logLevel: 'silent',
      plugins: [
        {
          name: `inline-${label}-into-ui`,
          setup(build) {
            build.onEnd(async (result) => {
              if (result.errors.length) {
                console.error(`[${label}] build failed:`, result.errors[0].text)
                return
              }
              try {
                const changed = await inlineBundleIntoUI(name)
                if (changed) console.log(`[${label}] inlined into ui.html`)
              } catch (err) {
                console.error(`[${label}] inline failed:`, err.message)
              }
            })
          },
        },
      ],
    })
  )
)

await ctx.watch()
for (const c of inlineCtxs) await c.watch()
const server = await ctx.serve({ servedir: '.', host, port })
console.log(`[dev] serving http://${server.host}:${server.port}/ (ui.html)`)

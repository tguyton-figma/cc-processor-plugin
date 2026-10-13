// Bundles the browser-side sources into single IIFEs and inlines them into
// ui.html between their <script id="…"> markers. The plugin UI must be a
// self-contained HTML document (Figma injects it as __html__, and the iframe
// can't fetch scripts off the network), so we inline rather than reference
// external files — the same reason code.js is a committed artifact.
//
//   src/engine/index.ts → window.CCValidation → <script id="cc-engine">
//   src/editor/index.ts → window.CCEditor     → <script id="cc-editor">
import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The inlinable browser bundles, keyed by the <script id> that hosts each one.
const BUNDLES = {
  'cc-engine': { entry: 'src/engine/index.ts', globalName: 'CCValidation' },
  'cc-editor': { entry: 'src/editor/index.ts', globalName: 'CCEditor' },
  'cc-pipeline': { entry: 'src/ui/pipeline/index.ts', globalName: 'CCPipeline' },
}

export async function buildBundle(name) {
  const b = BUNDLES[name]
  if (!b) throw new Error(`Unknown bundle: ${name}`)
  const result = await esbuild.build({
    entryPoints: [resolve(root, b.entry)],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: b.globalName,
    target: ['es2020'],
    loader: { '.svg': 'text' },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

// Back-compat alias — dev-server and npm scripts referenced this by name.
export const buildEngineBundle = () => buildBundle('cc-engine')

// Replace the body of <script id="{name}"> in `html` with `bundle`.
function inlineInto(html, name, bundle) {
  const OPEN = `<script id="${name}">`
  const CLOSE = '</script>'
  const start = html.indexOf(OPEN)
  if (start === -1) throw new Error(`ui.html is missing the <script id="${name}"> marker`)
  const bodyStart = start + OPEN.length
  const end = html.indexOf(CLOSE, bodyStart)
  if (end === -1) throw new Error(`ui.html ${name} <script> is not closed`)
  // Newlines keep the inlined bundle readable in the committed ui.html.
  return html.slice(0, bodyStart) + '\n' + bundle.trimEnd() + '\n' + html.slice(end)
}

// Inline a single bundle into ui.html. Returns true if the file changed.
export async function inlineBundleIntoUI(name) {
  const bundle = await buildBundle(name)
  const uiPath = resolve(root, 'ui.html')
  const html = await readFile(uiPath, 'utf8')
  const next = inlineInto(html, name, bundle)
  if (next !== html) {
    await writeFile(uiPath, next)
    return true
  }
  return false
}

// Back-compat alias used by dev-server's engine watcher.
export const inlineEngineIntoUI = () => inlineBundleIntoUI('cc-engine')

// Inline every bundle in one pass (used by `npm run build:ui`).
export async function inlineAllIntoUI() {
  const uiPath = resolve(root, 'ui.html')
  let html = await readFile(uiPath, 'utf8')
  const before = html
  for (const name of Object.keys(BUNDLES)) {
    html = inlineInto(html, name, await buildBundle(name))
  }
  if (html !== before) {
    await writeFile(uiPath, html)
    return true
  }
  return false
}

// Run directly (npm run build:ui) — as a watcher when invoked from dev-server it
// imports the functions above instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  const changed = await inlineAllIntoUI()
  console.log(changed ? '[build:ui] bundles inlined into ui.html' : '[build:ui] ui.html already current')
}

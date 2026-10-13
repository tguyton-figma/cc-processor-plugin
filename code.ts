import {
  serializeRunState,
  effectiveComponentStatus,
  type ComponentRef,
  type StageId,
} from './src/pipeline'
import {
  readRunState,
  applyPlatform,
  addToScope,
  removeFromScope,
  startComponentStage,
  finishComponentStage,
  setComponentStageStatus,
} from './src/run'
import { readWork, writeWork } from './src/workspace'
import { TemplateStore, buildVarName } from './src/variables'
import {
  type BackendProfile,
  DEFAULT_BACKEND_PROFILE,
  EMPTY_BACKEND_PROFILE,
  backendUrl,
  normalizeProfile,
} from './src/transformer/profile'
// The real validation engine — the SAME code the live editor runs via
// window.CCValidation. Now that its Zod dependency (and the dynamic import() the
// main-thread sandbox rejected) is gone, the whole engine is sandbox-safe, so the
// headless validate stage can share it instead of a weaker parallel parser. This
// is what keeps the stage's verdict identical to the signals the editor shows.
import {
  validate as engineValidate,
  mergeSemantic as engineMergeSemantic,
  parseConfig as parseEngineConfig,
  type SemanticFinding as EngineSemanticFinding,
} from './src/engine'

// ─── Storage keys ───
// LOCKED: auth/storage implementation cannot change, only the affordance

const PLANT_REST_KEY = 'cc-processor:plant_rest'
const PLANT_CLI_KEY = 'cc-processor:plant_cli'
const FILE_URL_KEY = 'cc-processor:file_url'

// ─── Stage-4 transformer (OAuth) storage ───
// The transformer is OPTIONAL and headless-safe: with no connection, stage 4 is
// skipped and stage 5 (manual paste) is the merge point (PLAN.md §5.1). The plugin
// does not store a static token anymore — it authenticates to a transformer over
// OAuth (PKCE) and holds a refresh token.
//
// The PROFILE (which backend, its OAuth paths, run path, slug) is NOT a secret —
// it lives in document pluginData so collaborators inherit the same target.
const TRANSFORMER_PROFILE_KEY = 'cc-processor:transformer_profile'
// The REFRESH TOKEN is a per-user secret and MUST NOT travel with the document
// (pluginData is readable by every collaborator). It lives in figma.clientStorage,
// which is per-user + per-machine. A short display label for the connected account
// rides alongside it (also per-user).
const TRANSFORMER_REFRESH_KEY = 'cc-processor:transformer_refresh'
const TRANSFORMER_ACCOUNT_KEY = 'cc-processor:transformer_account'
// The backend assigns a public client id via a one-time dynamic registration
// (POST /api/oauth/register). It's not a secret, but it IS per-backend, so we cache
// it (with the baseUrl it was minted for) in clientStorage and re-register only when
// the target backend changes.
const TRANSFORMER_CLIENT_KEY = 'cc-processor:transformer_client'

// The one flat library collection that holds the published template files (see
// PLAN.md §3.1 and src/variables). Created lazily on first save.
const LIBRARY_NAME = '.code-connect'

// Extract the bare file key from a saved file URL (or accept a bare key). Mirrors
// the UI's extractFileKey (src/ui/pipeline) — the main thread needs its own copy to
// build REST URLs for the Dev Mode publish path, which runs entirely main-side.
function extractFileKey(raw: string): string | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.split('/')
    for (let i = 0; i < parts.length; i++) {
      if ((parts[i] === 'design' || parts[i] === 'file') && parts[i + 1]) {
        if (parts[i + 2] === 'branch' && parts[i + 3]) return parts[i + 3]
        return parts[i + 1]
      }
    }
  } catch {
    // not a URL — fall through to the bare-key test
  }
  if (/^[0-9a-zA-Z]{22,128}$/.test(trimmed)) return trimmed
  return null
}

// ─── Selection → component info ───

async function resolveToComponentSet(node: SceneNode): Promise<ComponentNode | ComponentSetNode | null> {
  if (node.type === 'COMPONENT_SET') {
    return node as ComponentSetNode
  } else if (node.type === 'COMPONENT') {
    const comp = node as ComponentNode
    if (comp.parent && comp.parent.type === 'COMPONENT_SET') {
      return comp.parent as ComponentSetNode
    }
    return comp
  } else if (node.type === 'INSTANCE') {
    try {
      const main = await (node as InstanceNode).getMainComponentAsync()
      if (main) {
        if (main.parent && main.parent.type === 'COMPONENT_SET') {
          return main.parent as ComponentSetNode
        }
        return main
      }
    } catch {
      // ignore
    }
  }
  return null
}

// ─── Relaunch data ───
// The template editor is kept (see PLAN.md option C) but is no longer a menu
// command — the menu is just Open (process); configuration now lives in the
// pipeline's stage-1 Environment view. A document relaunch button keeps the
// editor reachable until it moves into the Main pane.
function setDocumentRelaunchData(): void {
  figma.root.setRelaunchData({ template: 'Edit a Code Connect template' })
}

// ─── Template import: parse a .figma.ts template file into its parts ───
//
// A template file (per skills/template-api) is:
//   // url=…?node-id=…     ← REQUIRED   → identity (node-id lives in the file)
//   // source=…            ← optional   → source path
//   // component=…         ← optional   → the group name (`<component>/<label>`)
//   // label=…             ← the CC label → the leaf name (`<component>/<label>`)
//   // language=…          ← optional   → snippet highlighting hint
//   import …               (import lines) → dependencies
//   const … / helpers      (other code)   → definitions
//   export default {
//     example: figma.code`…`,            → example (inner)
//     imports: [ … ],                    → imports
//     id: '…',                           → id
//     metadata: { … }                    → metadata
//   }

interface ParsedTemplate {
  url: string
  source: string
  component: string
  label: string
  language: string
  dependencies: string
  definitions: string
  example: string
  imports: string
  id: string
  metadata: string
}

// Substring between the bracket at openIdx and its match. String contents are
// skipped so brackets inside quotes/backticks don't throw off the depth count.
function extractBalanced(str: string, openIdx: number, open: string, close: string, includeDelims: boolean): string {
  if (openIdx < 0 || str[openIdx] !== open) return ''
  let depth = 0
  let inStr: string | null = null
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i]
    if (inStr) {
      if (ch === inStr && str[i - 1] !== '\\') inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return includeDelims ? str.slice(openIdx, i + 1) : str.slice(openIdx + 1, i)
    }
  }
  return ''
}

// Inner content of a template literal opening at btIdx, tracking ${…} so nested
// braces/backticks inside interpolations don't end it early.
function extractTemplateLiteral(str: string, btIdx: number): string {
  if (btIdx < 0 || str[btIdx] !== '`') return ''
  let braceDepth = 0
  let i = btIdx + 1
  for (; i < str.length; i++) {
    const ch = str[i]
    if (braceDepth > 0) {
      if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth--
      continue
    }
    if (ch === '$' && str[i + 1] === '{') { braceDepth = 1; i++; continue }
    if (ch === '`' && str[i - 1] !== '\\') break
  }
  return str.slice(btIdx + 1, i)
}

function parseTemplateFile(text: string): { parsed: ParsedTemplate; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  // Header comments live in the leading comment block only — stop at first code.
  const readHeader = (key: string): string => {
    const re = new RegExp('^\\s*//\\s*' + key + '\\s*=\\s*(.+?)\\s*$')
    for (const ln of text.split('\n')) {
      const m = ln.match(re)
      if (m) return m[1].trim()
      if (ln.trim() && ln.trim().indexOf('//') !== 0) break
    }
    return ''
  }
  const url = readHeader('url')
  const source = readHeader('source')
  const component = readHeader('component')
  const label = readHeader('label')
  const language = readHeader('language')

  const edIdx = text.indexOf('export default')
  const empty: ParsedTemplate = { url, source, component, label, language, dependencies: '', definitions: '', example: '', imports: '[]', id: '', metadata: '' }
  if (edIdx === -1) {
    errors.push('No "export default { … }" block found')
    return { parsed: empty, errors, warnings }
  }

  // Preamble (before export default, minus header comments): import lines are
  // dependencies, everything else is definitions.
  const depLines: string[] = []
  const defLines: string[] = []
  for (const raw of text.slice(0, edIdx).split('\n')) {
    const ln = raw.trim()
    if (!ln || ln.indexOf('//') === 0) continue
    if (/^import\b/.test(ln)) depLines.push(raw.replace(/\s+$/, ''))
    else defLines.push(raw.replace(/\s+$/, ''))
  }

  const objBody = extractBalanced(text, text.indexOf('{', edIdx), '{', '}', false)

  let example = ''
  const codeMatch = /figma\.(?:code|tsx|jsx|html|swift|kotlin)\s*`/.exec(objBody)
  if (codeMatch) example = extractTemplateLiteral(objBody, codeMatch.index + codeMatch[0].length - 1)

  let imports = ''
  const impMatch = /\bimports\s*:\s*\[/.exec(objBody)
  if (impMatch) imports = extractBalanced(objBody, objBody.indexOf('[', impMatch.index), '[', ']', true)

  let id = ''
  const idMatch = /\bid\s*:\s*(['"])((?:[^'"\\]|\\.)*)\1/.exec(objBody)
  if (idMatch) id = idMatch[2]

  let metadata = ''
  const metaMatch = /\bmetadata\s*:\s*\{/.exec(objBody)
  if (metaMatch) metadata = extractBalanced(objBody, objBody.indexOf('{', metaMatch.index), '{', '}', true)

  if (!url) errors.push('Missing the required "// url=" header')
  if (!codeMatch || !example) errors.push('No figma.code`…` example found (also accepts figma.tsx/jsx/html/swift/kotlin)')
  if (!id) warnings.push('No "id" — will use the component name')
  if (!imports) { imports = '[]'; warnings.push('No "imports" — defaulting to []') }

  return {
    parsed: { url, source, component, label, language, dependencies: depLines.join('\n'), definitions: defLines.join('\n'), example, imports, id, metadata },
    errors,
    warnings
  }
}

// Selection → one template per selected TEXT node, or per frame/section/group
// (its descendant text nodes concatenated top-to-bottom).
async function collectTemplatesFromSelection(): Promise<string[]> {
  const texts: string[] = []
  for (const node of figma.currentPage.selection) {
    if (node.type === 'TEXT') {
      const t = node.characters.trim()
      if (t) texts.push(t)
      continue
    }
    const container = node as unknown as { findAllWithCriteria?: (c: { types: NodeType[] }) => SceneNode[] }
    if (typeof container.findAllWithCriteria === 'function') {
      let tnodes: TextNode[] = []
      try { tnodes = container.findAllWithCriteria({ types: ['TEXT'] }) as TextNode[] } catch { tnodes = [] }
      tnodes.sort((a, b) => (a.absoluteBoundingBox?.y ?? 0) - (b.absoluteBoundingBox?.y ?? 0))
      const combined = tnodes.map(t => t.characters).join('\n').trim()
      if (combined) texts.push(combined)
    }
  }
  return texts
}

// A parsed template resolved to its published address in the flat schema: the
// component group and the label leaf (`<component>/<label>`). No modes, no
// extension collections — identity lives in the file, the name is display.
interface TemplateItem {
  id: string
  source: 'selection' | 'paste'
  raw: string
  parsed: ParsedTemplate
  component: string
  label: string
  status: 'valid' | 'warn' | 'error'
  message: string
}

// ─── Template validation: config + semantic checks ───
// The validation engine (src/engine, bundled into ui.html as window.CCValidation)
// runs all structural/lint checks in the iframe on every keystroke. The checks it
// CAN'T run there — the ones needing figma.* — live here and report findings by
// the same rule ids. Keep these ids/keys in sync with src/engine/config.ts
// (CONFIG_KEY) and src/engine/rules.ts (the semantic.* rules).
const VALIDATION_CONFIG_KEY = 'cc-processor:validation_config'

function readValidationConfig(): string {
  try {
    return figma.root.getPluginData(VALIDATION_CONFIG_KEY) || '{}'
  } catch {
    return '{}'
  }
}

// A tiny, dependency-free mirror of the semantic rules' shipped defaults + copy,
// used by the template-import flow (buildItem) to grade pasted files inline. The
// full engine drives the validate STAGE (see validateDraft); this mirror only
// covers the figma.* semantic rules that run HERE. Keep in sync with
// src/engine/rules.ts.
const SEMANTIC_DEFAULT_LEVEL: Record<string, string> = {
  'semantic.nodeNotFound': 'comment',
  'semantic.notComponent': 'error',
  'semantic.notPublished': 'error',
}
const SEMANTIC_MESSAGE: Record<string, string> = {
  'semantic.nodeNotFound': 'The URL’s node-id doesn’t match any node in this file.',
  'semantic.notComponent': 'The URL points to a node that isn’t a component or component set — Code Connect can only attach to components.',
  'semantic.notPublished': 'The component isn’t published to a library, so a saved connection would have nothing to attach to.',
}

// The user's persisted config is a minimal RuleId → Severity deviation map.
function readConfigMap(): Record<string, string> {
  try {
    const obj = JSON.parse(readValidationConfig())
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// A rule's effective level: the user's override, else its shipped default.
function severityFor(ruleId: string, config: Record<string, string>): string {
  return config[ruleId] || SEMANTIC_DEFAULT_LEVEL[ruleId] || 'mute'
}

// node-id from a Figma URL, colon-normalized (matches the engine's extractNodeId).
function nodeIdFromUrl(url: string): string {
  const m = /node-id(?:=|%3d)([^&\s]+)/i.exec(url)
  if (!m) return ''
  return decodeURIComponent(m[1]).replace(/-/g, ':')
}

interface SemanticFinding {
  ruleId: string
  message?: string
}

function friendlyNodeType(t: string): string {
  const map: Record<string, string> = {
    INSTANCE: 'component instance',
    FRAME: 'frame',
    GROUP: 'group',
    COMPONENT: 'component',
    COMPONENT_SET: 'component set',
    TEXT: 'text layer',
    SECTION: 'section',
  }
  return map[t] || t.toLowerCase().replace(/_/g, ' ')
}

// Resolve the node-id from the template's URL and report what the structural
// layer can't know: does the node exist here, is it a component/component set,
// and is it published. nodeId arrives colon-normalized (see engine extractNodeId).
async function runSemanticChecks(nodeId: string): Promise<SemanticFinding[]> {
  const findings: SemanticFinding[] = []
  if (!nodeId) return findings

  let node: BaseNode | null = null
  try {
    node = await figma.getNodeByIdAsync(nodeId)
  } catch {
    node = null
  }
  if (!node) {
    findings.push({ ruleId: 'semantic.nodeNotFound' })
    return findings
  }

  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
    findings.push({
      ruleId: 'semantic.notComponent',
      message: 'The URL points to a ' + friendlyNodeType(node.type) + ', not a component or component set — Code Connect can only attach to components.',
    })
    return findings
  }

  try {
    const status = await (node as ComponentNode | ComponentSetNode).getPublishStatusAsync()
    if (status === 'UNPUBLISHED') findings.push({ ruleId: 'semantic.notPublished' })
  } catch {
    // Publish status unavailable (e.g. no library access) — don't fabricate a fail.
  }
  return findings
}

// ─── Command handlers ───

// ─── Environment config (stage 1) ───
// The three text setup fields — a file key plus two secrets (REST PLANT, CLI
// PLANT) — live in the pipeline's Environment view (stage 1). The transformer is
// NOT a text field anymore: it's an OAuth connection (Connect/Disconnect), handled
// by its own message flow below.
//
// PLANTs are secrets: we store the value on the document root but reflect only
// *whether* one is saved back to the iframe, so a stored secret never re-enters
// the DOM. A blank value on save means "keep the current one".
const ENV_STORAGE_KEY: Record<string, string> = {
  file: FILE_URL_KEY,
  rest: PLANT_REST_KEY,
  cli: PLANT_CLI_KEY,
}
const ENV_FIELD_LABEL: Record<string, string> = {
  file: 'File key',
  rest: 'REST PLANT',
  cli: 'CLI PLANT',
}

// ─── Transformer auth state ───
// The connection's per-user secret (refresh token) and short-lived access token
// live off the document. sendState() is synchronous, but clientStorage is async,
// so we cache the connection's *display* state (connected + account label) in
// memory, hydrated once at boot and updated on connect/disconnect. The access
// token is cached with its expiry and refreshed lazily at run time.
let transformerAuth: { connected: boolean; account: string } = { connected: false, account: '' }
let accessCache: { token: string; expiresAt: number } | null = null

// The transformer profile is document-level (not a secret): read it back
// normalized so a partial/older-shape saved value stays usable.
function readTransformerProfile(): BackendProfile {
  const raw = (figma.root.getPluginData(TRANSFORMER_PROFILE_KEY) || '').trim()
  if (!raw) return DEFAULT_BACKEND_PROFILE
  try {
    return normalizeProfile(JSON.parse(raw))
  } catch {
    return DEFAULT_BACKEND_PROFILE
  }
}

function writeTransformerProfile(p: BackendProfile): void {
  figma.root.setPluginData(TRANSFORMER_PROFILE_KEY, JSON.stringify(p))
}

// Hydrate the in-memory connection state from clientStorage. Called at boot so the
// first sendState reflects a connection established in a prior session.
async function hydrateTransformerAuth(): Promise<void> {
  try {
    const refresh = (await figma.clientStorage.getAsync(TRANSFORMER_REFRESH_KEY)) as string | undefined
    const account = (await figma.clientStorage.getAsync(TRANSFORMER_ACCOUNT_KEY)) as string | undefined
    transformerAuth = { connected: Boolean(refresh), account: account || '' }
  } catch {
    transformerAuth = { connected: false, account: '' }
  }
}

// The environment snapshot the UI renders: the file key verbatim (not a secret),
// a boolean per PLANT secret, and the transformer connection (never any token —
// only whether we're connected, the account label, and the profile to target).
function readEnvConfig(): {
  fileKey: string
  restSaved: boolean
  cliSaved: boolean
  editorType: string
  transformer: { connected: boolean; account: string; profile: BackendProfile }
} {
  return {
    fileKey: figma.root.getPluginData(FILE_URL_KEY) || '',
    restSaved: Boolean(figma.root.getPluginData(PLANT_REST_KEY)),
    cliSaved: Boolean(figma.root.getPluginData(PLANT_CLI_KEY)),
    // Which mode the plugin is running in ('dev' | 'figma' | 'figjam' | …). The
    // publish stage uses this to foreground the download fallback in Dev Mode, where
    // the Variables plugin API is read-only.
    editorType: figma.editorType,
    transformer: {
      connected: transformerAuth.connected,
      account: transformerAuth.account,
      profile: readTransformerProfile(),
    },
  }
}

// The template editor — the kept, rewired tool (PLAN.md option C). Its live
// src/engine validation runs in the iframe; the figma.* semantic checks run
// here. Saving writes ONE template file into the flat library collection via
// TemplateStore — one variable named `<component>/<label>`, one atomic write.
// The old extension-collection / modes-as-labels / label-picker machinery is
// gone: component and label come straight from the file's headers.
async function handleTemplate(): Promise<void> {
  // The template window is drag-resizable from the iframe (see ui.html). We keep
  // the last user-chosen size so any auto-height reflow preserves their width.
  const clampW = (w: number): number => Math.max(520, Math.min(1600, Math.round(w)))
  const clampH = (h: number): number => Math.max(360, Math.min(1000, Math.round(h)))

  // Remember the window's size AND position across sessions (per-user, via
  // clientStorage). Read the saved geometry before showing so the window opens
  // exactly where the user last left it.
  const WINDOW_STATE_KEY = 'cc:templateWindow'
  let saved: { w?: number; h?: number; x?: number; y?: number } = {}
  try { saved = (await figma.clientStorage.getAsync(WINDOW_STATE_KEY)) || {} } catch { saved = {} }

  let tplW = clampW(saved.w ?? 660)
  let tplH = clampH(saved.h ?? 456)

  // Wider window: the template view is a horizontal split (signals left, editor right).
  const showOpts: ShowUIOptions = { width: tplW, height: tplH }
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    showOpts.position = { x: Math.round(saved.x), y: Math.round(saved.y) }
  }
  figma.showUI(__html__, showOpts)

  // Persist current geometry (debounced by the caller). Figma fires no "window
  // moved" event, so we sample getPosition() — it reflects title-bar drags too.
  // A string guard skips redundant writes when nothing actually changed.
  let lastPersisted = ''
  const persistWindow = (): void => {
    let x: number | undefined
    let y: number | undefined
    try {
      const p = figma.ui.getPosition()
      x = Math.round(p.windowSpace.x)
      y = Math.round(p.windowSpace.y)
    } catch {
      // No UI / position unavailable — persist size only.
    }
    const state = { w: tplW, h: tplH, x, y }
    const sig = JSON.stringify(state)
    if (sig === lastPersisted) return
    lastPersisted = sig
    figma.clientStorage.setAsync(WINDOW_STATE_KEY, state).catch(() => {})
  }

  const items: TemplateItem[] = []
  let seq = 0

  // Parse a template and resolve it to `<component>/<label>`, folding the
  // tunable semantic severities into the verdict so an *error* actually blocks.
  // The structural/lint rules run in the engine (UI iframe) and arrive as
  // `structuralError`; the semantic rules (need figma.*) resolve here against
  // the user's config — the same runSemanticChecks the live panel uses.
  const buildItem = async (source: 'selection' | 'paste', text: string, structuralError = false, structuralMessage = ''): Promise<TemplateItem> => {
    seq += 1
    const id = 'tpl-' + seq
    const { parsed, errors, warnings } = parseTemplateFile(text)
    const mk = (over: Partial<TemplateItem>): TemplateItem => ({
      id, source, raw: text, parsed, component: '', label: '', status: 'error', message: '', ...over
    })
    if (errors.length > 0) return mk({ message: errors[0] })

    // The group name: the `// component=` header, else the id, else the name of
    // the component the URL's node resolves to. Identity itself lives in the file.
    let component = (parsed.component || parsed.id || '').trim()
    if (!component) {
      const nodeId = nodeIdFromUrl(parsed.url)
      if (nodeId) {
        try {
          const n = await figma.getNodeByIdAsync(nodeId)
          const cs = n ? await resolveToComponentSet(n as SceneNode) : null
          if (cs) component = cs.name
        } catch {
          // node lookup failed — fall through to the missing-component message
        }
      }
    }
    if (!component) return mk({ message: 'Add a “// component=” header (or a resolvable “// url=”) so the file can be named' })

    const label = (parsed.label || '').trim()
    if (!label) return mk({ component, message: 'Add a “// label=” header (e.g. web, ios) — it names the template' })
    if (label.indexOf('/') !== -1) return mk({ component, label, message: 'A label can’t contain “/”' })

    const cfg = readConfigMap()
    const errFinding = (await runSemanticChecks(nodeIdFromUrl(parsed.url)))
      .find(f => severityFor(f.ruleId, cfg) === 'error')
    if (errFinding || structuralError) {
      return mk({
        component, label, status: 'error',
        message: errFinding
          ? (errFinding.message || SEMANTIC_MESSAGE[errFinding.ruleId] || 'Validation error')
          : (structuralMessage || 'Blocked by a validation error')
      })
    }

    let message = 'Ready to save as ' + component + '/' + label
    if (warnings.length > 0) message += ' · ' + warnings.join(' · ')
    return mk({ component, label, status: warnings.length > 0 ? 'warn' : 'valid', message })
  }

  const sanitize = (): Array<Record<string, unknown>> =>
    items.map(it => ({
      id: it.id, source: it.source, componentName: it.component,
      status: it.status, message: it.message, mode: it.label
    }))
  const pushItems = (initial: boolean): void => {
    const base = { type: initial ? 'show-template' : 'template-items', items: sanitize() }
    // The live editor validates against the user's severity config; ship it once
    // on show so keystroke validation has it immediately.
    figma.ui.postMessage(initial ? { ...base, config: readValidationConfig() } : base)
  }

  // Pre-load anything already selected on the canvas.
  for (const t of await collectTemplatesFromSelection()) items.push(await buildItem('selection', t))
  pushItems(true)

  figma.ui.onmessage = async (msg: { type: string; text?: string; id?: string; width?: number; height?: number; nodeId?: string; reqId?: number; config?: string; blocked?: boolean; blockMsg?: string; message?: string; error?: boolean }) => {
    if (msg.type === 'validate-semantic' && typeof msg.nodeId === 'string') {
      // Live-editor round-trip: run the figma.* checks and reply by request id so
      // the iframe can drop stale responses.
      const findings = await runSemanticChecks(msg.nodeId)
      figma.ui.postMessage({ type: 'semantic-result', reqId: msg.reqId, findings })
    } else if (msg.type === 'set-validation-config' && typeof msg.config === 'string') {
      // Persist the user's per-rule severity choices (minimal deviations JSON).
      try {
        figma.root.setPluginData(VALIDATION_CONFIG_KEY, msg.config)
      } catch {
        // pluginData write can fail on a read-only/branch context — non-fatal.
      }
    } else if (msg.type === 'remove-template' && msg.id) {
      const i = items.findIndex(it => it.id === msg.id)
      if (i !== -1) { items.splice(i, 1); pushItems(false) }
    } else if (msg.type === 'clear-templates') {
      items.length = 0
      pushItems(false)
    } else if (msg.type === 'save-to-variables' && typeof msg.text === 'string') {
      // The Variables action — writes the one template in the editor into the flat
      // library collection as `<component>/<label>` (one atomic setValueForMode).
      // The structural verdict rides in on blocked/blockMsg (the editor's live
      // gate); the semantic rules are re-checked inside buildItem, so the save
      // gate matches the panel.
      const t = msg.text.trim()
      if (!t) {
        figma.ui.postMessage({ type: 'variables-result', ok: false, message: 'Nothing to save yet' })
        return
      }
      const it = await buildItem('paste', t, !!msg.blocked, typeof msg.blockMsg === 'string' ? msg.blockMsg : '')
      const ready = (it.status === 'valid' || it.status === 'warn') && it.component && it.label
      if (!ready) {
        const message = it.message || 'This template isn’t ready to save to variables'
        figma.ui.postMessage({ type: 'variables-result', ok: false, message })
        figma.notify(message, { timeout: 3000, error: true })
        return
      }
      try {
        const store = await TemplateStore.ensure(LIBRARY_NAME)
        const rec = await store.write({ component: it.component, label: it.label, file: it.raw })
        figma.ui.postMessage({ type: 'variables-result', ok: true, mode: rec.label, message: 'Saved ' + rec.component + '/' + rec.label })
        figma.notify('Saved ' + rec.component + '/' + rec.label + ' to variables', { timeout: 3000 })
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        figma.ui.postMessage({ type: 'variables-result', ok: false, message: m })
        figma.notify('Couldn’t save to variables: ' + m, { timeout: 3000, error: true })
      }
    } else if (msg.type === 'notify' && typeof msg.message === 'string') {
      // UI-side actions (e.g. Copy, which does its clipboard work in the iframe)
      // surface their outcome through a Figma toast.
      figma.notify(msg.message, { timeout: 2500, error: !!msg.error })
    } else if (msg.type === 'user-resize' && typeof msg.width === 'number' && typeof msg.height === 'number') {
      // Drag-to-resize from the iframe edges/corner. Remember the size so a later
      // auto-height pass keeps the user's width.
      tplW = clampW(msg.width)
      tplH = clampH(msg.height)
      figma.ui.resize(tplW, tplH)
    } else if (msg.type === 'maximize' && typeof msg.width === 'number' && typeof msg.height === 'number') {
      // Fill-available-space shortcut (Cmd/Ctrl+Shift+F). The iframe sends the
      // screen's available size; Figma clamps ui.resize() to whatever the editor
      // viewport actually allows, so requesting large is safe. A generous cap
      // guards against absurd values. Remember it so auto-height keeps the width.
      tplW = Math.max(520, Math.min(4000, Math.round(msg.width)))
      tplH = Math.max(360, Math.min(3000, Math.round(msg.height)))
      figma.ui.resize(tplW, tplH)
      persistWindow()
    } else if (msg.type === 'persist-window') {
      // Sent by the iframe on drag-end and on a gentle poll — the moment to
      // snapshot the current size + position to clientStorage.
      persistWindow()
    } else if (msg.type === 'resize' && typeof msg.height === 'number') {
      tplH = clampH(msg.height)
      figma.ui.resize(tplW, tplH)
    } else if (msg.type === 'close') {
      figma.closePlugin()
    }
  }
}

// ─── Pipeline stage actions (run-level) ───
// The run-state MANAGER (src/run) owns persistence and the cascade; these two
// actions gather the figma-side inputs the pure core can't reach and funnel the
// result through it. The per-component stages (3, 5–7) land in the next phase.

// Stage 1 — derive platform readiness from the stored setup fields instead of an
// explicit "validate" step. The platform view is a form, and the ONE required piece
// is a valid file key: it's what discovery scopes against, and it's all either
// publish path needs (Design mode writes via the plugin API; Dev mode routes the
// write through the backend over the transformer's OAuth connection — see
// publishViaBackend). The REST PLANT is no longer required — it's an optional
// convenience field now, checked (if present) only where a raw REST call wants it.
// This flips platform.ready to match, and only when the verdict changes:
// applyPlatform cascades (resetting all component progress, since every component
// stage assumes a current platform). Callers invoke this only when the file key
// actually changed — a new file to operate on is exactly when that reset is
// warranted.
function syncPlatformFromFields(): void {
  const fileKey = (figma.root.getPluginData(FILE_URL_KEY) || '').trim()
  applyPlatform(Boolean(fileKey))
}

// Stage 2 — resolve the canvas selection to the component sets to scope, as stable
// ComponentRefs. Each selected node is resolved to its component/component-set
// (variants and instances included); identity is the published component key when
// available, falling back to the node id for still-unpublished local components.
// De-duped by key.
async function resolveSelectionRefs(): Promise<ComponentRef[]> {
  const byKey = new Map<string, ComponentRef>()
  for (const node of figma.currentPage.selection) {
    const cs = await resolveToComponentSet(node)
    if (!cs) continue
    const key = cs.key || cs.id
    if (byKey.has(key)) continue
    byKey.set(key, { componentKey: key, nodeId: cs.id, name: cs.name })
  }
  return [...byKey.values()]
}

// Stage 2 (discovery) — every component set in the OPEN document, as stable
// ComponentRefs, so the Scope view can mount them proactively without a manual
// add. With documentAccess "dynamic-page" the pages must be loaded before
// findAllWithCriteria can traverse the whole root. A variant COMPONENT nested in a
// set is skipped — its set stands in for it. De-duped by key (published key, else
// node id), matching resolveSelectionRefs so selection and discovery agree.
async function discoverComponentSets(): Promise<ComponentRef[]> {
  try {
    await figma.loadAllPagesAsync()
  } catch {
    // Read-only / restricted context may reject — fall through to whatever the
    // already-loaded pages can offer.
  }
  const byKey = new Map<string, ComponentRef>()
  let nodes: readonly SceneNode[] = []
  try {
    nodes = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
  } catch {
    nodes = []
  }
  for (const n of nodes) {
    // Skip a variant component — the set it belongs to represents it.
    if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue
    const node = n as ComponentNode | ComponentSetNode
    const key = node.key || node.id
    if (byKey.has(key)) continue
    byKey.set(key, { componentKey: key, nodeId: node.id, name: node.name })
  }
  return [...byKey.values()]
}

// ─── Stage 3: contract ───
// The contract is the AI-tuned context a downstream transformer (stage 4)
// hands to an LLM to author a Code Connect template. So it encodes what Code
// Connect actually maps: the component set's identity plus its property surface
// (variants, booleans, text, instance-swaps) with defaults and variant options.
// Stored as versioned JSON in the per-component workspace (pluginData), off the
// Variables panel — it's a working artifact, not the published output.

const CONTRACT_SCHEMA = 'cc-processor/contract@2'

interface ContractProp {
  name: string // raw property key (Code Connect's figma prop name; may carry a #id suffix)
  label: string // the human-facing name (suffix stripped)
  type: string // VARIANT | BOOLEAN | TEXT | INSTANCE_SWAP
  defaultValue?: string | boolean
  options?: string[] // VARIANT: the allowed values
}

interface Contract {
  _schema: string
  identity: { name: string; nodeId: string; componentKey: string; fileKey: string }
  kind: 'COMPONENT' | 'COMPONENT_SET'
  description?: string
  properties: ContractProp[]
  // Tunable payload (contract@2, configured per run — see ContractConfig). Skills
  // the consuming agent should load, the task prompt handed to it, and the source
  // files it should reference when authoring a template. Present only when set.
  skills?: string[]
  prompt?: string
  sourcePaths?: string[]
}

// ─── Contract config: what a generated contract carries ───
// The contract used to be whatever `buildContract` derived. It's now tunable: a
// set of shipped defaults, a run-wide `defaults` override, and per-component
// `overrides` (keyed by componentKey) that win over both. Stored as a minimal
// deviations blob in root pluginData (like the validation config), shipped on
// every pipeline-state, and merged into an effective config at generate time.
interface ContractConfig {
  includeProperties: boolean // the property surface (variants/booleans/text/swaps)
  includeDefaults: boolean // each prop's defaultValue
  includeOptions: boolean // a VARIANT prop's allowed values
  includeDescription: boolean // the component set's description
  skills: string[]
  prompt: string
  sourcePaths: string[]
}

// The shipped baseline — mirrored UI-side in src/ui/pipeline (CONTRACT_DEFAULTS).
const CONTRACT_DEFAULTS: ContractConfig = {
  includeProperties: true,
  includeDefaults: true,
  includeOptions: true,
  includeDescription: true,
  skills: [],
  prompt: '',
  sourcePaths: [],
}

const CONTRACT_CONFIG_KEY = 'cc-processor:contract_config'

interface StoredContractConfig {
  defaults?: Partial<ContractConfig>
  overrides?: Record<string, Partial<ContractConfig>>
}

function readContractConfig(): string {
  try {
    return figma.root.getPluginData(CONTRACT_CONFIG_KEY) || '{}'
  } catch {
    return '{}'
  }
}

function parseContractConfig(): StoredContractConfig {
  try {
    const obj = JSON.parse(readContractConfig())
    return obj && typeof obj === 'object' ? (obj as StoredContractConfig) : {}
  } catch {
    return {}
  }
}

// The effective config for one component set: shipped defaults, then the run-wide
// defaults override, then this component's override — later layers win.
function effectiveContractConfig(componentKey: string): ContractConfig {
  const stored = parseContractConfig()
  const override = (stored.overrides || {})[componentKey] || {}
  return { ...CONTRACT_DEFAULTS, ...(stored.defaults || {}), ...override }
}

function buildContract(
  node: ComponentNode | ComponentSetNode,
  ref: ComponentRef,
  fileKey: string,
  cfg: ContractConfig,
): Contract {
  const properties: ContractProp[] = []
  // The property surface is opt-out: when the user turns it off (cfg.includeProperties
  // === false) the contract carries an empty array — identity + payload only.
  if (cfg.includeProperties) {
    const defs = node.componentPropertyDefinitions
    for (const key of Object.keys(defs)) {
      const d = defs[key]
      const prop: ContractProp = { name: key, label: key.split('#')[0], type: d.type }
      if (cfg.includeDefaults && d.defaultValue !== undefined) prop.defaultValue = d.defaultValue
      if (cfg.includeOptions && d.type === 'VARIANT' && Array.isArray(d.variantOptions)) prop.options = d.variantOptions.slice()
      properties.push(prop)
    }
    // Stable, readable order: variants first (they’re the primary mapping surface),
    // then the rest by type, alphabetically within each.
    const rank = (p: ContractProp): number => (p.type === 'VARIANT' ? 0 : 1)
    properties.sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
  }

  const contract: Contract = {
    _schema: CONTRACT_SCHEMA,
    identity: { name: node.name, nodeId: ref.nodeId, componentKey: node.key || ref.componentKey, fileKey },
    kind: node.type,
    properties,
  }
  if (cfg.includeDescription) {
    const description = (node.description || '').trim()
    if (description) contract.description = description
  }
  // The tunable payload — only carried when the user has actually set it.
  const skills = cfg.skills.map((s) => s.trim()).filter(Boolean)
  if (skills.length) contract.skills = skills
  const prompt = cfg.prompt.trim()
  if (prompt) contract.prompt = prompt
  const sourcePaths = cfg.sourcePaths.map((s) => s.trim()).filter(Boolean)
  if (sourcePaths.length) contract.sourcePaths = sourcePaths
  return contract
}

// Stage 3 action — generate one scoped set's contract from the live node and save
// it to the workspace, then stamp the stage (cascading downstream to pending).
// Assumes the platform is validated (the caller gates on it); still guards that
// the set is in scope and the node resolves to a component/set that exists.
async function generateContract(
  componentKey: string,
  onStart?: () => void,
): Promise<{ ok: boolean; message: string; contract?: string }> {
  const ref = readRunState().scope.find(r => r.componentKey === componentKey)
  if (!ref) return { ok: false, message: 'That component set isn’t in scope' }

  startComponentStage(componentKey, 'contract')
  // Stream the `active` state right away so the row reflects the in-flight run
  // before the (possibly slow) work below — the UI's optimism confirms against it.
  if (onStart) onStart()
  try {
    const node = await figma.getNodeByIdAsync(ref.nodeId)
    const cs = node ? await resolveToComponentSet(node as SceneNode) : null
    if (!cs) throw new Error('the component set couldn’t be found on the canvas — it may have been deleted')
    const fileKey = (figma.root.getPluginData(FILE_URL_KEY) || '').trim()
    const contract = buildContract(cs, ref, fileKey, effectiveContractConfig(componentKey))
    // Stored compact (the transformer/download re-parse it); a pretty copy is
    // returned for the clipboard so the auto-clip lands readable.
    writeWork(componentKey, { contract: JSON.stringify(contract) })
    finishComponentStage(componentKey, 'contract', 'done')
    // The transformer (stage 4) is optional and connection-gated. When connected
    // it stays actionable — the cascade above already reset it to pending, so the
    // user can run it. Not connected → it's skipped, which clears it and unblocks
    // the manual template stage; stage 5 is the merge point for both paths (PLAN
    // decision 2).
    if (!transformerAuth.connected) setComponentStageStatus(componentKey, 'transform', 'skipped')
    const n = contract.properties.length
    return {
      ok: true,
      message: 'Contract generated for ' + cs.name + ' (' + n + ' propert' + (n === 1 ? 'y' : 'ies') + ')',
      contract: JSON.stringify(contract, null, 2),
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    finishComponentStage(componentKey, 'contract', 'failed', message)
    return { ok: false, message: 'Contract failed: ' + message }
  }
}

// ─── Stage 4: transformer (optional, OAuth) ───
// The transformer is a configurable backend the plugin AUTHENTICATES to over OAuth
// (PKCE) — not a hardcoded endpoint (PLAN.md §5.1). Responsibilities split across
// the two threads:
//   • This (main) thread owns the SECRETS and orchestration: it redeems the auth
//     code for tokens, holds the refresh token in clientStorage, mints a
//     short-lived access token per run, and persists the produced draft.
//   • The iframe (src/ui/transformer) owns the network I/O that a sandboxed
//     main-thread can't do reliably: the PKCE + relay + poll dance, and streaming
//     the run response into the stage-5 editor.
// Absent a connection, stage 4 is `skipped` at contract time (generateContract),
// so a run is only ever granted when connected — stage 5 remains the merge point.

// A parsed OAuth token response. Fields beyond the standard trio are optional and
// used only to label the connected account in the UI.
interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  account?: unknown
  email?: unknown
  name?: unknown
  sub?: unknown
}

// A friendly account label from a token/exchange response, best-effort.
function accountLabel(t: TokenResponse): string {
  for (const v of [t.account, t.email, t.name, t.sub]) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

// A transformer request denied by the sandbox surfaces as a network error (never
// an HTTP status), because the origin isn't in manifest allowedDomains. Detect it
// so the UI can show the "add this origin to the manifest" fix instead of a raw
// failure. figma's fetch rejects such calls with a message mentioning the domain.
function isNetworkDeny(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return m.includes('not in the network access allowlist') || m.includes('alloweddomains') || m.includes('is not allowed')
}

// POST the token endpoint (form-encoded, OAuth standard). Used for both the
// initial code→tokens exchange and refreshes. Throws on non-2xx or transport
// error; the caller maps that to a user-facing signal.
async function postToken(profile: BackendProfile, form: Record<string, string>): Promise<TokenResponse> {
  const body = Object.keys(form)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
    .join('&')
  const res = await fetch(backendUrl(profile, profile.connector.oauth.token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  if (!res.ok) {
    throw new Error(
      res.status === 400 || res.status === 401
        ? 'the transformer rejected the sign-in (' + res.status + ')'
        : 'the transformer returned ' + res.status + ' during sign-in',
    )
  }
  const text = await res.text()
  try {
    return JSON.parse(text) as TokenResponse
  } catch {
    throw new Error('the transformer’s token response wasn’t valid JSON')
  }
}

// The cached dynamic-registration result: the public client id the backend minted,
// tagged with the baseUrl it was minted for. Kept in clientStorage (per-user, not
// a secret) so we register once per backend rather than on every connect.
interface ClientRecord {
  baseUrl: string
  clientId: string
}

// Resolve the public client_id for a profile's backend, registering once if needed.
// The contract's POST /api/oauth/register takes {client_name, redirect_uris} and
// returns {client_id} for a public client (token_endpoint_auth_method: "none").
// We cache it keyed by baseUrl and re-register only when the target backend changes.
async function ensureClientId(profile: BackendProfile): Promise<string> {
  const cached = (await figma.clientStorage.getAsync(TRANSFORMER_CLIENT_KEY)) as ClientRecord | undefined
  if (cached && cached.baseUrl === profile.connector.baseUrl && cached.clientId) return cached.clientId
  const redirectUri = backendUrl(profile, profile.connector.oauth.relayCallback)
  const res = await fetch(backendUrl(profile, profile.connector.oauth.register), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'cc-processor plugin', redirect_uris: [redirectUri] }),
  })
  if (!res.ok) throw new Error('the transformer refused registration (' + res.status + ')')
  const reg = JSON.parse(await res.text()) as { client_id?: unknown }
  const clientId = typeof reg.client_id === 'string' ? reg.client_id : ''
  if (!clientId) throw new Error('the transformer didn’t return a client id')
  await figma.clientStorage.setAsync(TRANSFORMER_CLIENT_KEY, { baseUrl: profile.connector.baseUrl, clientId })
  return clientId
}

// Redeem the authorization code the iframe polled from the relay. Stores the
// refresh token (per-user, clientStorage) and caches the access token in memory.
// redirectUri MUST equal the one the relay used at /authorize (PKCE binds them).
async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ ok: boolean; account?: string; message?: string; denied?: boolean }> {
  const profile = readTransformerProfile()
  try {
    // No client_id in the body: this is a PUBLIC client, and PKCE (code_verifier)
    // is the proof-of-possession the token endpoint checks. Per the contract, the
    // token endpoint takes NO client_id — it's supplied only at /authorize (via the
    // relay /start) and bound to the code.
    const t = await postToken(profile, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    })
    const refresh = typeof t.refresh_token === 'string' ? t.refresh_token : ''
    const access = typeof t.access_token === 'string' ? t.access_token : ''
    if (!access) throw new Error('the transformer didn’t return an access token')
    const account = accountLabel(t)
    // Refresh + account label are per-user; NEVER document pluginData.
    if (refresh) await figma.clientStorage.setAsync(TRANSFORMER_REFRESH_KEY, refresh)
    await figma.clientStorage.setAsync(TRANSFORMER_ACCOUNT_KEY, account)
    const ttl = typeof t.expires_in === 'number' ? t.expires_in : 3600
    accessCache = { token: access, expiresAt: Date.now() + ttl * 1000 }
    transformerAuth = { connected: Boolean(refresh) || Boolean(access), account }
    return { ok: true, account }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), denied: isNetworkDeny(e) }
  }
}

// Return a valid access token, refreshing from the stored refresh token when the
// cached one is missing or within 60s of expiry. Throws if we can't produce one
// (no refresh token / refresh rejected) so the run surfaces a reconnect prompt.
async function ensureAccessToken(): Promise<string> {
  if (accessCache && accessCache.expiresAt - Date.now() > 60_000) return accessCache.token
  const profile = readTransformerProfile()
  const refresh = (await figma.clientStorage.getAsync(TRANSFORMER_REFRESH_KEY)) as string | undefined
  if (!refresh) throw new Error('not connected to a transformer')
  // As with the code exchange: public client, no client_id in the body.
  const t = await postToken(profile, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
  })
  const access = typeof t.access_token === 'string' ? t.access_token : ''
  if (!access) throw new Error('the transformer didn’t return an access token on refresh')
  // Providers may rotate the refresh token; persist the new one if present.
  if (typeof t.refresh_token === 'string' && t.refresh_token) {
    await figma.clientStorage.setAsync(TRANSFORMER_REFRESH_KEY, t.refresh_token)
  }
  const ttl = typeof t.expires_in === 'number' ? t.expires_in : 3600
  accessCache = { token: access, expiresAt: Date.now() + ttl * 1000 }
  return access
}

// Forget the connection (Disconnect, or an unrecoverable refresh failure).
async function clearTransformerAuth(): Promise<void> {
  accessCache = null
  transformerAuth = { connected: false, account: '' }
  try {
    await figma.clientStorage.deleteAsync(TRANSFORMER_REFRESH_KEY)
    await figma.clientStorage.deleteAsync(TRANSFORMER_ACCOUNT_KEY)
  } catch {
    // Non-fatal — the in-memory state above is what gates runs this session.
  }
}

// Read the `{error}`/`{message}` field from a backend JSON response, best-effort.
async function backendMessage(res: Response, key: 'error' | 'message'): Promise<string> {
  try {
    const data = JSON.parse(await res.text()) as Record<string, unknown>
    const v = data[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch {
    // Non-JSON body — fall through to the status-derived message.
  }
  return ''
}

// Read a publish error body — `{ error, recoveryHint? }` — in ONE pass (a Response
// body can only be read once, so we can't call backendMessage twice). The publish
// contract carries a recoveryHint on the common 403 (Enterprise plan / full seat /
// file_variables:write scope) that we surface verbatim, since it's a Figma-side gate.
async function backendError(res: Response): Promise<{ error: string; hint: string }> {
  try {
    const data = JSON.parse(await res.text()) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error.trim() : ''
    const hint = typeof data.recoveryHint === 'string' ? data.recoveryHint.trim() : ''
    return { error, hint }
  } catch {
    return { error: '', hint: '' }
  }
}

// A fallback message for a publish HTTP status when the backend sent no {error}.
// Mirrors the publish contract's status table.
function statusGloss(status: number): string {
  if (status === 400) return 'the backend rejected the publish request (400) — the file or variables were invalid'
  if (status === 401) return 'the backend rejected the sign-in (401) — reconnect in step 1'
  if (status === 403) return 'Figma refused the write (403) — needs an Enterprise plan, a full seat, and the file_variables:write scope'
  if (status === 404) return 'the backend has no publish endpoint at that path (404) — check the Publish path in Advanced'
  if (status === 413) return 'the publish payload exceeded Figma’s 4MB limit (413)'
  if (status >= 500) return 'the backend or Figma failed while publishing (' + status + ')'
  return 'the backend returned ' + status + ' while publishing'
}

// Build the declarative publish spec for one template, choosing CREATE vs UPDATE by
// inspecting the file's CURRENT variables. The publish contract has NO find-or-create:
// CREATE always makes a new collection; UPDATE targets an existing one by real id. So
// we do the find-or-create HERE — reads are allowed in Dev Mode (only writes are
// gated), which lets us resolve an existing `.code-connect` collection's id + modeId
// (and the target variable's id) locally, no backend read round-trip. The contract's
// one hard rule: `values` key by mode NAME on CREATE (real mode ids don't exist yet)
// and by real modeId on UPDATE. Mirrors TemplateStore: a STRING variable named
// `<component>/<label>` in the flat single-mode `.code-connect` collection.
async function buildPublishSpec(
  fileKey: string,
  ref: { component: string; label: string; file: string },
): Promise<Record<string, unknown>> {
  const varName = buildVarName({ component: ref.component, label: ref.label })
  let collectionId = ''
  let modeId = ''
  let existingVarId = ''
  try {
    const cols = await figma.variables.getLocalVariableCollectionsAsync()
    const col = cols.find(c => c.name === LIBRARY_NAME)
    if (col) {
      collectionId = col.id
      modeId = col.modes[0] ? col.modes[0].modeId : ''
      const vars = await figma.variables.getLocalVariablesAsync('STRING')
      const v = vars.find(x => x.variableCollectionId === col.id && x.name === varName)
      if (v) existingVarId = v.id
    }
  } catch {
    // Reads unavailable — fall through to a self-contained CREATE.
  }

  if (collectionId && modeId) {
    // Existing collection → UPDATE it; key the value by the real modeId. The variable
    // itself is UPDATE-by-id when it already exists, else a plain CREATE in that set.
    const variable: Record<string, unknown> = existingVarId
      ? { name: varName, type: 'STRING', action: 'UPDATE', id: existingVarId, values: { [modeId]: ref.file } }
      : { name: varName, type: 'STRING', values: { [modeId]: ref.file } }
    return { file_key: fileKey, collection: { action: 'UPDATE', id: collectionId }, variables: [variable] }
  }
  // No collection yet — CREATE it with Figma's default single mode ("Mode 1"); the
  // Design-mode store later adopts it by name (see TemplateStore.ensure).
  return {
    file_key: fileKey,
    collection: { action: 'CREATE', name: LIBRARY_NAME },
    variables: [{ name: varName, type: 'STRING', values: { 'Mode 1': ref.file } }],
  }
}

// Publish one template file via the BACKEND, reusing the transformer's OAuth
// connection. This is the Dev Mode publish path: the Variables PLUGIN API is
// read-only there (setValueForMode throws), and a Plan Access Token can't reach the
// file_variables:write endpoint at all — so instead of writing Figma directly, we
// hand the file to the backend (which holds the Figma App OAuth grant) and let IT
// do the Variables REST write on the authenticated user's behalf. Same bearer token
// a transform run uses; no Figma OAuth secret ever lives in this plugin. A single
// request/response (no stream, no PKCE), so it runs entirely main-side.
async function publishViaBackend(
  ref: { component: string; label: string; file: string },
): Promise<{ ok: boolean; message: string; denied?: boolean }> {
  if (!transformerAuth.connected) {
    return { ok: false, message: 'Connect in step 1 to publish from Dev Mode' }
  }
  const fileKey = extractFileKey(figma.root.getPluginData(FILE_URL_KEY) || '')
  if (!fileKey) return { ok: false, message: 'Add a valid file key in step 1 to publish from Dev Mode' }
  const profile = readTransformerProfile()
  let token: string
  try {
    token = await ensureAccessToken()
  } catch (e) {
    // A refresh failure means the connection is effectively dead — drop it so the UI
    // shows "Reconnect" rather than a stale "Connected".
    await clearTransformerAuth()
    return { ok: false, message: 'Sign-in expired — reconnect in step 1', denied: isNetworkDeny(e) }
  }
  let spec: Record<string, unknown>
  try {
    spec = await buildPublishSpec(fileKey, ref)
  } catch (e) {
    // buildVarName rejects an empty component/label — a draft-header problem, not a
    // network one, so report it plainly rather than as a publish failure.
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  try {
    const res = await fetch(backendUrl(profile, profile.features.publish.path), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(spec),
    })
    if (!res.ok) {
      const { error, hint } = await backendError(res)
      // Prefer the backend's own message; append its recoveryHint (the 403 plan/scope
      // gate carries one). Fall back to a status gloss keyed to the publish contract.
      const detail =
        (error ? error : statusGloss(res.status)) + (hint ? ' — ' + hint : '')
      return { ok: false, message: detail }
    }
    const note = await backendMessage(res, 'message')
    return { ok: true, message: note || 'Published ' + ref.component + '/' + ref.label + ' via the backend' }
  } catch (e) {
    const denied = isNetworkDeny(e)
    return {
      ok: false,
      message: denied
        ? 'the transformer origin isn’t in the manifest allowlist'
        : 'couldn’t reach the backend to publish — ' + (e instanceof Error ? e.message : String(e)),
      denied,
    }
  }
}

// The grant the iframe needs to stream one run: where to POST, a fresh bearer
// token, which transformer, how it replies, and the contract to transform. Marks
// the row active. Returns an error grant (ok:false) the handler relays as a toast.
interface TransformGrant {
  componentKey: string
  url: string
  token: string
  slug: string
  response: 'stream' | 'json'
  contract: unknown
}
async function beginTransformRun(
  componentKey: string,
  onStart?: () => void,
): Promise<{ ok: true; grant: TransformGrant } | { ok: false; message: string; denied?: boolean }> {
  const ref = readRunState().scope.find((r) => r.componentKey === componentKey)
  if (!ref) return { ok: false, message: 'That component set isn’t in scope' }
  if (!transformerAuth.connected) {
    return { ok: false, message: 'Connect a transformer in step 1, or paste a template in step 5' }
  }
  const contract = readWork(componentKey).contract
  if (!contract) return { ok: false, message: 'Generate the contract (step 3) first' }
  const profile = readTransformerProfile()
  let token: string
  try {
    token = await ensureAccessToken()
  } catch (e) {
    // A refresh failure means the connection is effectively dead — drop it so the
    // UI shows "Reconnect" rather than a stale "Connected".
    await clearTransformerAuth()
    return { ok: false, message: 'Sign-in expired — reconnect the transformer in step 1', denied: isNetworkDeny(e) }
  }
  startComponentStage(componentKey, 'transform')
  if (onStart) onStart()
  return {
    ok: true,
    grant: {
      componentKey,
      url: backendUrl(profile, profile.features.run.path),
      token,
      slug: profile.features.run.slug,
      response: profile.features.run.response,
      contract: JSON.parse(contract),
    },
  }
}

// Persist the iframe's run result. On success the produced file lands as the
// stage-5 draft (the merge point) and the transform + template stages are stamped
// done — the same end state as a manual save, minus the paste. On failure the row
// carries the error; the UI also surfaces a manifest-fix hint for a network deny.
function applyTransformResult(
  componentKey: string,
  ok: boolean,
  file: string,
  error?: string,
): { ok: boolean; message: string } {
  const ref = readRunState().scope.find((r) => r.componentKey === componentKey)
  const name = ref ? ref.name : 'component'
  if (ok) {
    const f = (file || '').trim()
    if (!f) {
      finishComponentStage(componentKey, 'transform', 'failed', 'the transformer response had no template file')
      return { ok: false, message: 'Transform failed: empty template' }
    }
    writeWork(componentKey, { draft: f })
    finishComponentStage(componentKey, 'transform', 'done')
    setComponentStageStatus(componentKey, 'template', 'done')
    return { ok: true, message: 'Transformed ' + name + ' — template drafted' }
  }
  const message = error || 'the transformer run failed'
  finishComponentStage(componentKey, 'transform', 'failed', message)
  return { ok: false, message: 'Transform failed: ' + message }
}

// ─── Stage 5: template draft ───
// Stage 5 is the merge point for the automated (transformer) and manual (paste)
// paths (PLAN decision 2). Here it's the manual on-ramp: the pasted template file
// is captured as the component's DRAFT in the workspace (pluginData), NOT yet the
// published output — that's stage 7. Saving stamps the template stage done, which
// cascades any prior validate/publish result to pending.
function saveDraft(componentKey: string, text: string): { ok: boolean; message: string } {
  const ref = readRunState().scope.find(r => r.componentKey === componentKey)
  if (!ref) return { ok: false, message: 'That component set isn’t in scope' }
  const t = (text || '').trim()
  if (!t) return { ok: false, message: 'Paste a template file first' }
  writeWork(componentKey, { draft: t })
  finishComponentStage(componentKey, 'template', 'done')
  return { ok: true, message: 'Draft saved for ' + ref.name }
}

// ─── Stage 6: validate & repair ───
// Runs the draft through the EXACT validator the template editor uses: the full
// src/engine — every structural/lint rule plus the figma.* semantic rules
// (runSemanticChecks), all folded through the user's severity config so a rule
// tuned to 'error' blocks and one tuned to 'comment' doesn't. Sharing the engine
// is what keeps the stage's verdict identical to the signals shown live in the
// editor; the previous parseTemplateFile path only checked a handful of rules, so
// the stage passed drafts the editor was already flagging as errors. Findings are
// saved to the workspace; the stage stamps done (clean) or failed (with a
// one-line summary Main can surface).
async function validateDraft(
  componentKey: string,
  onStart?: () => void,
): Promise<{ ok: boolean; message: string }> {
  const ref = readRunState().scope.find(r => r.componentKey === componentKey)
  if (!ref) return { ok: false, message: 'That component set isn’t in scope' }
  const draft = readWork(componentKey).draft
  if (!draft) return { ok: false, message: 'No template draft to validate — save one first' }

  startComponentStage(componentKey, 'validate')
  if (onStart) onStart()
  const cfg = parseEngineConfig(readValidationConfig())
  // Structural + lint pass (pure), then fold in the figma.* semantic findings —
  // the same base → mergeSemantic round-trip the live editor performs.
  const base = engineValidate(draft, cfg)
  const findings = (await runSemanticChecks(base.nodeId)) as EngineSemanticFinding[]
  const result = engineMergeSemantic(base, findings, cfg)

  const errors = result.issues.filter(i => i.level === 'error').map(i => i.message)
  const warnings = result.issues.filter(i => i.level === 'comment').map(i => i.message)
  writeWork(componentKey, { findings: JSON.stringify({ errors, warnings }) })

  if (!result.summary.pass) {
    const summary = errors.join(' · ')
    finishComponentStage(componentKey, 'validate', 'failed', summary)
    return { ok: false, message: 'Validation failed: ' + summary }
  }
  finishComponentStage(componentKey, 'validate', 'done')
  const warn = warnings.length ? ' (' + warnings.length + ' comment' + (warnings.length === 1 ? '' : 's') + ')' : ''
  return { ok: true, message: 'Validation passed for ' + ref.name + warn }
}

// Resolve a draft to its published address (`<component>/<label>`) — the same
// resolution the template editor's save uses: component from the `// component=`
// header, else the id, else the name of the node the `// url=` resolves to; label
// from the `// label=` header. Identity itself lives inside the file.
async function resolveDraftTarget(text: string): Promise<{ component: string; label: string; language: string } | { error: string }> {
  const { parsed, errors } = parseTemplateFile(text)
  if (errors.length > 0) return { error: errors[0] }
  let component = (parsed.component || parsed.id || '').trim()
  if (!component) {
    const nodeId = nodeIdFromUrl(parsed.url)
    if (nodeId) {
      try {
        const n = await figma.getNodeByIdAsync(nodeId)
        const cs = n ? await resolveToComponentSet(n as SceneNode) : null
        if (cs) component = cs.name
      } catch {
        // node lookup failed — fall through to the missing-component message
      }
    }
  }
  if (!component) return { error: 'Add a “// component=” header (or a resolvable “// url=”) so the file can be named' }
  const label = (parsed.label || '').trim()
  if (!label) return { error: 'Add a “// label=” header (e.g. web, ios) — it names the template' }
  if (label.indexOf('/') !== -1) return { error: 'A label can’t contain “/”' }
  // Language is an optional convention header (see ext.languageHint): it names the
  // snippet's language for the downloaded package's config. Absent → the packager
  // falls back to a default.
  const language = (parsed.language || '').trim()
  return { component, label, language }
}

// ─── Stage 7: publish ───
// Promote a validated draft into the published output: one atomic write into the
// flat library collection as `<component>/<label>` via TemplateStore (see
// src/variables). This is the ONLY stage that touches the Variables API.
async function publishDraft(
  componentKey: string,
  onStart?: () => void,
): Promise<{ ok: boolean; message: string }> {
  const ref = readRunState().scope.find(r => r.componentKey === componentKey)
  if (!ref) return { ok: false, message: 'That component set isn’t in scope' }
  const draft = readWork(componentKey).draft
  if (!draft) return { ok: false, message: 'No template to publish' }

  startComponentStage(componentKey, 'publish')
  if (onStart) onStart()
  try {
    const target = await resolveDraftTarget(draft)
    if ('error' in target) throw new Error(target.error)

    // Dev Mode makes the Variables PLUGIN API read-only, so setValueForMode throws
    // ("Can't call setValueForMode in read-only mode"). Everything upstream is
    // pluginData, which Dev Mode still allows — only this final publish write needs
    // another path. A Plan Access Token can't reach the file_variables:write endpoint
    // at all, so we don't call Figma directly: we route the write through the BACKEND
    // over the transformer's OAuth connection (it holds the Figma App grant and does
    // the Variables write on the authenticated user's behalf — see publishViaBackend).
    if (figma.editorType === 'dev') {
      const r = await publishViaBackend({ component: target.component, label: target.label, file: draft })
      if (!r.ok) throw new Error(r.message)
      finishComponentStage(componentKey, 'publish', 'done')
      return { ok: true, message: r.message }
    }

    const store = await TemplateStore.ensure(LIBRARY_NAME)
    const rec = await store.write({ component: target.component, label: target.label, file: draft })
    finishComponentStage(componentKey, 'publish', 'done')
    return { ok: true, message: 'Published ' + rec.component + '/' + rec.label }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    finishComponentStage(componentKey, 'publish', 'failed', message)
    return { ok: false, message: 'Publish failed: ' + message }
  }
}

// ─── Dev Mode fallback: download a Code Connect package ───
// Progressive capability / elegant degradation: publishing into Figma Variables
// needs either the Design-mode plugin API or (in Dev Mode) a backend over OAuth. When
// neither is available, the plugin still helps — it hands the user a folder of their
// Code Connect artifacts to publish from the CLI (`figma connect publish`) instead of
// leaving Dev Mode with no publish path at all.
//
// The main thread gathers the artifacts (drafts + contracts live in workspace
// pluginData); the iframe builds the ZIP and triggers the browser download, since only
// the iframe can reach the DOM/filesystem (see src/ui/download.ts). The SOURCE is each
// scoped set's validated DRAFT — not the published Variables — because this is exactly
// the path taken when Variables can't be written.
interface PackageComponent {
  component: string
  label: string
  language: string
  template: string
  contract: unknown | null
}
async function gatherDownloadPackage(): Promise<
  | { ok: true; fileKey: string; library: string; generatedAt: string; components: PackageComponent[] }
  | { ok: false; message: string }
> {
  const scope = readRunState().scope
  if (scope.length === 0) return { ok: false, message: 'Scope some component sets (step 2) first' }
  const fileKey = extractFileKey(figma.root.getPluginData(FILE_URL_KEY) || '') || ''
  const components: PackageComponent[] = []
  for (const ref of scope) {
    const work = readWork(ref.componentKey)
    const draft = (work.draft || '').trim()
    if (!draft) continue // nothing authored yet for this set — leave it out
    // Resolve the draft's published address for naming; fall back to the set name
    // (and no label) if the headers can't be parsed — a best-effort package still helps.
    const target = await resolveDraftTarget(draft)
    const component = 'error' in target ? ref.name : target.component
    const label = 'error' in target ? '' : target.label
    const language = 'error' in target ? '' : target.language
    let contract: unknown | null = null
    if (work.contract) {
      try {
        contract = JSON.parse(work.contract)
      } catch {
        contract = null
      }
    }
    components.push({ component, label, language, template: draft, contract })
  }
  if (components.length === 0) {
    return { ok: false, message: 'No template drafts to package yet — author or generate a template first' }
  }
  return { ok: true, fileKey, library: LIBRARY_NAME, generatedAt: new Date().toISOString(), components }
}

// The process shell — the two-pane pipeline view. Renders the Nav (inside the
// Aside) as a live projection of the persisted run state, and drives the wired
// stage actions from the Main pane. Every action re-streams fresh state
// so the Nav rollup and the cascade are visible immediately.
async function handleProcess(): Promise<void> {
  // The pipeline shell is drag-resizable from the iframe edges/corner (see the
  // resize controller in ui.html). We keep the last user-chosen size/position so
  // it reopens exactly where they left it and no reflow fights their dimensions.
  // The shell CSS is fluid (clamp-based frame spacing), so it flows gracefully at
  // narrow widths rather than clipping — the floor here just backstops a usable
  // minimum and matches the template window's 360 floor.
  const clampW = (w: number): number => Math.max(360, Math.min(1600, Math.round(w)))
  const clampH = (h: number): number => Math.max(360, Math.min(1000, Math.round(h)))

  // Remembered per-user via clientStorage. Its own key so it never collides with
  // the standalone template window's geometry ('cc:templateWindow').
  const WINDOW_STATE_KEY = 'cc:processWindow'
  let saved: { w?: number; h?: number; x?: number; y?: number } = {}
  try { saved = (await figma.clientStorage.getAsync(WINDOW_STATE_KEY)) || {} } catch { saved = {} }

  let winW = clampW(saved.w ?? 760)
  let winH = clampH(saved.h ?? 480)

  const showOpts: ShowUIOptions = { width: winW, height: winH }
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    showOpts.position = { x: Math.round(saved.x), y: Math.round(saved.y) }
  }
  figma.showUI(__html__, showOpts)

  // Persist current geometry. Figma fires no "window moved" event, so we sample
  // getPosition() (reflects title-bar drags too) on drag-end and a gentle poll.
  // A string guard skips redundant writes when nothing actually changed.
  let lastPersisted = ''
  const persistWindow = (): void => {
    let x: number | undefined
    let y: number | undefined
    try {
      const p = figma.ui.getPosition()
      x = Math.round(p.windowSpace.x)
      y = Math.round(p.windowSpace.y)
    } catch {
      // No UI / position unavailable — persist size only.
    }
    const state = { w: winW, h: winH, x, y }
    const sig = JSON.stringify(state)
    if (sig === lastPersisted) return
    lastPersisted = sig
    figma.clientStorage.setAsync(WINDOW_STATE_KEY, state).catch(() => {})
  }

  // The Scope view's mounted component sets — discovered from the open document
  // (once the platform's ready) and augmented by the canvas selection. Kept in
  // memory for the session and shipped whole on every state; the persisted run
  // scope (state.scope) is the subset actually included in the run. `lastSelection`
  // is the canvas selection's keys, which the view uses to focus the matching row.
  const mounted = new Map<string, ComponentRef>()
  let lastSelection: string[] = []
  const mergeMounted = (refs: ComponentRef[]): void => {
    for (const r of refs) mounted.set(r.componentKey, r)
  }

  const sendState = () => {
    // A scoped set must always appear in the view even if discovery hasn't mounted
    // it (e.g. it now lives behind a context discovery can't reach) — fold scope in.
    for (const r of readRunState().scope) if (!mounted.has(r.componentKey)) mounted.set(r.componentKey, r)
    // Ship the user's severity config alongside the run state so the stage-5
    // editor's live signals (window.CCValidation) resolve rules against the same
    // config the headless validate/publish stages use.
    figma.ui.postMessage({
      type: 'pipeline-state',
      state: serializeRunState(readRunState()),
      config: readValidationConfig(),
      // The stage-3 contract settings (defaults + per-component overrides) — read
      // back into the settings overlay and merged at generate time.
      contractConfig: readContractConfig(),
      // The stage-1 Environment view renders these; secrets are booleans only.
      env: readEnvConfig(),
      // The stage-2 Scope view renders these; selection drives the focused row.
      mounted: [...mounted.values()],
      selection: lastSelection,
    })
  }

  // Populate the Scope view proactively: mount the document's sets (once ready) plus
  // whatever's already selected, then re-stream. Idempotent — merges, never drops —
  // so it's safe to call on boot and whenever readiness could have flipped.
  const refreshMounted = async (): Promise<void> => {
    if (readRunState().platform.ready) mergeMounted(await discoverComponentSets())
    const sel = await resolveSelectionRefs()
    mergeMounted(sel)
    lastSelection = sel.map((r) => r.componentKey)
    sendState()
  }
  // Readiness is now derived from the stored setup fields, so reconcile the
  // persisted verdict against them once at boot: a session saved under the old
  // explicit-validate model, or a field cleared out-of-band, can leave the two out
  // of step. Guarded so it only cascades when readiness actually flips — an
  // ordinary reopen (fields unchanged) must never wipe component progress.
  const bootReady = Boolean((figma.root.getPluginData(FILE_URL_KEY) || '').trim())
  if (bootReady !== readRunState().platform.ready) applyPlatform(bootReady)
  sendState()
  // Paint first (above), then discover + mount asynchronously so the shell opens
  // instantly and the Scope view fills in a beat later.
  void refreshMounted()
  // Hydrate the transformer connection from clientStorage (async), then re-stream
  // so the Environment view reflects a connection made in a prior session.
  void hydrateTransformerAuth().then(sendState)

  // Canvas → plugin: a selection change mounts any newly-selected sets and focuses
  // them in the Scope view. Selection resolution reads the current page only (no
  // page load), so it's cheap and ungated — a set selected before the platform's
  // ready still mounts; it just stays hidden until the Scope view unlocks.
  const syncSelection = async (): Promise<void> => {
    const refs = await resolveSelectionRefs()
    mergeMounted(refs)
    lastSelection = refs.map((r) => r.componentKey)
    sendState()
  }
  figma.on('selectionchange', () => {
    void syncSelection()
  })

  const requirePlatform = (): boolean => {
    if (readRunState().platform.ready) return true
    figma.notify('Add a file key in step 1 first', { timeout: 3000, error: true })
    return false
  }
  // A per-component stage only runs once its upstream stage is cleared (the linear
  // dependency). `blocked` is the derived "upstream not met" status.
  const requireUnblocked = (componentKey: string, stage: StageId): boolean => {
    if (effectiveComponentStatus(readRunState(), componentKey, stage) !== 'blocked') return true
    figma.notify('Finish the previous step for this component first', { timeout: 3000, error: true })
    return false
  }

  figma.ui.onmessage = async (msg: {
    type: string
    width?: number
    height?: number
    componentKey?: string
    text?: string
    nodeId?: string
    reqId?: number
    config?: string
    message?: string
    error?: boolean
    field?: string
    value?: string
    // Transformer OAuth + run round-trip:
    url?: string
    code?: string
    codeVerifier?: string
    redirectUri?: string
    profile?: unknown
    ok?: boolean
    file?: string
  }) => {
    if (msg.type === 'pipeline-ready') {
      sendState()
    } else if (msg.type === 'save-field' && typeof msg.field === 'string') {
      // A stage-1 Environment field saved itself. Store the value (never echoed
      // back) and re-stream so the field reflects its saved state.
      const key = ENV_STORAGE_KEY[msg.field]
      const value = (msg.value || '').trim()
      if (key && value) {
        figma.root.setPluginData(key, value)
        // The file key is the one field that gates the whole pipeline, so a change to
        // it re-derives platform readiness before we re-stream. (The REST PLANT is
        // optional now and doesn't affect readiness — see syncPlatformFromFields.)
        if (msg.field === 'file') {
          syncPlatformFromFields()
          // Readiness may have just flipped on — (re)discover the document's sets so
          // the Scope view populates without any manual step.
          void refreshMounted()
        }
        sendState()
        figma.notify((ENV_FIELD_LABEL[msg.field] || 'Field') + ' saved', { timeout: 2000 })
      }
    } else if (msg.type === 'clear-field' && typeof msg.field === 'string') {
      const key = ENV_STORAGE_KEY[msg.field]
      if (key) {
        figma.root.setPluginData(key, '')
        // Only the file key gates readiness now; clearing it can flip readiness off,
        // so re-derive and re-stream so the Scope view re-gates. (Mounted sets stay
        // in memory; the view hides them.)
        if (msg.field === 'file') syncPlatformFromFields()
        sendState()
        figma.notify((ENV_FIELD_LABEL[msg.field] || 'Field') + ' removed', { timeout: 2000 })
      }
    } else if (msg.type === 'validate-semantic' && typeof msg.nodeId === 'string') {
      // The stage-5 editor's live signals ask for the figma.* checks the iframe
      // engine can't run (does the URL's node exist, is it a component, is it
      // published). Same round-trip the standalone template editor uses; the reply
      // carries the reqId so the UI can drop stale responses.
      const findings = await runSemanticChecks(msg.nodeId)
      figma.ui.postMessage({ type: 'semantic-result', reqId: msg.reqId, findings })
    } else if (msg.type === 'set-validation-config' && typeof msg.config === 'string') {
      // The stage-5 settings overlay persists the user's per-rule severity choices
      // (minimal deviations JSON). Live signals in the iframe already updated their
      // own in-memory copy, so a write is all that's needed here; the same config is
      // read back into every future pipeline-state (and the headless stages).
      try {
        figma.root.setPluginData(VALIDATION_CONFIG_KEY, msg.config)
      } catch {
        // pluginData write can fail on a read-only / branch context — non-fatal.
      }
    } else if (msg.type === 'notify' && typeof msg.message === 'string') {
      // UI-side outcomes (e.g. the copy-for-agent action) surfaced as a Figma toast.
      figma.notify(msg.message, { timeout: 3000, error: !!msg.error })
    } else if (msg.type === 'run-generate-contract' && typeof msg.componentKey === 'string') {
      if (!requirePlatform()) return
      const { message, ok, contract } = await generateContract(msg.componentKey, sendState)
      sendState()
      // Hand the fresh contract back so the UI can auto-copy it to the clipboard.
      if (ok && contract) figma.ui.postMessage({ type: 'contract-generated', componentKey: msg.componentKey, contract })
      figma.notify(message, { timeout: 3000 })
    } else if (msg.type === 'set-contract-config' && typeof msg.config === 'string') {
      // The stage-3 contract settings overlay persists its config (defaults +
      // per-component overrides) as a minimal deviations blob. Read back into every
      // future pipeline-state and merged at generate time (effectiveContractConfig).
      try {
        figma.root.setPluginData(CONTRACT_CONFIG_KEY, msg.config)
      } catch {
        // pluginData write can fail on a read-only / branch context — non-fatal.
      }
    } else if (msg.type === 'run-get-contract' && typeof msg.componentKey === 'string') {
      // Lazy fetch for the manual per-row copy: contracts live in workspace
      // pluginData (off run-state), so the UI pulls one on demand. Return it
      // pretty-printed so a copy lands readable; empty if none generated yet.
      const stored = readWork(msg.componentKey).contract || ''
      let contract = ''
      if (stored) {
        try {
          contract = JSON.stringify(JSON.parse(stored), null, 2)
        } catch {
          contract = stored
        }
      }
      figma.ui.postMessage({ type: 'contract-content', componentKey: msg.componentKey, contract })
    } else if (msg.type === 'transformer-connect-begin') {
      // Step 0 of connect: resolve the backend's public client_id (registering
      // once, main-side) and hand it back so the iframe can run the PKCE + relay
      // dance. Only /start (in the iframe) needs the client_id — the token
      // exchange (main-side) is a public client and sends none.
      const profile = readTransformerProfile()
      if (!profile.connector.baseUrl) {
        figma.ui.postMessage({
          type: 'transformer-error',
          phase: 'connect',
          message: 'set a transformer URL in Advanced first',
        })
        return
      }
      try {
        const clientId = await ensureClientId(profile)
        figma.ui.postMessage({ type: 'transformer-connect-config', clientId })
      } catch (e) {
        const denied = isNetworkDeny(e)
        const message = e instanceof Error ? e.message : String(e)
        figma.ui.postMessage({ type: 'transformer-error', phase: 'connect', message, denied })
        figma.notify(
          denied ? 'Transformer origin isn’t allowed — update the manifest allowlist' : 'Connect failed: ' + message,
          { timeout: 5000, error: true },
        )
      }
    } else if (msg.type === 'transformer-open' && typeof msg.url === 'string') {
      // Open the OAuth consent page in the user's real browser. The iframe can't
      // reliably window.open from its sandbox, so it hands us the URL.
      try {
        figma.openExternal(msg.url)
      } catch {
        figma.notify('Couldn’t open the sign-in page', { timeout: 3000, error: true })
      }
    } else if (msg.type === 'transformer-exchange' && typeof msg.code === 'string' && typeof msg.codeVerifier === 'string') {
      // The iframe finished the PKCE + relay + poll dance and handed us the auth
      // code. Redeem it for tokens (main-side, so the refresh token never touches
      // the DOM), then re-stream so the Environment view flips to "Connected".
      const redirectUri =
        typeof msg.redirectUri === 'string' && msg.redirectUri
          ? msg.redirectUri
          : backendUrl(readTransformerProfile(), readTransformerProfile().connector.oauth.relayCallback)
      const r = await exchangeAuthCode(msg.code, msg.codeVerifier, redirectUri)
      if (r.ok) {
        sendState()
        figma.ui.postMessage({ type: 'transformer-connected', account: r.account || '' })
        figma.notify(r.account ? 'Connected as ' + r.account : 'Transformer connected', { timeout: 3000 })
      } else {
        figma.ui.postMessage({ type: 'transformer-error', phase: 'connect', message: r.message, denied: !!r.denied })
        figma.notify(
          r.denied ? 'Transformer origin isn’t allowed — update the manifest allowlist' : 'Connect failed: ' + r.message,
          { timeout: 5000, error: true },
        )
      }
    } else if (msg.type === 'transformer-disconnect') {
      // Forget the tokens AND blank the backend profile — disconnect resets every
      // subfield (Backend URL, Transformer URL, slug, Publish URL) to null, so the
      // Backend field returns to its empty placeholder state.
      await clearTransformerAuth()
      writeTransformerProfile(EMPTY_BACKEND_PROFILE)
      sendState()
      figma.ui.postMessage({ type: 'transformer-connected', account: '' })
      figma.notify('Transformer disconnected', { timeout: 2500 })
    } else if (msg.type === 'transformer-save-profile') {
      // The Environment view's Advanced disclosure edited the target backend. If
      // its origin changed, the existing tokens are for a different backend — drop
      // them so the user reconnects to the new one.
      const next = normalizeProfile(msg.profile)
      const prev = readTransformerProfile()
      writeTransformerProfile(next)
      if (next.connector.baseUrl !== prev.connector.baseUrl && transformerAuth.connected) await clearTransformerAuth()
      sendState()
      figma.notify('Transformer settings saved', { timeout: 2500 })
    } else if (msg.type === 'run-transform' && typeof msg.componentKey === 'string') {
      // Main mints the run grant (fresh access token + target) and hands it to the
      // iframe, which streams the run and reports back via transformer-run-result.
      if (!requirePlatform() || !requireUnblocked(msg.componentKey, 'transform')) return
      const r = await beginTransformRun(msg.componentKey, sendState)
      if (r.ok) {
        sendState()
        figma.ui.postMessage({ type: 'transformer-run-grant', ...r.grant })
      } else {
        figma.notify(
          r.denied ? 'Transformer origin isn’t allowed — update the manifest allowlist' : r.message,
          { timeout: 4000, error: true },
        )
      }
    } else if (msg.type === 'transformer-run-result' && typeof msg.componentKey === 'string') {
      // The iframe finished (or failed) streaming the run. Persist the draft +
      // stamp the stages, or record the failure on the row. A network deny gets the
      // manifest-fix hint; everything else the plain error.
      const denied = typeof msg.message === 'string' && /alloweddomains|network access|not allowed/i.test(msg.message)
      const { message } = applyTransformResult(
        msg.componentKey,
        !!msg.ok,
        typeof msg.file === 'string' ? msg.file : '',
        denied ? 'origin not in the manifest allowlist — update networkAccess.allowedDomains' : msg.message,
      )
      sendState()
      figma.notify(message, { timeout: 4000, error: !msg.ok })
    } else if (msg.type === 'run-get-draft' && typeof msg.componentKey === 'string') {
      // The stage-5 editor asks for the current draft when it opens, so it can
      // show an existing paste or a transformer-produced template as editable
      // code. Drafts live in the workspace (pluginData), off the run state, so
      // this is a lightweight round-trip rather than shipping every draft in
      // every pipeline-state.
      const draft = readWork(msg.componentKey).draft || ''
      figma.ui.postMessage({ type: 'draft-content', componentKey: msg.componentKey, text: draft })
    } else if (msg.type === 'run-save-draft' && typeof msg.componentKey === 'string') {
      if (!requirePlatform() || !requireUnblocked(msg.componentKey, 'template')) return
      const { message } = saveDraft(msg.componentKey, msg.text || '')
      sendState()
      figma.notify(message, { timeout: 3000 })
    } else if (msg.type === 'run-autosave-draft' && typeof msg.componentKey === 'string') {
      // Quiet background persist from the template editor's auto-save. Same effect
      // as run-save-draft — writes the draft, stamps template done, cascades — but
      // with NO figma.notify: saving "just happens quietly and reliably" (design
      // note). Guards are silent (no error toast): we skip when the platform isn't
      // ready or the stage is blocked rather than nagging, since the UI only fires
      // this while it's already valid to save.
      const ready = readRunState().platform.ready
      const blocked = effectiveComponentStatus(readRunState(), msg.componentKey, 'template') === 'blocked'
      if (!ready || blocked) return
      const { ok } = saveDraft(msg.componentKey, msg.text || '')
      if (ok) sendState()
    } else if (msg.type === 'run-validate-draft' && typeof msg.componentKey === 'string') {
      if (!requirePlatform() || !requireUnblocked(msg.componentKey, 'validate')) return
      const { message } = await validateDraft(msg.componentKey, sendState)
      sendState()
      figma.notify(message, { timeout: 4000 })
    } else if (msg.type === 'run-publish-draft' && typeof msg.componentKey === 'string') {
      if (!requirePlatform() || !requireUnblocked(msg.componentKey, 'publish')) return
      const { message } = await publishDraft(msg.componentKey, sendState)
      sendState()
      figma.notify(message, { timeout: 4000 })
    } else if (msg.type === 'run-download-package') {
      // Run-level fallback publish: gather every scoped set's draft + contract and
      // hand them to the iframe to ZIP and download (the main thread can't reach the
      // filesystem). No component key — this bundles the whole run.
      if (!requirePlatform()) return
      const pkg = await gatherDownloadPackage()
      if (!pkg.ok) {
        figma.notify(pkg.message, { timeout: 4000, error: true })
        return
      }
      figma.ui.postMessage({ type: 'download-package', package: pkg })
    } else if (msg.type === 'run-scope-toggle' && typeof msg.componentKey === 'string') {
      // Clicking a Scope row scopes or descopes it — mounted sets default to
      // descoped, so this is how a set enters the run (and leaves it, clearing its
      // work). One gesture, no add/remove buttons.
      if (!requirePlatform()) return
      const key = msg.componentKey
      const scoped = readRunState().scope.find((r) => r.componentKey === key)
      if (scoped) {
        removeFromScope([key])
        sendState()
        figma.notify('Removed “' + scoped.name + '” from this run', { timeout: 2000 })
      } else {
        const ref = mounted.get(key)
        if (!ref) {
          figma.notify('That component set is no longer available', { timeout: 3000, error: true })
          return
        }
        const state = addToScope([ref])
        sendState()
        figma.notify('Added “' + ref.name + '” to this run (' + state.scope.length + ' total)', { timeout: 2500 })
      }
    } else if (msg.type === 'reveal-component' && typeof msg.nodeId === 'string') {
      // Plugin → canvas: focusing a Scope row jumps the viewport to that set. We
      // move the viewport AND select the node so canvas and plugin focus agree; the
      // selectionchange that follows just re-confirms the focus we already set — no
      // loop, because a reveal never toggles scope.
      try {
        const node = await figma.getNodeByIdAsync(msg.nodeId)
        if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
          const scene = node as SceneNode
          // With dynamic-page the node's page must be current before any viewport or
          // selection op — walk up to the owning PAGE and switch to it if needed.
          let page: BaseNode | null = scene.parent
          while (page && page.type !== 'PAGE') page = page.parent
          if (page && page.type === 'PAGE' && page.id !== figma.currentPage.id) {
            await figma.setCurrentPageAsync(page as PageNode)
          }
          figma.currentPage.selection = [scene]
          figma.viewport.scrollAndZoomIntoView([scene])
        }
      } catch {
        // Node gone / not revealable — ignore.
      }
    } else if (msg.type === 'user-resize' && typeof msg.width === 'number' && typeof msg.height === 'number') {
      // Drag-to-resize from the iframe edges/corner. Remember the size for the
      // next persist snapshot and next session.
      winW = clampW(msg.width)
      winH = clampH(msg.height)
      figma.ui.resize(winW, winH)
    } else if (msg.type === 'maximize' && typeof msg.width === 'number' && typeof msg.height === 'number') {
      // Fill-available-space shortcut (Cmd/Ctrl+Shift+F). The iframe sends the
      // screen's available size; Figma clamps ui.resize() to whatever the editor
      // viewport actually allows, so requesting large is safe. A generous cap
      // guards against absurd values.
      winW = Math.max(480, Math.min(4000, Math.round(msg.width)))
      winH = Math.max(320, Math.min(3000, Math.round(msg.height)))
      figma.ui.resize(winW, winH)
      persistWindow()
    } else if (msg.type === 'persist-window') {
      // Sent by the iframe on drag-end and a gentle poll — snapshot geometry.
      persistWindow()
    } else if (msg.type === 'close') {
      figma.closePlugin()
    }
  }
}

// ─── Init ───

figma.on('run', ({ command }: RunEvent) => {
  void (async () => {
    try {
      // Relaunch data is a scene mutation, so it must run here (after any
      // parameter-input phase) — never at module load. During Configure's
      // parameter prompts the plugin cannot mutate the document, which would
      // otherwise throw "This plugin currently can't mutate the scene".
      try { setDocumentRelaunchData() } catch { /* non-fatal, e.g. read-only context */ }

      switch (command) {
        case 'template':
          await handleTemplate()
          break

        case 'process':
          await handleProcess()
          break

        default:
          // No/unknown command — open the pipeline shell (the primary surface).
          await handleProcess()
          break
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      figma.notify('Error: ' + msg, { error: true })
      figma.closePlugin()
    }
  })()
})

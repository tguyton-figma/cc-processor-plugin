// The process shell (UI side). esbuild bundles this into an IIFE exposed as
// `window.CCPipeline` (see .figma/make/build-ui.mjs) and inlines it into
// ui.html's <script id="cc-pipeline"> marker. It renders the process Nav (steps
// + edges, inside the Aside) as a pure projection of the run state the main
// thread sends over postMessage, and a Main pane that drives the stage actions
// for the selected step.
//
// The Main pane renders each stage's working view: run-level actions for platform
// (1) and scope (2), and a compact field list — one row per scoped component — for
// the per-component stages (3, 4, 6, 7). The Templates stage (5) takes over the
// whole Main pane with a two-pane templating view: a signal canvas (a scrollable
// list of signal boxes, with copyable code blocks) beside a CodeMirror editor, plus a
// file switcher ([ / ] to cycle the focused component's template) and a settings
// overlay that tunes each rule's severity. Both engines are bundled siblings —
// window.CCEditor (CodeMirror + static highlighter) and window.CCValidation
// (the rule engine) — see mountTemplateEditor / renderTemplateSignals below.
//
// Styling is token-driven: every rule lives under #cc-pipeline-shell in ui.html
// and resolves to the focused --pl-* token set, so the views retheme from one
// place without touching this bundle.

import {
  STAGES,
  computeRollup,
  parseRunState,
  stageDef,
  effectiveComponentStatus,
  type StageId,
  type RunState,
  type StageRollup,
  type ComponentRef,
} from '../../pipeline'
import { icon, type IconName } from '../icons'
import {
  type BackendProfile,
  DEFAULT_BACKEND_PROFILE,
} from '../../transformer/profile'
import { connectTransformer, streamTransformRun, type RunGrant } from '../transformer'
import { buildZip, downloadBytes } from '../download'
import { assemblePackageEntries, type DownloadPackage } from '../package'

// Icon shorthands, resolved from the one registry (Phosphor light — see ../icons).
// Names read as intent; the registry decides which glyph backs each.
const diamondsFour = icon('diamonds-four')
const edge = icon('edge')
const faders = icon('faders')
const trash = icon('trash')
const copyGlyph = icon('copy')
const arrowLeft = icon('arrow-left')
const caretLeft = icon('caret-circle-left')
const caretRight = icon('caret-circle-right')
// Template file + signal navigation.
const gear = icon('gear')
const plus = icon('plus')
// Accordion disclosure caret (contract cards) — points right when collapsed, and
// CSS rotates it down when the row is open.
const caretDisclose = icon('caret-right')
// The contract card's leading mark — the same contract glyph the stage wears in Nav.
const contractGlyph = icon('generate-contract')
const fileTs = icon('file-ts')
const fileZip = icon('file-zip')
const navFirst = icon('caret-line-left')
const navPrev = icon('caret-left')
const navNext = icon('caret-right')
const navLast = icon('caret-line-right')
// Credential lifecycle (env fields).
const userCircleCheck = icon('user-circle-check')
const arrowsClockwise = icon('arrows-clockwise')
const globe = icon('globe')
// Backend config route glyphs (the "Backend" panel). The
// link pair signals a route's state (whole = set, broken = empty); the globe marks
// the publish route.
const linkSimple = icon('link-simple')
const linkSimpleBreak = icon('link-simple-break')
const linkBreak = icon('link-break')
// Per-component row status glyphs — the Field's left signal.
const checkCircle = icon('check-circle')
const xCircle = icon('x-circle')
const circle = icon('circle')
const circleFill = icon('circle-fill')
const minusCircle = icon('minus-circle')
const skipGlyph = icon('skip')

// One status glyph per component state — the row's at-a-glance signal. State
// colour lives on the glyph (and a quiet word), never a stroke on the box.
const STATUS_ICON: Record<string, string> = {
  done: checkCircle,
  active: circleFill,
  failed: xCircle,
  blocked: minusCircle,
  skipped: skipGlyph,
  pending: circle,
}

// The wired per-component stages, folded into the Field itself: the message a row
// posts when clicked. The row carries no trailing verb — the signal glyph is the
// whole affordance (see buildStageRow), matching the Scope view's rows.
const STAGE_ACTION: Record<string, string> = {
  contract: 'generate-contract',
  transform: 'transform',
  validate: 'validate-draft',
  publish: 'publish-draft',
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Attribute-safe escaping: esc handles & < > "; also neutralize single quotes so
// a snippet can't break out of the data-copy='…' attribute.
function attr(s: string): string {
  return esc(s).replace(/'/g, '&#39;')
}

function post(type: string, extra?: Record<string, unknown>): void {
  parent.postMessage({ pluginMessage: { type, ...extra } }, '*')
}

// ─── Reconciling field list (the plugin-wide list pattern) ───
//
// Large field lists must never be rebuilt wholesale on a state update: an
// `innerHTML =` teardown drops focus, resets scroll, and flickers — and a single
// gesture can trigger a burst of state messages. Instead, drive every list through
// `syncList`, which reconciles a keyed model against the live DOM: rows present in
// both are patched IN PLACE (cheap, focus-preserving), new rows are built, gone
// rows are removed, and order is fixed with minimal moves.
//
// Realtime feel comes from pairing this with OPTIMISM at the call site: on a
// gesture, mutate the local model and call syncList SYNCHRONOUSLY (so the UI reacts
// this frame), THEN post the intent. The authoritative state message re-syncs when
// it lands — a no-op when the optimism was right, a correction when it wasn't.

// Parse one row's HTML (an <li>/<div>) into a detached element. <template> content
// can host an <li> directly, unlike a stray innerHTML container.
function parseRow(html: string): HTMLElement {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild as HTMLElement
}

// Reconcile `listEl`'s children against `models` (keyed, ordered). `build` renders a
// fresh row (and MUST put data-key on the row element); new rows are built, gone
// rows removed, order fixed with minimal moves.
//
// A matched row is reconciled one of two ways. When the model carries a `sig`
// (a signature of everything visual about the row), the row also carries it as
// `data-sig`, and a row is rebuilt WHOLESALE only when its signature changed —
// cheap for the common no-op sync, and it copes with rows whose very structure
// varies by state (a button vs a quiet div). When there's no `sig`, `patch`
// mutates the existing row in place (never replacing it), so DOM focus/selection
// survive — the right choice for rows the user is actively interacting with.
function syncList<M extends { key: string; sig?: string }>(
  listEl: HTMLElement,
  models: M[],
  build: (m: M) => string,
  patch?: (el: HTMLElement, m: M) => void,
): void {
  const existing = new Map<string, HTMLElement>()
  for (const el of Array.from(listEl.children) as HTMLElement[]) {
    const k = el.getAttribute('data-key')
    if (k) existing.set(k, el)
  }
  const seen = new Set<string>()
  let anchor: ChildNode | null = null
  for (const m of models) {
    seen.add(m.key)
    let el = existing.get(m.key)
    if (!el) {
      el = parseRow(build(m))
      if (m.sig != null) el.setAttribute('data-sig', m.sig)
    } else if (m.sig != null && el.getAttribute('data-sig') !== m.sig) {
      // Signature changed → rebuild the row wholesale (its structure may differ).
      const fresh = parseRow(build(m))
      fresh.setAttribute('data-sig', m.sig)
      el.replaceWith(fresh)
      el = fresh
    } else if (patch) {
      patch(el, m)
    }
    const target: ChildNode | null = anchor ? anchor.nextSibling : listEl.firstChild
    if (el !== target) listEl.insertBefore(el, target)
    anchor = el
  }
  for (const [k, el] of existing) if (!seen.has(k)) el.remove()
}

// ─── The bundled editor + validation engines (see build-ui.mjs) ───
// The CodeMirror wrapper (src/editor → window.CCEditor) and the validation engine
// (src/engine → window.CCValidation) are inlined into ui.html as sibling IIFEs.
// The Templates stage consumes both directly, so the pasted/transformed template
// is edited as syntax-highlighted code with live signals — the same engines the
// standalone template editor uses.

interface CCEditorHandle {
  getValue(): string
  setValue(text: string): void
  focus(): void
  view: { requestMeasure(): void } | null
}
interface CCEditorApi {
  create(
    parent: HTMLElement,
    opts: { doc?: string; placeholder?: string; onChange?: (v: string) => void; onEscape?: () => void; readOnly?: boolean },
  ): CCEditorHandle
  // Static TS/TSX highlighter (same tokenizer as the editor) → HTML string.
  highlight(code: string): string
}
type CCLevel = 'error' | 'comment'
type CCSeverity = 'error' | 'comment' | 'mute'
interface CCIssue {
  ruleId: string
  level: CCLevel
  group: string
  phase: string
  title: string
  message: string
  hint: string
  // Optional copyable fix-snippet; when present it supersedes the prose hint in
  // the canvas (the guidance rides in the snippet's own comments).
  code?: string
  icon: string
  severityIcon: string
}
interface CCSummary {
  errors: number
  comments: number
  pass: boolean
  state: 'pass' | 'error' | 'comment'
  stateIcon: string
}
interface CCSemanticFinding {
  ruleId: string
  message?: string
}
interface CCResult {
  issues: CCIssue[]
  summary: CCSummary
  // node-id parsed from the template's URL ('' when absent) — the input to the
  // main-thread semantic round-trip.
  nodeId: string
}
interface CCRuleGroupDef {
  title: string
  icon: string
  order: number
}
interface CCRuleDef {
  title: string
  hint: string
}
interface CCValidationApi {
  validate(text: string, config?: unknown): CCResult
  mergeSemantic(base: CCResult, findings: CCSemanticFinding[], config?: unknown): CCResult
  parseConfig(raw: unknown): unknown
  serializeConfig(config: unknown): string
  effectiveSeverity(id: string, config?: unknown): CCSeverity
  icon(name: string): string
  RULES: Record<string, CCRuleDef>
  RULE_IDS: string[]
  RULE_GROUPS: Record<string, CCRuleGroupDef>
}
declare global {
  interface Window {
    CCEditor?: CCEditorApi
    CCValidation?: CCValidationApi
  }
}

// ─── Nav (the process rail, inside the Aside) ───

// Tooltip text for a Nav step: position, label, status, and (for per-component
// stages) the breakdown across the scoped set.
function titleFor(r: StageRollup): string {
  const base = `${r.order}. ${r.label} — ${r.status}`
  if (r.scope !== 'component' || r.total === 0) return base
  const c = r.counts
  const parts: string[] = [`${c.done}/${r.total} done`]
  if (c.active) parts.push(`${c.active} active`)
  if (c.failed) parts.push(`${c.failed} failed`)
  if (c.blocked) parts.push(`${c.blocked} blocked`)
  if (c.skipped) parts.push(`${c.skipped} skipped`)
  return `${base} (${parts.join(', ')})`
}

function navHtml(rollups: StageRollup[], selected: StageId): string {
  const out: string[] = []
  rollups.forEach((r, i) => {
    const glyph = icon(r.icon as IconName)
    const sel = r.id === selected ? ' is-selected' : ''
    out.push(
      `<button type="button" class="cc-pl-step is-${r.status}${sel}" data-stage="${esc(r.id)}" title="${esc(titleFor(r))}" aria-label="${esc(titleFor(r))}">${glyph}</button>`,
    )
    if (i < rollups.length - 1) out.push(`<div class="cc-pl-edge" aria-hidden="true">${edge}</div>`)
  })
  return out.join('')
}

// ─── The Field ───
//
// The one canonical surface. A Field has three parts:
//   • an optional quiet `label` above it;
//   • a `body` — the bordered surface, a headless 3-column row: `signal` icons on
//     the left (state / context), a flexible `main` affordance in the middle (a
//     text label, an <input>, an icon nav, a message), and stateful `actions` on
//     the right (e.g. the save↔trash icon state machine);
//   • optional `extensions` — coupled pill widgets below the body.
//
// One `state` (→ `data-state`) drives BOTH the border and the signal tint, so a
// field's status has a single source of truth. The `body` renders as a <div> or,
// for a whole-surface affordance, a <button>; the wrapper is a <div> or <li>.
type FieldState =
  | 'resting'
  | 'focused'
  | 'error'
  | 'notice'
  | 'done'
  | 'active'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'pending'

function field(o: {
  main?: string // middle slot inner HTML — the primary affordance
  signal?: string // left slot inner HTML — a signal icon (omit → no slot)
  signalCls?: string // extra class on the signal span (e.g. is-connecting)
  actions?: string // right slot inner HTML — action(s) (omit → no slot)
  label?: string // quiet label text above the body
  labelExtra?: string // pre-built trailing label HTML (e.g. an "— optional" note)
  labelFor?: string // <label for="…">
  extensions?: string // pre-built extension pills below the body
  state?: FieldState // data-state → border + signal tint
  as?: 'div' | 'li' // the wrapper element
  body?: 'div' | 'button' // the surface element — 'button' = whole-surface affordance
  attrs?: string // extra attributes on the wrapper
  bodyAttrs?: string // extra attributes on the surface
  cls?: string // extra class on the wrapper
  bodyCls?: string // extra class on the surface
}): string {
  const wrapTag = o.as || 'div'
  const bodyTag = o.body || 'div'
  const state = o.state && o.state !== 'resting' ? ` data-state="${o.state}"` : ''
  const signalCls = 'cc-field-signal' + (o.signalCls ? ' ' + o.signalCls : '')
  const signal = o.signal ? `<span class="${signalCls}" aria-hidden="true">${o.signal}</span>` : ''
  const main = `<div class="cc-field-main">${o.main || ''}</div>`
  const actions = o.actions ? `<div class="cc-field-actions">${o.actions}</div>` : ''
  const bodyCls = 'cc-field-body' + (o.bodyCls ? ' ' + o.bodyCls : '')
  const bodyAttrs = o.bodyAttrs ? ' ' + o.bodyAttrs : ''
  const body = `<${bodyTag} class="${bodyCls}"${state}${bodyAttrs}>${signal}${main}${actions}</${bodyTag}>`

  let label = ''
  if (o.label || o.labelExtra) {
    const forAttr = o.labelFor ? ` for="${o.labelFor}"` : ''
    label = `<label class="cc-field-label"${forAttr}>${o.label ? esc(o.label) : ''}${o.labelExtra || ''}</label>`
  }
  const ext = o.extensions ? `<div class="cc-field-extensions">${o.extensions}</div>` : ''
  const cls = 'cc-field' + (o.cls ? ' ' + o.cls : '')
  const attrs = o.attrs ? ' ' + o.attrs : ''
  return `<${wrapTag} class="${cls}"${attrs}>${label}${body}${ext}</${wrapTag}>`
}

// The middle slot's text affordance — placeholder-grey until it carries a real
// value (`has-value`).
function fieldText(text: string, hasValue?: boolean): string {
  return `<span class="cc-field-text${hasValue ? ' has-value' : ''}">${esc(text)}</span>`
}

// The middle slot as a stacked title over a muted supporting line (the settings
// rule rows).
function fieldLines(title: string, sub: string): string {
  return (
    `<span class="cc-field-lines">` +
    `<span class="cc-field-text has-value">${esc(title)}</span>` +
    `<span class="cc-field-sub">${esc(sub)}</span>` +
    `</span>`
  )
}

// One extension — a pill widget coupled to the field above it: a small leading
// icon + a quiet label, optionally stateful. Extensions add capability to a field
// without crowding its body.
function fieldExt(o: { icon: string; label: string; attrs?: string; state?: FieldState }): string {
  const state = o.state && o.state !== 'resting' ? ` data-state="${o.state}"` : ''
  const attrs = o.attrs ? ' ' + o.attrs : ''
  return (
    `<button type="button" class="cc-field-ext"${state}${attrs}>` +
    `<span class="cc-field-ext-icon" aria-hidden="true">${o.icon}</span>` +
    `<span class="cc-field-ext-label">${esc(o.label)}</span>` +
    `</button>`
  )
}

// ─── Contract config (stage 3) ───
// The tunable payload a generated contract carries. Mirrors CONTRACT_DEFAULTS in
// code.ts — the shipped baseline. The settings overlay edits a run-wide `defaults`
// layer plus per-component `overrides`; the effective config is the merge, resolved
// here for display and in code.ts (effectiveContractConfig) at generate time.
const CONTRACT_DEFAULTS = {
  includeProperties: true,
  includeDefaults: true,
  includeOptions: true,
  includeDescription: true,
  skills: [] as string[],
  prompt: '',
  sourcePaths: [] as string[],
}
type ContractCfg = typeof CONTRACT_DEFAULTS
type ContractToggle = 'includeProperties' | 'includeDefaults' | 'includeOptions' | 'includeDescription'

// The contract-field toggles, in display order: which Figma-derived fields the
// contract carries. Each is a whole-row button that flips its boolean.
const CONTRACT_TOGGLES: { field: ContractToggle; title: string; hint: string }[] = [
  { field: 'includeProperties', title: 'Component properties', hint: 'The variant, boolean, text and instance-swap surface' },
  { field: 'includeDefaults', title: 'Default values', hint: 'Each property’s default value' },
  { field: 'includeOptions', title: 'Variant options', hint: 'The allowed values for each variant property' },
  { field: 'includeDescription', title: 'Description', hint: 'The component set’s description text' },
]

// ─── Environment (stage 1) config ───

// The environment snapshot from the main thread: a file key (verbatim), a boolean
// per PLANT secret (the stored value is never sent back), and the transformer
// connection (connected + account label + which backend to target — never a token).
export interface EnvConfig {
  fileKey: string
  restSaved: boolean
  cliSaved: boolean
  // The Figma editor the plugin is running in ('dev' | 'figma' | 'figjam' | …). The
  // publish stage foregrounds the download fallback in Dev Mode.
  editorType: string
  transformer: { connected: boolean; account: string; profile: BackendProfile }
}

const EMPTY_ENV: EnvConfig = {
  fileKey: '',
  restSaved: false,
  cliSaved: false,
  editorType: 'figma',
  transformer: { connected: false, account: '', profile: DEFAULT_BACKEND_PROFILE },
}

// The Backend is no longer a text field — it's an OAuth Connect control on its own
// card (see transformerBlockHtml). Only the three text setup fields remain here.
type EnvFieldName = 'file' | 'rest' | 'cli'

interface EnvFieldDef {
  label: string // doubles as the inline placeholder — no label sits outside the field
  type: 'text' | 'password'
}

// The three text setup fields, in order. Secrets render masked; the file field
// collapses a pasted URL to its key.
const ENV_FIELD_ORDER: EnvFieldName[] = ['file', 'rest', 'cli']
const ENV_FIELDS: Record<EnvFieldName, EnvFieldDef> = {
  file: { label: 'File key', type: 'text' },
  rest: { label: 'REST API PLANT', type: 'password' },
  cli: { label: 'CLI PLANT', type: 'password' },
}

// True when a field currently holds a stored value (a saved secret, or a file key).
function envSaved(env: EnvConfig, name: EnvFieldName): boolean {
  if (name === 'file') return env.fileKey !== ''
  if (name === 'rest') return env.restSaved
  return env.cliSaved
}

// A file key from a raw URL or bare key (mirrors the old iframe helper). Returns
// null when nothing key-shaped is present.
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

// One environment field, rendered through the Field primitive: a leading signal
// glyph, an <input> body, and — only once a value is stored — a trailing trash icon
// to clear it. There is NO save button: editing auto-saves on blur/Enter (see
// mountEnvFields), and the field's state rides its icons, not a floppy. The field's
// own name is its placeholder — no label sits outside the field.
// `seedValue` seeds the input (the file key, or '' for secrets). This is the resting
// markup; the live lifecycle (focus/validating/verified/error) is driven in
// renderEnvField.
function envFieldHtml(env: EnvConfig, name: EnvFieldName): string {
  const def = ENV_FIELDS[name]
  const saved = envSaved(env, name)
  const seedValue = name === 'file' ? env.fileKey : ''
  // The inline label doubles as the placeholder; a saved secret advertises itself
  // with a dotted mark instead (the value never leaves the main thread).
  const placeholder = name !== 'file' && saved ? '••••••••••' : def.label

  // Resting glyph + border: a valid file key checks green (is-done); a stored secret
  // shows the check-circle "saved" mark with no border (design's Resting). The person
  // glyph (user-circle-check) is reserved for a real OAuth account (the Backend), so a
  // saved token uses the same check-circle every other "present/good" field does.
  let menuGlyph: string
  let state: FieldState = 'resting'
  if (name === 'file') {
    const fileValid = !!extractFileKey(seedValue)
    menuGlyph = fileValid ? checkCircle : circle
    if (fileValid) state = 'done'
  } else {
    menuGlyph = saved ? checkCircle : circle
  }

  const input =
    `<input class="cc-field-inputel" id="cc-env-${name}" data-field="${name}" type="${def.type}"` +
    ` autocomplete="off" spellcheck="false" value="${attr(seedValue)}" placeholder="${attr(placeholder)}" />`
  // Trailing control exists only for a stored value: a trash to clear it. While
  // editing an unsaved value the slot is empty — the blur auto-saves it.
  const trailBtn = saved
    ? `<button type="button" class="cc-field-iconbtn is-trash" data-envact data-field="${name}" title="Delete">${trash}</button>`
    : ''

  return field({
    signal: menuGlyph,
    main: input,
    actions: trailBtn,
    state,
    bodyCls: 'cc-field-input',
    bodyAttrs: `data-field="${name}"`,
  })
}

// The Backend — the root credential field for the whole run's backend. It's a
// collapsible card, NOT a text field: an elevated header
// (connection glyph · "Backend" · caret) over a body of route SUBFIELDS on the
// darker panel tone. The connection lifecycle lives ON the header, the same way every
// other field in the plugin wears its state as a leading icon — a broken chain when
// disconnected, a person mark when connected (an OAuth account), the globe pulsing
// while the handshake is in flight. Clicking that glyph connects (or reconnects); a
// trailing unlink glyph disconnects. There is no separate Connect/Reconnect pill row
// and no "Advanced" — the subfields ARE the backend's config.
//
// The subfields split the profile the way it's modelled: one CONNECTOR (the Backend
// URL, the origin every feature reaches) and the FEATURE ROUTES that hang off it (the
// transformer run URL + slug, and the Variables publish URL). Each wears a leading
// glyph that reads its state — a whole chain when a route carries a value, a broken
// one when empty; the slug checks when set; the publish route reads the same chain
// (link set / broken empty) at rest. The globe is NOT a resting route glyph — it is
// reserved for the in-flight validating state (see renderEnvField), so a route only
// wears it while its write is being checked, then resolves back to the chain. Editing a
// route auto-saves (on change) — no floppy. A dev pointing
// at a non-Figma origin must also add it to manifest.json's allowedDomains (read at
// publish time, never at runtime), surfaced as a network-deny hint if a request fails.
const routeSignalFor: Record<'baseUrl' | 'runPath' | 'slug' | 'publishPath', (v: string) => string> = {
  baseUrl: (v) => (v.trim() ? linkSimple : linkSimpleBreak),
  runPath: (v) => (v.trim() ? linkSimple : linkSimpleBreak),
  slug: (v) => (v.trim() ? checkCircle : circle),
  publishPath: (v) => (v.trim() ? linkSimple : linkSimpleBreak),
}

function transformerBlockHtml(env: EnvConfig): string {
  const tf = env.transformer
  const p = tf.profile
  const connected = tf.connected

  // The header's connection glyph — the whole affordance for connect/reconnect.
  const connGlyph = connected ? userCircleCheck : linkSimpleBreak
  const connTitle = connected ? 'Reconnect' : 'Connect'
  const connState = connected ? ' data-state="done"' : ''

  const routeField = (
    id: string,
    key: 'baseUrl' | 'runPath' | 'slug' | 'publishPath',
    value: string,
    placeholder: string,
  ): string =>
    field({
      signal: routeSignalFor[key](value),
      main:
        `<input class="cc-field-inputel" id="${id}" data-tf-field="${key}" type="text" autocomplete="off"` +
        ` spellcheck="false" value="${attr(value)}" placeholder="${attr(placeholder)}" />`,
      bodyCls: 'cc-field-input',
    })

  return (
    `<div class="cc-pl-backend" id="cc-pl-backend" data-open="true">` +
    `<div class="cc-pl-backend-head">` +
    `<button type="button" class="cc-pl-backend-conn" data-tf="connect" title="${attr(connTitle)}" aria-label="${attr(connTitle)}">` +
    `<span class="cc-pl-backend-glyph" id="cc-pl-backend-conn-glyph"${connState} aria-hidden="true">${connGlyph}</span>` +
    `</button>` +
    `<button type="button" class="cc-pl-backend-toggle" data-tf="collapse" aria-expanded="true">` +
    `<span class="cc-pl-backend-name">Backend</span>` +
    `</button>` +
    (connected
      ? `<button type="button" class="cc-pl-backend-disc" data-tf="disconnect" title="Disconnect" aria-label="Disconnect">${linkBreak}</button>`
      : '') +
    `<button type="button" class="cc-pl-backend-caretbtn" data-tf="collapse" aria-hidden="true" tabindex="-1">` +
    `<span class="cc-pl-backend-caret">${caretDisclose}</span>` +
    `</button>` +
    `</div>` +
    `<div class="cc-pl-backend-body">` +
    routeField('cc-tf-baseurl', 'baseUrl', p.connector.baseUrl, 'Backend URL') +
    routeField('cc-tf-run-path', 'runPath', p.features.run.path, 'Transformer URL') +
    routeField('cc-tf-slug', 'slug', p.features.run.slug, 'Transformer Slug') +
    routeField('cc-tf-publish-path', 'publishPath', p.features.publish.path, 'Publish URL') +
    `</div>` +
    `</div>`
  )
}

// ─── Scope (stage 2) rows ───
//
// One model per mounted component set, and the build/patch pair `syncList` drives.
// Keeping them together (and module-level) means the initial full render and every
// in-place reconcile emit the SAME markup, so a patched row is byte-identical to a
// freshly-built one.
interface ScopeRowModel {
  key: string // componentKey — the list key AND the scope identity
  name: string
  nodeId: string
  scoped: boolean // in the run (green check) vs mounted-but-out (neutral)
  focused: boolean // matches the canvas selection (blue edge)
}

function scopeRowModels(mounted: ComponentRef[], scope: ComponentRef[], focus: string | null): ScopeRowModel[] {
  const scoped = new Set(scope.map((r) => r.componentKey))
  return mounted.map((r) => ({
    key: r.componentKey,
    name: r.name,
    nodeId: r.nodeId,
    scoped: scoped.has(r.componentKey),
    focused: r.componentKey === focus,
  }))
}

function buildScopeRow(m: ScopeRowModel): string {
  return field({
    as: 'li',
    body: 'button',
    // A scoped set checks green (in the run); a descoped one shows the neutral
    // DiamondsFour and muted text.
    signal: m.scoped ? checkCircle : diamondsFour,
    main: fieldText(m.name, m.scoped),
    state: m.scoped ? 'done' : 'resting',
    // The canvas selection focuses its row; the highlight rides a class so it's
    // independent of the scoped/descoped state.
    cls: m.focused ? 'is-focused' : '',
    attrs: `data-key="${esc(m.key)}"`,
    bodyAttrs:
      `type="button" data-action="scope-toggle" data-on="${m.scoped ? '1' : '0'}"` +
      ` data-key="${esc(m.key)}" data-node="${esc(m.nodeId)}"` +
      ` aria-pressed="${m.scoped ? 'true' : 'false'}"`,
  })
}

// In-place patch — mutates attributes/glyph only, never replaces the row, so the
// clicked button keeps DOM focus. The scoped visuals are guarded by data-on so a
// focus-only sync skips the glyph churn entirely.
function patchScopeRow(el: HTMLElement, m: ScopeRowModel): void {
  el.classList.toggle('is-focused', m.focused)
  const btn = el.querySelector('.cc-field-body') as HTMLElement | null
  if (!btn) return
  if ((btn.getAttribute('data-on') === '1') === m.scoped) return // scoped visuals unchanged
  btn.setAttribute('data-on', m.scoped ? '1' : '0')
  btn.setAttribute('aria-pressed', m.scoped ? 'true' : 'false')
  if (m.scoped) btn.setAttribute('data-state', 'done')
  else btn.removeAttribute('data-state')
  const sig = btn.querySelector('.cc-field-signal')
  if (sig) sig.innerHTML = m.scoped ? checkCircle : diamondsFour
  const txt = btn.querySelector('.cc-field-text')
  if (txt) txt.classList.toggle('has-value', m.scoped)
}

// ─── Main (the working pane) ───

// The publish stage's run-level fallback: a "Download package" action that bundles
// every scoped set's template + contract into a ZIP the user can publish from the CLI
// (see gatherDownloadPackage / src/ui/download.ts). It's always available — a designer
// may want the files regardless — but it's the PRIMARY publish path in Dev Mode
// without a backend (the Variables plugin API is read-only there and a run-publish
// would fail), so the copy leads with that when it applies.
function publishPackageHtml(env: EnvConfig): string {
  const isDev = env.editorType === 'dev'
  const hasBackend = env.transformer.connected
  // Foreground the fallback when a row-level publish can't succeed: Dev Mode with no
  // backend connected. Otherwise it's a quiet secondary offer below the rows.
  const primary = isDev && !hasBackend
  const note = primary
    ? `In Dev Mode without a backend, Figma Variables can’t be written from the plugin — download your Code Connect files and publish them from your terminal instead.`
    : `Prefer to publish from your terminal? Download every scoped template and its contract as a Code Connect package.`
  const btn = field({
    body: 'button',
    signal: fileZip,
    main: fieldText('Download package', true),
    state: primary ? 'notice' : 'resting',
    cls: 'cc-pl-download' + (primary ? ' is-primary' : ''),
    bodyAttrs: `type="button" data-action="download-package"`,
  })
  return `<p class="cc-pl-note">${esc(note)}</p>${btn}`
}

// The stage-specific body of the Main pane, for every stage EXCEPT template (5),
// which takes over Main entirely (see templateMainHtml). Run-level stages get real
// action buttons; per-component stages get one field row each.
function bodyHtml(
  id: StageId,
  state: RunState,
  rollup: StageRollup,
  env: EnvConfig,
  mounted: ComponentRef[],
  focus: string | null,
): string {
  if (id === 'platform') {
    // No explicit "validate" step: the platform is a form. Each field validates
    // itself as it's saved (the file key's shape, the REST PLANT against the live
    // API), and readiness is derived from what's stored — a valid file key plus a
    // REST PLANT unlock the downstream stages automatically. The setup fields are
    // each rendered through the Field primitive and wired for save/clear + live
    // validation in mountEnvFields; the foot carries the last field-level message.
    const fields = ENV_FIELD_ORDER.map((name) => envFieldHtml(env, name)).join('')
    return (
      `<div class="cc-pl-env">${fields}${transformerBlockHtml(env)}</div>` +
      `<p class="cc-pl-env-foot" id="cc-pl-env-foot" role="status"></p>`
    )
  }
  if (id === 'scope') {
    // Nothing to scope against until the platform's ready — the file key is what we
    // discover component sets from.
    if (!state.platform.ready) {
      return `<p class="cc-pl-msg">Add a file key in step 1 first.</p>`
    }
    // Every component set the view knows about — discovered from the file and
    // augmented by whatever's on the canvas — is a clickable Field. There are no
    // add/remove buttons: the click IS the scope toggle, defaulting to descoped.
    // `state.scope` is the persisted subset actually in the run.
    if (!mounted.length) {
      return `<p class="cc-pl-msg">No component sets found in this file yet — select one on the canvas and it’ll appear here.</p>`
    }
    const rows = scopeRowModels(mounted, state.scope, focus).map(buildScopeRow).join('')
    return `<ul class="cc-fields">${rows}</ul>`
  }
  // The wired per-component stages — contract (3), transform (4), validate (6),
  // publish (7) — render one row per scoped set with a stage-appropriate action.
  // (Template (5) is handled by the full-pane takeover, never here.)
  // Contract (3) is a component stage but renders as its own accordion of cards,
  // not the flat field list — so it branches first. The
  // list body is filled by renderContractList() after Main mounts (like the
  // template view), so the read-only editor for the open row can be wired live.
  if (id === 'contract') {
    if (!state.platform.ready) return `<p class="cc-pl-msg">Add a file key in step 1 first.</p>`
    if (state.scope.length === 0) return `<p class="cc-pl-msg">Scope some component sets (step 2) first.</p>`
    // A single quiet "Contract defaults" entry sits above the list — the run-wide
    // config (skills, prompt, source paths, which Figma fields to include). Each row's
    // own gear tunes that component's overrides.
    const defaults =
      `<div class="cc-pl-ct-tools">` +
      `<button type="button" class="cc-pl-ct-defaults" id="cc-pl-ct-settings" title="Contract defaults" aria-label="Contract defaults">${gear}<span>Defaults</span></button>` +
      `</div>`
    return `${defaults}<ul class="cc-pl-ct-list" id="cc-pl-ct-list"></ul>`
  }
  if (isComponentStage(id)) {
    if (!state.platform.ready) return `<p class="cc-pl-msg">Add a file key in step 1 first.</p>`
    if (state.scope.length === 0) return `<p class="cc-pl-msg">Scope some component sets (step 2) first.</p>`
    // Same keyed-model list as the Scope view, so full render and the realtime
    // soft-refresh (syncStage) emit identical markup. A full render reflects the
    // authoritative state only — no optimistic overlay (NO_ACTIVE).
    const rows = stageRowModels(id, state, NO_ACTIVE).map(buildStageRow).join('')
    // The publish stage carries a run-level download fallback below its rows (the
    // primary path in Dev Mode without a backend).
    const pkg = id === 'publish' ? publishPackageHtml(env) : ''
    return `<ul class="cc-fields">${rows}</ul>${pkg}`
  }

  // Any other unwired stage — read-only rollup (none remain, but kept as a
  // graceful default).
  const c = rollup.counts
  const summary =
    rollup.total === 0
      ? `<p class="cc-pl-msg">Scope some component sets (step 2) to populate this stage.</p>`
      : `<p class="cc-pl-msg">${c.done}/${rollup.total} done` +
        (c.active ? ` · ${c.active} active` : '') +
        (c.failed ? ` · ${c.failed} failed` : '') +
        (c.blocked ? ` · ${c.blocked} blocked` : '') +
        (c.skipped ? ` · ${c.skipped} skipped` : '') +
        `</p>`
  return summary + `<p class="cc-pl-note">Actions for this stage arrive in a later phase.</p>`
}

// The wired per-component stages — the ones that render one clickable row per
// scoped set. Drives both the branch in bodyHtml and the realtime soft-refresh.
const COMPONENT_STAGES: StageId[] = ['contract', 'transform', 'validate', 'publish']
function isComponentStage(id: StageId): boolean {
  return COMPONENT_STAGES.indexOf(id) !== -1
}
// A shared empty overlay for the full-render path (no optimism in play there).
const NO_ACTIVE: Set<string> = new Set()

// A per-component stage row, expressed as a keyed model so the list can reconcile
// through `syncList` (like the Scope view). Each scoped set contributes a `row`
// model; a set carrying a last-error line contributes a trailing `msg` model too,
// keyed off the same component so both reconcile as siblings. `sig` captures every
// visual input (status + name, or the message text) so a row is rebuilt only when
// something actually changed.
interface StageRowModel {
  key: string
  sig: string
  kind: 'row' | 'msg'
  id: StageId
  name: string
  st: FieldState
  err?: string
}

// Build the row models for a stage. `activeKeys` are component keys the UI is
// optimistically showing in flight (a click posted, the main thread not yet heard
// from): they render as `active` immediately, and their stale error line is hidden.
function stageRowModels(id: StageId, state: RunState, activeKeys: Set<string>): StageRowModel[] {
  const out: StageRowModel[] = []
  for (const ref of state.scope) {
    const key = ref.componentKey
    let st = effectiveComponentStatus(state, key, id)
    // Optimistic in-flight overlay — but never override a state that isn't even
    // actionable (blocked upstream, or a skipped transform).
    if (activeKeys.has(key) && st !== 'blocked' && st !== 'skipped') st = 'active'
    const err = activeKeys.has(key) ? undefined : state.components[key]?.errors?.[id]
    out.push({ key, kind: 'row', id, name: ref.name, st: st as FieldState, sig: `r|${st}|${ref.name}` })
    if (err) out.push({ key: key + ' msg', kind: 'msg', id, name: ref.name, st: st as FieldState, err, sig: `m|${err}` })
  }
  return out
}

// Render one stage row model to HTML. The Field itself IS the affordance — exactly
// like a Scope row, there's no trailing verb: the left signal glyph carries the
// whole state (an empty circle = ready to run, a spinner = in flight, a check =
// done, an ✕ = failed) and clicking the row runs — or silently re-runs — the
// stage. Actionable states (pending / failed / done) are buttons; blocked / active
// / skipped rows are quiet and non-clickable. The `data-sig` rides along so
// syncList can tell an unchanged row from one that needs rebuilding.
function buildStageRow(m: StageRowModel): string {
  const key = esc(m.key)
  const sig = esc(m.sig)
  if (m.kind === 'msg') {
    // The msg model's key is `<componentKey> msg`; esc handles the separator.
    return `<li class="cc-pl-rowmsg" data-key="${key}" data-sig="${sig}">${esc(m.err || '')}</li>`
  }
  const { id, st } = m
  const inFlight = st === 'active'
  const base = {
    as: 'li' as const,
    // In flight → a globe that gently pulses blue (calm progress, never a spinner);
    // otherwise the settled state glyph.
    signal: inFlight ? globe : STATUS_ICON[st] || circle,
    signalCls: inFlight ? 'is-connecting' : '',
    main: fieldText(m.name, true),
    state: st,
    attrs: `data-key="${key}" data-sig="${sig}"`,
  }
  // Skipped transform → a quiet hint that the manual paste in step 5 is the path. The
  // transformer marks itself skipped when none is connected (code.ts); there's no skip
  // control — not running a set (or descoping it in step 2) is itself the skip.
  if (id === 'transform' && st === 'skipped') {
    return field({ ...base, actions: `<span class="cc-pl-hint">paste in step 5</span>` })
  }
  // Blocked (upstream not cleared) or active (in flight) → quiet, non-clickable;
  // the signal alone tells the story.
  if (st === 'blocked' || st === 'active') {
    return field({ ...base })
  }
  // Actionable: pending / failed / done. The whole row is the affordance. (Contract
  // never reaches here — it renders as its own accordion; see contractItemHtml.)
  return field({
    ...base,
    body: 'button',
    bodyAttrs: `type="button" data-action="${STAGE_ACTION[id]}" data-key="${key}"`,
  })
}

function mainHtml(
  id: StageId,
  state: RunState,
  rollups: StageRollup[],
  env: EnvConfig,
  mounted: ComponentRef[],
  focus: string | null,
): string {
  const def = stageDef(id)
  const rollup = rollups.find((r) => r.id === id)!
  return (
    `<div class="cc-pl-panel">` +
    `<header class="cc-pl-panel-head"><span class="cc-pl-panel-num">${def.order}</span><h2>${esc(def.label)}</h2></header>` +
    `<p class="cc-pl-blurb">${esc(def.blurb)}</p>` +
    `<div class="cc-pl-body">${bodyHtml(id, state, rollup, env, mounted, focus)}</div>` +
    `</div>`
  )
}

// ─── Template stage (5): the two-pane templating view ───

// A read-only, click-to-copy code block, rendered as the same code-editor surface as
// the main template editor: the darkest panel fill, a
// line-number gutter pinned on the left, and horizontal/vertical scroll so long
// snippets read and scroll the same everywhere. The raw snippet rides in data-copy
// (so it survives the canvas's innerHTML rebuilds and copies verbatim); the visible
// body is syntax-highlighted by the shared editor tokenizer, or escaped plain text if
// the editor bundle isn't present yet.
function codeBlockHtml(code: string): string {
  const raw = String(code)
  const body = window.CCEditor && window.CCEditor.highlight ? window.CCEditor.highlight(raw) : esc(raw)
  const lineCount = raw.split('\n').length
  let gutter = ''
  for (let n = 1; n <= lineCount; n++) gutter += `<span>${n}</span>`
  return (
    `<div class="cc-pl-sig-code" role="button" tabindex="0" aria-label="Copy code to clipboard" data-copy='${attr(raw)}'>` +
    `<div class="cc-pl-sig-code-scroll">` +
    `<div class="cc-pl-sig-code-gutter" aria-hidden="true">${gutter}</div>` +
    `<pre class="cc-pl-sig-code-body">${body}</pre>` +
    `</div>` +
    `<span class="cc-pl-sig-code-flash">Copied</span></div>`
  )
}

// The active signal's detail, filling the message card in the middle of the Signals
// row: its own group glyph + title, the prose message, and either a copyable
// fix-snippet (the guidance rides in its comments) or the prose hint. One signal
// shows at a time — the carets flanking the card page between them.
function activeSignalHtml(i: CCIssue): string {
  const CV = window.CCValidation
  const glyph = CV ? CV.icon(i.icon) : ''
  // Top region: the prose message (glyph + title + text, and the hint when there's no
  // snippet). When the signal carries a fix-snippet, it renders below as a code-editor
  // region filling the bottom of the card — the two-part split the design draws.
  let prose = `<div class="cc-pl-sig-prose">${esc(i.message)}</div>`
  if (!i.code && i.hint) prose += `<div class="cc-pl-sig-hint">${esc(i.hint)}</div>`
  const msg =
    `<div class="cc-pl-sig-msg">` +
    `<div class="cc-pl-sig-head"><span class="cc-pl-sig-glyph" aria-hidden="true">${glyph}</span>` +
    `<span class="cc-pl-sig-title">${esc(i.title || i.message)}</span></div>` +
    prose +
    `</div>`
  return i.code ? msg + codeBlockHtml(i.code) : msg
}

// Frame the template + its signals as one paste-ready blob for an agent: the
// verbatim template file, then each signal as a checklist line, closing with what
// to do with it.
function buildAgentBlob(text: string, result: CCResult | null): string {
  const lines: string[] = []
  lines.push('# Code Connect template — repair request')
  lines.push('')
  lines.push('Below is a Code Connect template file followed by the signals our')
  lines.push('validator raised against it. Rewrite the template so every signal is')
  lines.push('resolved, and return only the corrected template file.')
  lines.push('')
  lines.push('## Template file')
  lines.push('')
  lines.push('```tsx')
  lines.push(text.replace(/\s+$/, ''))
  lines.push('```')
  lines.push('')
  const issues = (result && result.issues) || []
  if (!issues.length) {
    lines.push('## Signals')
    lines.push('')
    lines.push('No signals — this template reads clean.')
  } else {
    const s = (result && result.summary) || ({} as CCSummary)
    const counts: string[] = []
    if (s.errors) counts.push(s.errors + ' error' + (s.errors === 1 ? '' : 's'))
    if (s.comments) counts.push(s.comments + ' comment' + (s.comments === 1 ? '' : 's'))
    lines.push('## Signals' + (counts.length ? ' (' + counts.join(', ') + ')' : ''))
    lines.push('')
    issues.forEach((i) => {
      lines.push('- [' + (i.level || 'comment').toUpperCase() + '] ' + i.message)
      if (i.hint) lines.push('  - fix: ' + i.hint)
    })
  }
  lines.push('')
  return lines.join('\n')
}

// Clipboard write with a legacy fallback: navigator.clipboard is preferred but can
// be unavailable/rejected inside the plugin iframe, so fall back to a hidden
// textarea + execCommand. Reports success/failure through the callback.
function copyToClipboard(str: string, done: (ok: boolean) => void): void {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(str).then(
      () => done(true),
      () => done(legacyCopy(str)),
    )
    return
  }
  done(legacyCopy(str))
}
function legacyCopy(str: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = str
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return !!ok
  } catch {
    return false
  }
}

// Per-severity presentation for the config rows: a tinted glyph + a matching 12%
// tint of the same hue, both derived from the --pl-* status tokens (via color-mix)
// so the settings page retheme from the same knob-set as everything else.
const CC_SEV: Record<CCSeverity, { token: string; icon: string }> = {
  mute: { token: '--pl-done', icon: 'mode-mute' },
  comment: { token: '--pl-active', icon: 'mode-comment' },
  error: { token: '--pl-failed', icon: 'warning-octagon' },
}
// The click cycle, quietest → loudest.
const CC_CYCLE: CCSeverity[] = ['mute', 'comment', 'error']

// ─── Download package (Dev Mode publish fallback) ───
// The main thread gathers each scoped set's draft + contract (gatherDownloadPackage)
// and posts a DownloadPackage; assemblePackageEntries (../package) authors the
// surrounding CLI project (per-label config + README) and we ZIP it for download.
// The packaging logic lives in ../package so it can be unit-tested off-DOM.

// ─── Mount ───

export function mount(): void {
  const shell = document.getElementById('cc-pipeline-shell')
  const nav = document.getElementById('cc-pipeline-nav')
  const main = document.querySelector('#cc-pipeline-shell .cc-pl-main') as HTMLElement | null
  if (!shell || !nav || !main) return

  // Guard against a totally empty STAGES import (build wiring sanity).
  if (STAGES.length !== 7 && typeof console !== 'undefined') {
    console.warn('[cc-processor] expected 7 pipeline stages, got', STAGES.length)
  }

  let state: RunState = parseRunState('')
  let selected: StageId = STAGES[0].id
  // The user's severity config (JSON string), shipped with pipeline-state; the live
  // signals engine + the settings page resolve rules against it.
  let validationConfig = '{}'
  // The stage-1 environment config (file key + saved-secret booleans), shipped with
  // pipeline-state; the Environment view renders its fields from this.
  let env: EnvConfig = EMPTY_ENV
  // ── Scope view (stage 2) session state ──
  // The component sets currently *mounted* in the view: discovered from the file
  // (once the platform's ready) and augmented by the canvas selection. Sent whole
  // on every pipeline-state. Distinct from state.scope — the persisted subset
  // actually in the run. `scopeFocus` is the key the view highlights + scrolls to;
  // it follows the canvas selection (and a click/tab into a row).
  let mounted: ComponentRef[] = []
  let scopeFocus: string | null = null
  // Optimistic scope toggles awaiting confirmation: componentKey → desired scoped
  // value. A single click emits a burst of state messages (the toggle, plus the
  // reveal's selectionchange), and one can be generated on the main thread BEFORE
  // the toggle applies — a stale scope that would flip the row back for a frame.
  // Overriding reconcile with the pending value keeps the optimistic glyph sticky
  // until an authoritative message actually matches it (then the entry clears).
  const pendingScope = new Map<string, boolean>()
  // ── Per-component stage views (contract/transform/validate/publish) ──
  // Optimistic in-flight stage runs: a Set of `${stageId} ${componentKey}`
  // entries added the instant a row (or bulk) is clicked, so the row flips to
  // "Working…" this frame instead of after the round-trip. An entry clears when an
  // authoritative state reports that stage active (the main thread acknowledged the
  // run) or settled (done/failed/skipped) — see the pipeline-state handler.
  const pendingActive = new Set<string>()
  const activeKey = (id: StageId, key: string): string => id + ' ' + key
  // Transient per-field interaction state for the Environment view — the design's
  // credential lifecycle. Held in the mount
  // closure so it survives the pipeline-state re-render that follows a save:
  //   focus  → blue border (Authenticated)   validating → blue spinner (Validating)
  //   verified (REST checked this session) → blue ShieldCheck (Valid)
  //   error  → red border
  let envFocus: EnvFieldName | null = null
  let envValidating: EnvFieldName | null = null
  const envVerified = new Set<EnvFieldName>()
  const envError = new Set<EnvFieldName>()

  // ── Template-stage session state ──
  // The focused component whose template fills the view (one at a time); the
  // settings overlay flag; and the live editor handle + a cache of its text so a
  // re-render (which rebuilds Main's innerHTML) re-mounts without losing the draft.
  let templateFocus: string | null = null
  let configOpen = false
  // ── Contract stage (3) settings ──
  // The stored contract config (JSON: { defaults, overrides }), shipped with
  // pipeline-state; the overlay flag; and which scope it's editing — null for the
  // run-wide defaults, else a componentKey for that set's overrides. `contractCache`
  // holds the last-seen contract JSON per component (for the manual copy button), and
  // `pendingCopyKey` tracks a copy awaiting a lazy contract-content fetch.
  let contractConfig = '{}'
  let contractConfigOpen = false
  let contractConfigScope: string | null = null
  const contractCache: Record<string, string> = {}
  let pendingCopyKey: string | null = null
  // ── Contract accordion (stage 3 list) ──
  // Contracts render as single-row accordion cards: a
  // clean header (scroll + name · gear · copy · caret) that expands to reveal the
  // contract JSON in a read-only editor — the same CodeMirror surface template
  // files use. Single-open: `contractOpenKey` is the one expanded row (null = all
  // collapsed), `contractEditor` its mounted viewer.
  let contractOpenKey: string | null = null
  let contractEditor: CCEditorHandle | null = null
  let editor: CCEditorHandle | null = null
  let draftText = ''
  // The editor↔signals split set by the drag-to-resize handle, stored as the two grid
  // `fr` multipliers (their ratio is what matters). Null until the user drags, so the
  // CSS default (1:1, matching the design) holds; kept in the closure so the split
  // survives a re-render. Session-local — not persisted across reopens.
  let tplEditorFr: number | null = null
  let tplSignalsFr: number | null = null
  // Which signal is active — shown in the message card, centered in the Signal Nav.
  // Held across re-renders and clamped to the live issue list.
  let signalIndex = 0
  // Auto-save: the draft persists quietly in the background — no save button, no
  // toast (design note). A debounce timer plus the last-persisted text so we only
  // round-trip real changes; flushed on any navigation away from the draft.
  let autosaveTimer: number | null = null
  let lastSaved = ''
  // The latest structural Result for the editor, and whether a semantic pass is in
  // flight (shows a "resolving" hint under the signal list).
  let ccResult: CCResult | null = null
  let ccChecking = false
  // The in-flight semantic round-trip: reqId (stale-drop), the structural Result to
  // merge into, and the config to resolve severities with.
  let semReqId = 0
  let semTimer: number | null = null
  let pendingSem: { reqId: number; base: CCResult; cfg: unknown } | null = null

  const parsedConfig = (): unknown => {
    const CV = window.CCValidation
    if (!CV) return undefined
    try {
      return CV.parseConfig(validationConfig)
    } catch {
      return undefined
    }
  }

  // The scoped component keys, in scope order — the "template files" the switcher
  // and the [ / ] shortcuts cycle through.
  const templateKeys = (): string[] => state.scope.map((r) => r.componentKey)

  // Settle templateFocus onto a valid scoped key before painting.
  const resolveFocus = (): void => {
    const keys = templateKeys()
    if (templateFocus === null || keys.indexOf(templateFocus) === -1) {
      templateFocus = keys.length ? keys[0] : null
    }
  }

  // Enable/disable the Copy action (far right of the File Nav) from editor content.
  const syncCopy = (): void => {
    const text = editor ? editor.getValue() : draftText
    const copyBtn = document.getElementById('cc-pl-act-copy') as HTMLButtonElement | null
    if (copyBtn) copyBtn.disabled = !text.trim()
  }

  // ── Auto-save ──
  // The draft persists quietly in the background — there's no save button, and no
  // toast (design note: "it should just happen quietly and reliably"). doAutosave
  // is the reliable flush (also called before any navigation away from the draft);
  // scheduleAutosave debounces keystrokes onto it. We only round-trip a real change
  // (text differs from last persisted) and never while the stage is blocked.
  const doAutosave = (): void => {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
    if (!templateFocus) return
    const text = editor ? editor.getValue() : draftText
    const blocked = effectiveComponentStatus(state, templateFocus, 'template') === 'blocked'
    if (blocked || !text.trim() || text === lastSaved) return
    lastSaved = text
    post('run-autosave-draft', { componentKey: templateFocus, text })
  }
  const scheduleAutosave = (): void => {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      doAutosave()
    }, 700) as unknown as number
  }

  // Repaint the Signals row from the current structural/semantic result. Message and
  // pager are unified into one row: a prev caret card, the
  // active-signal message card in the middle, and a next caret card. Signals read one
  // at a time (in the engine's order — errors first, then by group, then source
  // position); the carets page between them and disable at the bounds.
  const renderSignalView = (): void => {
    syncCopy()
    const strip = document.getElementById('cc-pl-tpl-signals')
    if (!strip) return
    const CV = window.CCValidation
    const empty = editor ? !editor.getValue().trim() : !draftText.trim()
    const issues = (CV && ccResult && !empty && ccResult.issues) || []
    // Keep the active index inside the live list (a re-validation can shrink it).
    if (signalIndex > issues.length - 1) signalIndex = issues.length - 1
    if (signalIndex < 0) signalIndex = 0

    // ── Center message card ──
    let card: string
    if (!issues.length) {
      const msg = empty
        ? 'Signals appear here as you edit the template.'
        : ccChecking
          ? 'Resolving in Figma…'
          : 'No signals — this template reads clean.'
      card = `<div class="cc-pl-sig-blank">${esc(msg)}</div>`
    } else {
      card = activeSignalHtml(issues[signalIndex])
      if (ccChecking) card += `<div class="cc-pl-sig-checking">Resolving in Figma…</div>`
    }

    // ── Row — prev caret · message card · next caret ──
    const atFirst = !issues.length || signalIndex === 0
    const atLast = !issues.length || signalIndex === issues.length - 1
    strip.innerHTML =
      `<button type="button" class="cc-pl-sig-caret" data-sig-nav="prev" title="Previous signal" aria-label="Previous signal"${atFirst ? ' disabled' : ''}>${navPrev}</button>` +
      `<div class="cc-pl-tpl-active" id="cc-pl-tpl-active" role="status">${card}</div>` +
      `<button type="button" class="cc-pl-sig-caret" data-sig-nav="next" title="Next signal" aria-label="Next signal"${atLast ? ' disabled' : ''}>${navNext}</button>`
  }

  // Repaint the bottom File Nav bar in place: the filename
  // fills the left (any-length name truncates with an ellipsis so it never shoves the
  // controls around), a fixed center group pages the files (first/prev/next/last), and
  // Copy sits on the right — dividers set the three sections apart. Rebuilt on its own
  // so an autosave-driven state refresh can update the filename/paging without tearing
  // down the live editor above it. (The checks-settings gear moved to the Validate
  // step, where tuning signals belongs — this view is for editing, not configuring.)
  const renderFileNav = (): void => {
    const bar = document.getElementById('cc-pl-tpl-files')
    if (!bar) return
    resolveFocus()
    const keys = templateKeys()
    const idx = templateFocus ? keys.indexOf(templateFocus) : -1
    const ref = state.scope.find((r) => r.componentKey === templateFocus)
    const name = ref ? ref.name : '—'
    const atFirst = idx <= 0
    const atLast = idx < 0 || idx >= keys.length - 1
    const hasText = !!(editor ? editor.getValue() : draftText).trim()
    bar.innerHTML =
      `<span class="cc-pl-tpl-files-name" title="${attr(name)}"><span class="cc-pl-tpl-files-glyph" aria-hidden="true">${fileTs}</span><span class="cc-pl-tpl-files-label">${esc(name)}</span></span>` +
      `<span class="cc-pl-tpl-files-div" aria-hidden="true"></span>` +
      `<div class="cc-pl-tpl-files-mid">` +
      `<button type="button" class="cc-pl-tpl-files-nav" data-file-nav="first" title="First file" aria-label="First file"${atFirst ? ' disabled' : ''}>${navFirst}</button>` +
      `<button type="button" class="cc-pl-tpl-files-nav" data-file-nav="prev" title="Previous file ( [ )" aria-label="Previous file"${atFirst ? ' disabled' : ''}>${navPrev}</button>` +
      `<button type="button" class="cc-pl-tpl-files-nav" data-file-nav="next" title="Next file ( ] )" aria-label="Next file"${atLast ? ' disabled' : ''}>${navNext}</button>` +
      `<button type="button" class="cc-pl-tpl-files-nav" data-file-nav="last" title="Last file" aria-label="Last file"${atLast ? ' disabled' : ''}>${navLast}</button>` +
      `</div>` +
      `<span class="cc-pl-tpl-files-div" aria-hidden="true"></span>` +
      `<button type="button" class="cc-pl-tpl-files-slot" id="cc-pl-act-copy" title="Copy template &amp; signals for an agent" aria-label="Copy template and signals"${hasText ? '' : ' disabled'}>${copyGlyph}</button>`
  }

  // Validate the editor now (structural, local) and kick off the debounced semantic
  // pass, then repaint the signal view.
  const validateNow = (): void => {
    const CV = window.CCValidation
    const text = editor ? editor.getValue() : draftText
    if (!text.trim() || !CV) {
      ccResult = null
      ccChecking = false
      pendingSem = null
      if (semTimer !== null) clearTimeout(semTimer)
      renderSignalView()
      return
    }
    const cfg = parsedConfig()
    ccResult = CV.validate(text, cfg)
    ccChecking = !!ccResult.nodeId
    renderSignalView()
    if (semTimer !== null) clearTimeout(semTimer)
    if (!ccResult.nodeId) {
      ccChecking = false
      pendingSem = null
      return
    }
    const nodeId = ccResult.nodeId
    const base = ccResult
    semTimer = setTimeout(() => {
      semTimer = null
      const reqId = ++semReqId
      pendingSem = { reqId, base, cfg }
      post('validate-semantic', { nodeId, reqId })
    }, 250) as unknown as number
  }

  // Mount the CodeMirror editor into the freshly-rendered host, seeding from the
  // text cache so edits survive a re-render. Falls back to a textarea if the editor
  // bundle isn't present.
  const mountTemplateEditor = (): void => {
    const host = document.getElementById('cc-pl-tpl-edit')
    if (!host) {
      editor = null
      return
    }
    const CE = window.CCEditor
    if (!CE) {
      host.innerHTML = `<textarea id="cc-pl-tpl-textarea" class="cc-pl-tpl-textarea" placeholder="Paste a Code Connect template file…">${esc(draftText)}</textarea>`
      const ta = document.getElementById('cc-pl-tpl-textarea') as HTMLTextAreaElement | null
      if (ta)
        ta.addEventListener('input', () => {
          draftText = ta.value
          validateNow()
          scheduleAutosave()
        })
      editor = null
      validateNow()
      return
    }
    editor = CE.create(host, {
      doc: draftText,
      placeholder: 'Paste or write a Code Connect template file…',
      onChange: (value: string) => {
        draftText = value
        validateNow()
        scheduleAutosave()
      },
      onEscape: () => {
        doAutosave()
        post('close')
      },
    })
    validateNow()
  }

  // Wire the drag-to-resize handle between the editor and the signals row. Both
  // rows are flexible (grid `fr`); dragging the handle rewrites
  // their two `fr` multipliers so the split follows the pointer and holds its ratio as
  // the window resizes. ArrowUp/Down nudge the split for keyboard users
  // (role="separator").
  //
  // The move/up half of the gesture rides on `window` (capture phase), NOT the handle:
  // `setPointerCapture` is unreliable inside the plugin iframe — once the pointer slides
  // over the CodeMirror editor or a signal card, capture drops and the captured element
  // stops seeing `pointermove`/`pointerup`, so the drag freezes or never releases. We
  // instead attach the listeners globally on pointerdown and tear them down on release,
  // so the gesture is tracked no matter what the pointer is over. Because they live on
  // `window` (not the handle), they still fire and self-remove even if a background
  // re-render swaps the handle element mid-drag.
  const mountResizeHandle = (): void => {
    const tpl = document.querySelector('#cc-pipeline-shell .cc-pl-tpl') as HTMLElement | null
    const handle = document.getElementById('cc-pl-tpl-resize')
    const editorEl = tpl ? (tpl.querySelector('.cc-pl-tpl-editor') as HTMLElement | null) : null
    const signalsEl = document.getElementById('cc-pl-tpl-signals')
    if (!tpl || !handle || !editorEl || !signalsEl) return
    const MIN_ED = 96
    const MIN_SIG = 128
    // Reapply the stored split so a re-render keeps what the user dragged. The vars
    // carry the full `fr` value (e.g. "300fr") — grid maxes the two flexible rows
    // against each other by ratio.
    if (tplEditorFr !== null && tplSignalsFr !== null) {
      tpl.style.setProperty('--cc-tpl-ed', tplEditorFr + 'fr')
      tpl.style.setProperty('--cc-tpl-sig', tplSignalsFr + 'fr')
    }
    // Commit an absolute editor height (clamped) as the new fr split.
    const applySplit = (editorPx: number, total: number): void => {
      const ed = Math.max(MIN_ED, Math.min(total - MIN_SIG, editorPx))
      tplEditorFr = ed
      tplSignalsFr = total - ed
      tpl.style.setProperty('--cc-tpl-ed', tplEditorFr + 'fr')
      tpl.style.setProperty('--cc-tpl-sig', tplSignalsFr + 'fr')
    }
    let startY = 0
    let startEd = 0
    let total = 0
    const onMove = (e: PointerEvent): void => {
      applySplit(startEd + (e.clientY - startY), total)
      e.preventDefault()
    }
    const endDrag = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
      handle.classList.remove('is-dragging')
      document.body.classList.remove('cc-pl-resizing')
    }
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      startY = e.clientY
      startEd = editorEl.offsetHeight
      total = startEd + signalsEl.offsetHeight
      handle.classList.add('is-dragging')
      document.body.classList.add('cc-pl-resizing')
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', endDrag, true)
      window.addEventListener('pointercancel', endDrag, true)
      e.preventDefault()
    })
    handle.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const ed = editorEl.offsetHeight
      const sum = ed + signalsEl.offsetHeight
      applySplit(ed + (e.key === 'ArrowDown' ? 24 : -24), sum)
      e.preventDefault()
    })
  }

  // The full-pane templating view for the focused component (gating handled first).
  // A vertical stack: the editor (the dominant card, with a
  // line-number gutter), the Signals row — one row that unifies the active-signal
  // message with its pager: prev caret · message card · next caret — and the bottom
  // File Nav that pages between template files. The signal row / file bar are painted
  // by their own render fns so a background state refresh can update them without
  // remounting the editor.
  const templateMainHtml = (): string => {
    if (!state.platform.ready) {
      return panelShell('Add a file key in step 1 first.')
    }
    if (state.scope.length === 0) {
      return panelShell('Scope some component sets (step 2) first.')
    }
    resolveFocus()
    return (
      `<div class="cc-pl-tpl">` +
      `<div class="cc-pl-tpl-editor">` +
      `<div class="cc-pl-tpl-edit" id="cc-pl-tpl-edit"></div>` +
      `</div>` +
      `<div class="cc-pl-tpl-resize" id="cc-pl-tpl-resize" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="Drag to resize the editor and signals" title="Drag to resize"></div>` +
      `<div class="cc-pl-tpl-signals" id="cc-pl-tpl-signals"></div>` +
      `<div class="cc-pl-tpl-files" id="cc-pl-tpl-files"></div>` +
      `</div>`
    )
  }

  // A minimal panel wrapper for the template stage's gating messages, matching the
  // other stages' header + blurb.
  const panelShell = (message: string): string => {
    const def = stageDef('template')
    return (
      `<div class="cc-pl-panel">` +
      `<header class="cc-pl-panel-head"><span class="cc-pl-panel-num">${def.order}</span><h2>${esc(def.label)}</h2></header>` +
      `<p class="cc-pl-blurb">${esc(def.blurb)}</p>` +
      `<div class="cc-pl-body"><p class="cc-pl-msg">${esc(message)}</p></div>` +
      `</div>`
    )
  }

  // ── Settings / config overlay ──
  const configMainHtml = (): string =>
    `<div class="cc-pl-cfg">` +
    `<div class="cc-pl-cfg-card">` +
    `<div class="cc-pl-cfg-rail">` +
    `<button type="button" class="cc-pl-cfg-back" id="cc-pl-cfg-back" title="Back" aria-label="Back to template">${arrowLeft}</button>` +
    `<span class="cc-pl-cfg-glyph" aria-hidden="true">${faders}</span>` +
    `</div>` +
    `<div class="cc-pl-cfg-main">` +
    `<div class="cc-pl-cfg-body" id="cc-pl-cfg-body"></div>` +
    `<div class="cc-pl-cfg-foot" id="cc-pl-cfg-foot" hidden>` +
    `<button type="button" class="cc-pl-cfg-reset" id="cc-pl-cfg-reset">Reset all to defaults</button>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`

  // Paint one row per rule, in registry order, reflecting the current config.
  const renderConfig = (): void => {
    const CV = window.CCValidation
    const body = document.getElementById('cc-pl-cfg-body')
    if (!CV || !body) return
    const cfg = parsedConfig()
    let html = ''
    CV.RULE_IDS.forEach((id) => {
      const def = CV.RULES[id]
      const sev = CV.effectiveSeverity(id, cfg)
      const s = CC_SEV[sev] || CC_SEV.mute
      const style = `color: var(${s.token}); background: color-mix(in srgb, var(${s.token}) 12%, transparent);`
      html += field({
        body: 'button',
        signal: `<span class="cc-pl-cfg-sev-box" style="${style}">${CV.icon(s.icon)}</span>`,
        main: fieldLines(def.title, def.hint),
        bodyCls: 'cc-pl-cfg-rule',
        bodyAttrs: `type="button" data-rule="${esc(id)}"`,
      })
    })
    body.innerHTML = html
    // The persisted config only holds deviations, so any key means the user has
    // moved a rule off its shipped default — that's when reset is meaningful.
    const foot = document.getElementById('cc-pl-cfg-foot')
    if (foot) {
      let hasOverride = false
      try {
        hasOverride = Object.keys(JSON.parse(validationConfig || '{}')).length > 0
      } catch {
        hasOverride = false
      }
      ;(foot as HTMLElement).hidden = !hasOverride
    }
  }

  // ── Contract settings (stage 3) ──
  // The overlay reuses the config card shell (.cc-pl-cfg-*) but drives a richer set
  // of controls: contract-field toggles, add/remove lists (skills, source paths) and
  // a prompt textarea. It edits the run-wide defaults, or one component's overrides.

  const parsedContractConfig = (): { defaults: Record<string, unknown>; overrides: Record<string, Record<string, unknown>> } => {
    try {
      const o = JSON.parse(contractConfig || '{}')
      return { defaults: (o && o.defaults) || {}, overrides: (o && o.overrides) || {} }
    } catch {
      return { defaults: {}, overrides: {} }
    }
  }

  // The effective config for the current scope: shipped defaults, then the run-wide
  // defaults, then (in component scope) that component's overrides — later wins.
  const effectiveContract = (): ContractCfg => {
    const { defaults, overrides } = parsedContractConfig()
    const base = { ...CONTRACT_DEFAULTS, ...defaults }
    if (!contractConfigScope) return base as ContractCfg
    return { ...base, ...(overrides[contractConfigScope] || {}) } as ContractCfg
  }

  // In component scope, whether a field deviates from the inherited baseline (i.e.
  // it's actually recorded as an override). Global scope never shows "overridden".
  const contractOverridden = (field: string): boolean => {
    if (!contractConfigScope) return false
    const { overrides } = parsedContractConfig()
    return Object.prototype.hasOwnProperty.call(overrides[contractConfigScope] || {}, field)
  }

  const eqCfg = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

  // Persist a single field. Writes into the run-wide defaults or the scoped override,
  // and prunes any value that matches its inherited baseline so the blob stays a
  // minimal deviations map (and "overridden" stays honest, and Reset is meaningful).
  const setContractField = (field: string, value: unknown): void => {
    const { defaults, overrides } = parsedContractConfig()
    if (contractConfigScope) {
      const base = { ...CONTRACT_DEFAULTS, ...defaults } as Record<string, unknown>
      const ov = { ...(overrides[contractConfigScope] || {}) }
      if (eqCfg(value, base[field])) delete ov[field]
      else ov[field] = value
      if (Object.keys(ov).length) overrides[contractConfigScope] = ov
      else delete overrides[contractConfigScope]
    } else {
      if (eqCfg(value, (CONTRACT_DEFAULTS as Record<string, unknown>)[field])) delete defaults[field]
      else defaults[field] = value
    }
    contractConfig = JSON.stringify({ defaults, overrides })
    post('set-contract-config', { config: contractConfig })
  }

  const addContractListItem = (field: string, raw: string): void => {
    const value = (raw || '').trim()
    if (!value) return
    const list = (effectiveContract() as Record<string, unknown>)[field]
    const next = Array.isArray(list) ? list.slice() : []
    next.push(value)
    setContractField(field, next)
    renderContractConfig()
    const input = document.getElementById('cc-ct-add-' + field) as HTMLInputElement | null
    if (input) input.focus()
  }

  const removeContractListItem = (field: string, index: number): void => {
    const list = (effectiveContract() as Record<string, unknown>)[field]
    const next = Array.isArray(list) ? list.slice() : []
    if (index < 0 || index >= next.length) return
    next.splice(index, 1)
    setContractField(field, next)
    renderContractConfig()
  }

  const resetContractConfig = (): void => {
    const { defaults, overrides } = parsedContractConfig()
    if (contractConfigScope) delete overrides[contractConfigScope]
    else for (const k of Object.keys(defaults)) delete defaults[k]
    contractConfig = JSON.stringify({ defaults, overrides })
    post('set-contract-config', { config: contractConfig })
    renderContractConfig()
  }

  const contractConfigMainHtml = (): string =>
    `<div class="cc-pl-cfg">` +
    `<div class="cc-pl-cfg-card">` +
    `<div class="cc-pl-cfg-rail">` +
    `<button type="button" class="cc-pl-cfg-back" id="cc-pl-ct-back" title="Back" aria-label="Back to contracts">${arrowLeft}</button>` +
    `<span class="cc-pl-cfg-glyph" aria-hidden="true">${gear}</span>` +
    `</div>` +
    `<div class="cc-pl-cfg-main">` +
    `<div class="cc-pl-cfg-body" id="cc-pl-ct-body"></div>` +
    `<div class="cc-pl-cfg-foot" id="cc-pl-ct-foot" hidden>` +
    `<button type="button" class="cc-pl-cfg-reset" id="cc-pl-ct-reset"></button>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`

  // One add/remove list (skills, source paths): a row per item with a trash button,
  // then a trailing add row (input + plus). data-ct-remove / data-ct-add drive it.
  const contractListHtml = (name: string, items: string[], placeholder: string): string => {
    let html = ''
    items.forEach((it, i) => {
      html += field({
        main: fieldText(it, true),
        actions: `<button type="button" class="cc-field-iconbtn is-trash" data-ct-remove="${name}" data-index="${i}" title="Remove" aria-label="Remove">${trash}</button>`,
        bodyCls: 'cc-field-input',
      })
    })
    html += field({
      main: `<input class="cc-field-inputel" id="cc-ct-add-${name}" type="text" autocomplete="off" spellcheck="false" placeholder="${attr(placeholder)}" />`,
      actions: `<button type="button" class="cc-field-iconbtn is-save" data-ct-add="${name}" title="Add" aria-label="Add">${plus}</button>`,
      bodyCls: 'cc-field-input',
    })
    return html
  }

  // Paint the overlay body for the current scope, then wire the text inputs (which
  // aren't click-driven, so they can't ride the delegated handler).
  const renderContractConfig = (): void => {
    const body = document.getElementById('cc-pl-ct-body')
    if (!body) return
    const eff = effectiveContract() as Record<string, unknown>
    const badge = (f: string): string => (contractOverridden(f) ? ' <span class="cc-pl-ct-badge">Overridden</span>' : '')

    const scopeName = contractConfigScope
      ? state.scope.find((r) => r.componentKey === contractConfigScope)?.name || 'This component'
      : ''
    let html = contractConfigScope
      ? `<p class="cc-pl-ct-scope"><strong>${esc(scopeName)}</strong> — overrides the defaults for this contract</p>`
      : `<p class="cc-pl-ct-scope"><strong>Defaults</strong> — applied to every contract</p>`

    html += `<p class="cc-pl-note"><strong>Contract fields</strong> <span class="cc-field-opt">— fetched from Figma</span></p>`
    CONTRACT_TOGGLES.forEach((t) => {
      const on = !!eff[t.field]
      const token = on ? '--pl-done' : '--pl-text-3'
      const glyph = on ? checkCircle : circle
      const style = `color: var(${token}); background: color-mix(in srgb, var(${token}) 12%, transparent);`
      html += field({
        body: 'button',
        signal: `<span class="cc-pl-cfg-sev-box" style="${style}">${glyph}</span>`,
        main: fieldLines(t.title, t.hint),
        actions: contractOverridden(t.field) ? `<span class="cc-pl-ct-badge">Overridden</span>` : '',
        bodyCls: 'cc-pl-ct-toggle',
        bodyAttrs: `type="button" data-ct-toggle="${t.field}"`,
      })
    })

    html += `<p class="cc-pl-note"><strong>Skills</strong> <span class="cc-field-opt">— embedded for the consuming agent</span>${badge('skills')}</p>`
    html += contractListHtml('skills', Array.isArray(eff.skills) ? (eff.skills as string[]) : [], 'Add a skill…')

    html += `<p class="cc-pl-note"><strong>Prompt</strong> <span class="cc-field-opt">— the task handed to the agent</span>${badge('prompt')}</p>`
    html += field({
      main: `<textarea class="cc-field-inputel cc-ct-textarea" id="cc-ct-prompt" rows="3" placeholder="Describe the task the agent should perform with this contract…">${esc(String(eff.prompt || ''))}</textarea>`,
      bodyCls: 'cc-field-input',
    })

    html += `<p class="cc-pl-note"><strong>Source paths</strong> <span class="cc-field-opt">— files the agent should reference</span>${badge('sourcePaths')}</p>`
    html += contractListHtml('sourcePaths', Array.isArray(eff.sourcePaths) ? (eff.sourcePaths as string[]) : [], 'Add a source path…')

    body.innerHTML = html

    // Foot: Reset shows only when the current scope carries a deviation.
    const foot = document.getElementById('cc-pl-ct-foot')
    const reset = document.getElementById('cc-pl-ct-reset')
    if (foot && reset) {
      const { defaults, overrides } = parsedContractConfig()
      const has = contractConfigScope
        ? Object.keys(overrides[contractConfigScope] || {}).length > 0
        : Object.keys(defaults).length > 0
      reset.textContent = contractConfigScope ? 'Reset this component to defaults' : 'Reset all to defaults'
      ;(foot as HTMLElement).hidden = !has
    }

    // The prompt textarea persists on a debounce (and on blur) without re-rendering,
    // so typing never loses the caret. The add-inputs commit on Enter.
    const prompt = document.getElementById('cc-ct-prompt') as HTMLTextAreaElement | null
    if (prompt) {
      let t: number | null = null
      prompt.addEventListener('input', () => {
        if (t !== null) clearTimeout(t)
        t = setTimeout(() => {
          t = null
          setContractField('prompt', prompt.value)
        }, 400) as unknown as number
      })
      prompt.addEventListener('blur', () => {
        if (t !== null) {
          clearTimeout(t)
          t = null
        }
        setContractField('prompt', prompt.value)
      })
    }
    ;['skills', 'sourcePaths'].forEach((f) => {
      const input = document.getElementById('cc-ct-add-' + f) as HTMLInputElement | null
      if (input)
        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          addContractListItem(f, input.value)
        })
    })
  }

  // Flash the copy pill on a contract row (both auto-clip and manual copy land here).
  const flashCopyPill = (key: string): void => {
    for (const el of Array.from(main.querySelectorAll('[data-action="copy-contract"]')) as HTMLElement[]) {
      if (el.getAttribute('data-key') !== key) continue
      el.classList.add('is-copied')
      setTimeout(() => el.classList.remove('is-copied'), 1100)
    }
  }

  // Manual copy: use the cached JSON if we have it, else lazily fetch it first.
  const copyContract = (key: string): void => {
    const cached = contractCache[key]
    if (cached) {
      copyToClipboard(cached, (ok) => {
        if (ok) flashCopyPill(key)
        post('notify', { message: ok ? 'Contract copied to the clipboard' : 'Couldn’t copy the contract', error: !ok })
      })
      return
    }
    pendingCopyKey = key
    post('run-get-contract', { componentKey: key })
  }

  // ── Contract accordion (stage 3 list) ──
  // The contract stage's effective per-row status, with the optimistic in-flight
  // overlay applied (a just-clicked Generate reads `active` before the main thread
  // answers), matching how syncStage overlays the other component stages.
  const contractStatus = (key: string): FieldState => {
    let st = effectiveComponentStatus(state, key, 'contract') as FieldState
    if (pendingActive.has(activeKey('contract', key)) && st !== 'blocked' && st !== 'skipped') st = 'active'
    return st
  }

  // One accordion card: a single-row header (the contract glyph · name · gear · copy ·
  // caret) plus, when open, the expanded pane (the read-only editor once built). The
  // leading contract glyph is itself the generate/regenerate control — no contract yet →
  // generate, one exists → regenerate; it also carries the status tint, so it reads as
  // both signal and action. The name and caret toggle; gear and copy are their own
  // controls.
  const contractItemHtml = (key: string, name: string, st: FieldState): string => {
    const k = esc(key)
    const open = contractOpenKey === key
    const inFlight = st === 'active'
    const glyph = inFlight ? globe : contractGlyph
    const glyphCls = inFlight ? 'cc-pl-ct-glyph is-connecting' : 'cc-pl-ct-glyph'
    // In-flight → not actionable (the run is already going); done → regenerate.
    const genLabel = st === 'done' ? 'Regenerate contract' : 'Generate contract'
    const genDisabled = inFlight ? ' disabled' : ''
    const copyDisabled = st === 'done' ? '' : ' disabled'
    // Two layers: the resting status glyph, and the refresh (circular arrows) that
    // takes over on hover — a shape signal that the click (re)generates, beyond tint.
    const glyphInner =
      `<span class="cc-pl-ct-glyph-mark" aria-hidden="true">${glyph}</span>` +
      `<span class="cc-pl-ct-glyph-refresh" aria-hidden="true">${arrowsClockwise}</span>`
    const head =
      `<div class="cc-pl-ct-head">` +
      `<button type="button" class="${glyphCls}" data-action="generate-contract" data-key="${k}" title="${genLabel}" aria-label="${genLabel}"${genDisabled}>${glyphInner}</button>` +
      `<button type="button" class="cc-pl-ct-open" data-action="toggle-contract" data-key="${k}" aria-expanded="${open ? 'true' : 'false'}">` +
      `<span class="cc-pl-ct-name">${esc(name)}</span>` +
      `</button>` +
      `<div class="cc-pl-ct-actions">` +
      `<button type="button" class="cc-pl-ct-icon" data-action="tune-contract" data-key="${k}" title="Configure this contract" aria-label="Configure this contract">${gear}</button>` +
      `<button type="button" class="cc-pl-ct-icon" data-action="copy-contract" data-key="${k}" title="Copy contract" aria-label="Copy contract"${copyDisabled}>${copyGlyph}</button>` +
      `<button type="button" class="cc-pl-ct-icon cc-pl-ct-caret" data-action="toggle-contract" data-key="${k}" title="${open ? 'Collapse' : 'Expand'}" aria-label="${open ? 'Collapse' : 'Expand'}">${caretDisclose}</button>` +
      `</div>` +
      `</div>`
    const pane = open ? contractPaneHtml(key, st) : ''
    return `<li class="cc-pl-ct-item" data-key="${k}" data-state="${st}" data-open="${open ? 'true' : 'false'}">${head}${pane}</li>`
  }

  // The expanded pane below a card's header. Done → the editor host (filled by
  // mountContractEditor). Generating → a working note. Failed → the last error.
  // Otherwise a hint pointing back at the contract glyph, which is the generate control.
  const contractPaneHtml = (key: string, st: FieldState): string => {
    if (st === 'done') {
      return `<div class="cc-pl-ct-pane"><div class="cc-pl-ct-edit" id="cc-pl-ct-edit"></div></div>`
    }
    if (st === 'active') {
      return `<div class="cc-pl-ct-pane"><p class="cc-pl-ct-empty">Generating…</p></div>`
    }
    const err = state.components[key]?.errors?.contract
    if (st === 'failed' && err) {
      return `<div class="cc-pl-ct-pane"><p class="cc-pl-ct-err">${esc(err)}</p></div>`
    }
    return `<div class="cc-pl-ct-pane"><p class="cc-pl-ct-empty">No contract yet — use the contract icon to generate one.</p></div>`
  }

  // Mount the read-only viewer into the open row's editor host, seeding from the
  // cache. If the contract isn't cached yet (e.g. built in a prior session), fetch
  // it — contract-content fills it on arrival. Falls back to a <pre> without the
  // editor bundle.
  const mountContractEditor = (key: string): void => {
    const host = document.getElementById('cc-pl-ct-edit')
    if (!host) {
      contractEditor = null
      return
    }
    const json = contractCache[key] || ''
    const CE = window.CCEditor
    if (CE) {
      contractEditor = CE.create(host, {
        doc: json,
        readOnly: true,
        placeholder: 'Generating contract…',
      })
    } else {
      host.innerHTML = `<pre class="cc-pl-ct-fallback">${esc(json)}</pre>`
      contractEditor = null
    }
    if (!json) post('run-get-contract', { componentKey: key })
  }

  // Push fresh JSON into the open viewer (contract-generated / contract-content).
  const setContractEditorValue = (json: string): void => {
    if (contractEditor) contractEditor.setValue(json)
    else {
      const pre = main.querySelector('.cc-pl-ct-fallback') as HTMLElement | null
      if (pre) pre.textContent = json
    }
  }

  // Paint the accordion into #cc-pl-ct-list and wire the open row's editor. Keeps
  // `contractOpenKey` honest against the live scope (a set that left scope can't
  // stay expanded). Called on full render of the contract stage.
  const renderContractList = (): void => {
    const list = document.getElementById('cc-pl-ct-list')
    if (!list) {
      contractEditor = null
      return
    }
    if (contractOpenKey && !state.scope.some((r) => r.componentKey === contractOpenKey)) {
      contractOpenKey = null
    }
    list.innerHTML = state.scope.map((r) => contractItemHtml(r.componentKey, r.name, contractStatus(r.componentKey))).join('')
    contractEditor = null
    if (contractOpenKey) mountContractEditor(contractOpenKey)
  }

  // Toggle a card open/closed (single-open). Opening one collapses any other, so at
  // most one editor is ever mounted.
  const toggleContract = (key: string): void => {
    contractOpenKey = contractOpenKey === key ? null : key
    renderContractList()
  }

  // Move the focused template by ±1 (wraps), request its draft, and re-render.
  // Used by the [ / ] shortcuts; the File Nav's first/prev/next/last clamp instead.
  const cycleFocus = (delta: number): void => {
    const keys = templateKeys()
    if (keys.length < 2) return
    resolveFocus()
    const cur = templateFocus ? keys.indexOf(templateFocus) : 0
    const next = (cur + delta + keys.length) % keys.length
    focusTemplate(keys[next])
  }
  // Focus a file by absolute index (clamped, no wrap) — the File Nav paging.
  const focusIndex = (i: number): void => {
    const keys = templateKeys()
    if (!keys.length) return
    const clamped = Math.max(0, Math.min(keys.length - 1, i))
    if (keys[clamped] === templateFocus) return
    focusTemplate(keys[clamped])
  }
  const focusTemplate = (key: string): void => {
    doAutosave() // flush the outgoing draft before we drop its cache
    templateFocus = key
    editor = null
    draftText = ''
    lastSaved = ''
    signalIndex = 0
    ccResult = null
    if (semTimer !== null) clearTimeout(semTimer)
    pendingSem = null
    render()
    post('run-get-draft', { componentKey: key })
  }

  // ── Environment (stage 1) field controller ──
  // Ports the old standalone Configure form onto the Field primitive: per-field
  // save/clear, masked secrets, a file-URL→key collapse, and a live REST-PLANT
  // check before saving. Listeners re-attach after every render (main is rebuilt).

  const setEnvFoot = (message: string, level?: 'ok' | 'warn' | 'err'): void => {
    const foot = document.getElementById('cc-pl-env-foot')
    if (!foot) return
    foot.textContent = message || ''
    foot.className = 'cc-pl-env-foot' + (level ? ' is-' + level : '')
  }

  // The file input's current value — validateRestPlant scopes to it when present.
  const envInput = (name: EnvFieldName): HTMLInputElement | null =>
    document.getElementById('cc-env-' + name) as HTMLInputElement | null

  // A live REST check (mirrors the old iframe helper). PLANTs are plan/file-scoped,
  // so hitting the file endpoint is the strongest signal; fall back to /v1/me with
  // no file key. Network failures warn but never block saving.
  const validateRestPlant = async (
    token: string,
  ): Promise<{ ok: boolean; level: 'ok' | 'warn' | 'err'; message: string }> => {
    token = (token || '').trim()
    if (!token) return { ok: false, level: 'err', message: 'Enter a PLANT first' }
    const fileEl = envInput('file')
    const fileKey = extractFileKey(fileEl ? fileEl.value : '')
    try {
      if (fileKey) {
        const r = await fetch('https://api.figma.com/v1/files/' + encodeURIComponent(fileKey) + '?depth=1', {
          headers: { 'X-FIGMA-TOKEN': token },
        })
        if (r.ok) return { ok: true, level: 'ok', message: 'PLANT verified against this file' }
        if (r.status === 403) return { ok: false, level: 'err', message: 'PLANT rejected for this file — check its plan/scope' }
        if (r.status === 404) return { ok: false, level: 'err', message: 'No file found for that key' }
        if (r.status === 429) return { ok: true, level: 'warn', message: 'Rate-limited — could not fully verify' }
        return { ok: true, level: 'warn', message: 'Unexpected response (' + r.status + ') — not verified' }
      }
      const m = await fetch('https://api.figma.com/v1/me', { headers: { 'X-FIGMA-TOKEN': token } })
      if (m.ok) return { ok: true, level: 'ok', message: 'Token valid' }
      if (m.status === 403) return { ok: true, level: 'ok', message: 'Looks like a PLANT (accepted)' }
      return { ok: false, level: 'err', message: 'Token rejected (HTTP ' + m.status + ')' }
    } catch {
      return { ok: true, level: 'warn', message: 'Could not reach Figma to verify — will save without validation' }
    }
  }

  // Reflect a field's live state onto its Field — the credential lifecycle from the
  // design: signal glyph, semantic border, trailing save/trash button, and a saved
  // secret's dotted placeholder. Border/tint follow one precedence:
  //   error (red) > validating|verified (blue) > focus (blue) > file-valid (green).
  const renderEnvField = (name: EnvFieldName): void => {
    const input = envInput(name)
    const fieldEl = document.querySelector(`.cc-field-input[data-field="${name}"]`) as HTMLElement | null
    if (!input || !fieldEl) return
    const btn = fieldEl.querySelector('.cc-field-iconbtn') as HTMLButtonElement | null
    const glyph = fieldEl.querySelector('.cc-field-signal') as HTMLElement | null
    const raw = input.value.trim()
    const saved = envSaved(env, name)
    const def = ENV_FIELDS[name]
    const isSecret = name !== 'file'

    const focused = envFocus === name
    const validating = envValidating === name
    const verified = envVerified.has(name)
    const error = envError.has(name)

    // A recognised value for the trailing control: a valid file key, or any text
    // in a secret (masked). Secrets advertise a stored value with dotted text.
    let hasNew: boolean
    let fileValid = false
    if (name === 'file') {
      const key = extractFileKey(raw)
      fileValid = !!key
      hasNew = fileValid && key !== env.fileKey
    } else {
      hasNew = raw.length > 0
      input.placeholder = saved && raw === '' ? '••••••••••' : def.label
    }

    // Signal glyph — the credential lifecycle state. A checkmark is
    // an honest claim: it appears only once a value is actually saved/verified, never
    // for a value that's merely typed or being edited (`hasNew`). In flight → globe.
    let glyphSvg: string
    if (validating) glyphSvg = globe // connecting/validating → globe pulses blue
    else if (name === 'file') glyphSvg = fileValid && !hasNew ? checkCircle : circle
    else if (verified) glyphSvg = checkCircle // REST PLANT checked against the API this session — same "present/good" mark as every field
    else if (saved && !hasNew) glyphSvg = checkCircle // a credential is stored (not a fresh, unsaved edit)
    else glyphSvg = circle
    if (glyph) {
      glyph.innerHTML = glyphSvg
      glyph.classList.toggle('is-connecting', validating)
    }

    // Semantic border + glyph tint — one data-state, by precedence.
    let fieldState: FieldState = 'resting'
    if (error) fieldState = 'error'
    else if (validating || verified) fieldState = 'notice'
    else if (focused) fieldState = 'focused'
    else if (name === 'file' && fileValid) fieldState = 'done'
    if (fieldState === 'resting') fieldEl.removeAttribute('data-state')
    else fieldEl.dataset.state = fieldState

    // Trailing control: a lone trash to clear a stored value. There is no save
    // button — the blur auto-saves — so the slot only carries the trash, and only
    // when something is actually stored and not being freshly re-typed.
    if (btn) {
      const showTrash = saved && !hasNew && !validating
      btn.hidden = !showTrash
    }
  }

  // The trailing trash was clicked: clear the stored value. The main thread
  // re-streams state, which re-renders the field into its empty resting state.
  const clearEnvField = (name: EnvFieldName): void => {
    post('clear-field', { field: name })
  }

  // Auto-save a field's current value: validate (file/rest) then persist. Called on
  // blur and Enter — there is no save button. The main thread re-streams state, which
  // re-renders the field into its saved/masked resting state.
  const saveEnvField = async (name: EnvFieldName): Promise<void> => {
    const input = envInput(name)
    const fieldEl = document.querySelector(`.cc-field-input[data-field="${name}"]`) as HTMLElement | null
    if (!input || !fieldEl) return
    const raw = input.value.trim()
    if (!raw) return
    if (name === 'file') {
      const key = extractFileKey(raw)
      if (!key) {
        envError.add('file')
        renderEnvField('file')
        setEnvFoot("Couldn't find a file key in that.", 'err')
        return
      }
      input.value = key // collapse a pasted URL down to just the key
      post('save-field', { field: 'file', value: key })
      input.blur()
    } else if (name === 'rest') {
      // Verify the REST PLANT live before saving — the design's Validating→Valid
      // (spinner→shield); a hiccup warns but still saves, a rejection keeps the
      // field editable and turns it red.
      envValidating = 'rest'
      envError.delete('rest')
      renderEnvField('rest')
      setEnvFoot('Validating REST PLANT…')
      const res = await validateRestPlant(raw)
      envValidating = null
      if (!res.ok) {
        envError.add('rest')
        renderEnvField('rest')
        setEnvFoot(res.message, res.level)
        return
      }
      envVerified.add('rest') // → blue ShieldCheck when the save round-trips back
      setEnvFoot(res.level === 'warn' ? res.message : res.message, res.level)
      post('save-field', { field: 'rest', value: raw })
      input.blur()
    } else {
      // CLI PLANT — save as-is by name.
      post('save-field', { field: name, value: raw })
      input.blur()
    }
  }

  // Attach the environment field listeners to the freshly-rendered platform view.
  const mountEnvFields = (): void => {
    ENV_FIELD_ORDER.forEach((name) => {
      const input = envInput(name)
      const fieldEl = document.querySelector(`.cc-field-input[data-field="${name}"]`) as HTMLElement | null
      if (!input || !fieldEl) return
      const btn = fieldEl.querySelector('.cc-field-iconbtn') as HTMLButtonElement | null
      input.addEventListener('focus', () => {
        envFocus = name
        renderEnvField(name)
      })
      input.addEventListener('input', () => {
        // Editing clears a prior error / verification — the credential changed.
        envError.delete(name)
        envVerified.delete(name)
        setEnvFoot('')
        renderEnvField(name)
      })
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void saveEnvField(name)
        } else if (e.key === 'Escape') {
          post('close')
        }
      })
      input.addEventListener('blur', () => {
        if (envFocus === name) envFocus = null
        if (name === 'file') {
          const key = extractFileKey(input.value)
          if (key && input.value.trim() !== key) input.value = key
        }
        // Auto-save on blur when there's a fresh value; otherwise just repaint the
        // resting state. For the file key that means a valid key different from the
        // stored one (a bad paste stays editable, no error thrown on blur); for a
        // secret, any typed text (the field rests empty once saved, so anything the
        // user types is a new credential to persist).
        const raw = input.value.trim()
        const hasFresh =
          name === 'file'
            ? !!extractFileKey(raw) && extractFileKey(raw) !== env.fileKey
            : raw.length > 0
        if (hasFresh) void saveEnvField(name)
        else renderEnvField(name)
      })
      if (btn) btn.addEventListener('click', () => clearEnvField(name))
      renderEnvField(name)
    })
  }

  // ── Backend connection controller ──
  // The OAuth Connect/Disconnect surface lives on the Backend card's header glyph (see
  // transformerBlockHtml). The PKCE + relay + poll dance runs here in the iframe
  // (connectTransformer); the resulting auth code goes to the main thread to redeem
  // (transformer-exchange).
  let tfConnecting = false
  // The Backend header glyph runs the same in-flight state machine as every field:
  // while the OAuth handshake is in flight, it becomes the globe pulsing blue; on
  // settle it reverts to the person mark (connected) or the broken chain (not). A full
  // re-render follows a real state change, so this just paints the transient
  // in-flight/cancel/error moments in between.
  const renderTfConnecting = (on: boolean): void => {
    const sig = document.getElementById('cc-pl-backend-conn-glyph')
    if (!sig) return
    if (on) {
      sig.innerHTML = globe
      sig.classList.add('is-connecting')
      sig.setAttribute('data-state', 'notice')
    } else {
      sig.classList.remove('is-connecting')
      sig.innerHTML = env.transformer.connected ? userCircleCheck : linkSimpleBreak
      if (env.transformer.connected) sig.setAttribute('data-state', 'done')
      else sig.removeAttribute('data-state')
    }
  }
  // Connect is a two-hop handshake. First we ask main to resolve the backend's
  // public client_id (registering once if needed) — the iframe can't hold that
  // lifecycle. Main replies with 'transformer-connect-config', which runs doConnect.
  const runConnect = (): void => {
    if (tfConnecting) return
    // No backend set yet — expand the card and point at the URL field rather than
    // firing a doomed request. baseUrl is empty by default (no hardcoded backend).
    if (!env.transformer.profile.connector.baseUrl) {
      const card = document.getElementById('cc-pl-backend')
      if (card) card.setAttribute('data-open', 'true')
      const urlEl = document.getElementById('cc-tf-baseurl') as HTMLInputElement | null
      if (urlEl) urlEl.focus()
      setEnvFoot('Add a Backend URL first, then Connect.', 'err')
      return
    }
    tfConnecting = true
    renderTfConnecting(true)
    setEnvFoot('Preparing sign-in…')
    post('transformer-connect-begin')
  }

  const doConnect = async (clientId: string): Promise<void> => {
    // Bind the just-resolved client_id onto the profile the iframe runs with; only
    // the relay /start needs it (main's token exchange is a public client).
    const profile: BackendProfile = {
      ...env.transformer.profile,
      connector: {
        ...env.transformer.profile.connector,
        oauth: { ...env.transformer.profile.connector.oauth, clientId },
      },
    }
    try {
      const grant = await connectTransformer(profile, {
        openTab: (url: string) => {
          // The plugin iframe is sandboxed, so let the main thread open the consent
          // page in the user's real browser (figma.openExternal) — that also keeps
          // the relay's first-party cookie in a normal browser context.
          post('transformer-open', { url })
        },
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        onStatus: (s) =>
          setEnvFoot(
            s === 'connecting'
              ? 'Preparing sign-in…'
              : s === 'authorizing'
                ? 'Waiting for you to finish signing in…'
                : 'Finishing sign-in…',
          ),
      })
      setEnvFoot('Finishing sign-in…')
      // Hand the code to the main thread to redeem for tokens (it owns the secrets).
      post('transformer-exchange', grant)
    } catch (e) {
      setEnvFoot(e instanceof Error ? e.message : String(e), 'err')
      renderTfConnecting(false)
    } finally {
      tfConnecting = false
    }
  }

  const saveTransformerProfile = (): void => {
    const cur = env.transformer.profile
    const val = (id: string): string => {
      const el = document.getElementById(id) as HTMLInputElement | null
      return el ? el.value.trim() : ''
    }
    // Empty field ⇒ keep the current value (normalizeProfile fills a truly-empty path
    // from the default backend profile main-side). Connection and feature routes are
    // rebuilt independently so editing a route never disturbs the connector.
    const baseUrl = val('cc-tf-baseurl')
    const runPath = val('cc-tf-run-path')
    const slug = val('cc-tf-slug')
    const publishPath = val('cc-tf-publish-path')
    const profile: BackendProfile = {
      ...cur,
      connector: {
        ...cur.connector,
        baseUrl: baseUrl || cur.connector.baseUrl,
      },
      features: {
        ...cur.features,
        run: {
          ...cur.features.run,
          path: runPath || cur.features.run.path,
          slug: slug || cur.features.run.slug,
        },
        publish: {
          ...cur.features.publish,
          path: publishPath || cur.features.publish.path,
        },
      },
    }
    post('transformer-save-profile', { profile })
  }

  const mountTransformerBlock = (): void => {
    const nodes = main.querySelectorAll('[data-tf]')
    for (let i = 0; i < nodes.length; i++) {
      const btn = nodes[i] as HTMLElement
      const act = btn.getAttribute('data-tf')
      btn.addEventListener('click', () => {
        if (act === 'connect') runConnect()
        else if (act === 'disconnect') post('transformer-disconnect')
        else if (act === 'collapse') {
          // Fold/expand the Backend card's body (its route subfields).
          const card = document.getElementById('cc-pl-backend')
          if (!card) return
          const open = card.getAttribute('data-open') !== 'false'
          card.setAttribute('data-open', open ? 'false' : 'true')
          const toggle = card.querySelector('.cc-pl-backend-toggle')
          if (toggle) toggle.setAttribute('aria-expanded', open ? 'false' : 'true')
        }
      })
    }

    // Route subfields auto-save: repaint the state glyph as you type, persist on
    // change (blur/Enter) — no floppy. normalizeProfile fills a blanked route from
    // the default backend profile main-side, so clearing a field is safe.
    const ROUTE_FIELDS: [string, 'baseUrl' | 'runPath' | 'slug' | 'publishPath'][] = [
      ['cc-tf-baseurl', 'baseUrl'],
      ['cc-tf-run-path', 'runPath'],
      ['cc-tf-slug', 'slug'],
      ['cc-tf-publish-path', 'publishPath'],
    ]
    ROUTE_FIELDS.forEach(([id, key]) => {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (!el) return
      el.addEventListener('input', () => {
        const sig = el.closest('.cc-field')?.querySelector('.cc-field-signal')
        if (sig) sig.innerHTML = routeSignalFor[key](el.value)
      })
      el.addEventListener('change', () => saveTransformerProfile())
      el.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          el.blur()
        } else if (e.key === 'Escape') {
          post('close')
        }
      })
    })
  }

  // Reconcile the Scope rows against the current state + focus WITHOUT rebuilding
  // Main — patches in place, adds/removes/reorders as the mounted set changes, and
  // preserves focus. Returns false when there's no list to sync (wrong stage / empty
  // state), so the caller falls back to a full render. This is the same path the
  // optimistic click uses, so a gesture and its confirming state message agree.
  const syncScope = (): boolean => {
    const listEl = main.querySelector('.cc-fields') as HTMLElement | null
    if (!listEl) return false
    const models = scopeRowModels(mounted, state.scope, scopeFocus)
    // Apply any unconfirmed optimistic toggles on top of the authoritative state.
    if (pendingScope.size) {
      for (const m of models) {
        const want = pendingScope.get(m.key)
        if (want !== undefined) m.scoped = want
      }
    }
    syncList(listEl, models, buildScopeRow, patchScopeRow)
    return true
  }

  // Realtime soft-refresh for the wired per-component stages (contract/transform/
  // validate/publish), mirroring syncScope: reconcile the rows in place instead of
  // rebuilding Main, so the burst of state messages a run emits settles smoothly
  // and the optimistic in-flight state a click already applied is confirmed, not
  // torn down. Returns false (→ full render) when the list isn't mounted.
  const syncStage = (): boolean => {
    if (!isComponentStage(selected)) return false
    const listEl = main.querySelector('.cc-fields') as HTMLElement | null
    if (!listEl) return false
    // The optimistic in-flight overlay for THIS stage.
    const activeKeys = new Set<string>()
    const prefix = selected + ' '
    for (const pk of pendingActive) if (pk.slice(0, prefix.length) === prefix) activeKeys.add(pk.slice(prefix.length))
    syncList(listEl, stageRowModels(selected, state, activeKeys), buildStageRow)
    return true
  }

  // Realtime soft-refresh for the contract accordion: patch each card's header
  // (status tint, in-flight glyph, copy-enabled) in place so a background state
  // burst doesn't tear down the open row's editor (losing its scroll). Bails to a
  // full render (returns false) when the scoped set changed, or when the OPEN row's
  // own status changed — that flips its expanded pane (CTA ⇄ editor), which a header
  // patch can't do.
  const syncContractHeaders = (): boolean => {
    const list = document.getElementById('cc-pl-ct-list')
    if (!list) return false
    const keys = state.scope.map((r) => r.componentKey)
    const items = Array.from(list.querySelectorAll('.cc-pl-ct-item')) as HTMLElement[]
    if (items.length !== keys.length || items.some((el, i) => el.getAttribute('data-key') !== keys[i])) return false
    for (const el of items) {
      const key = el.getAttribute('data-key') || ''
      const st = contractStatus(key)
      if (contractOpenKey === key && el.getAttribute('data-state') !== st) return false
      el.setAttribute('data-state', st)
      const glyphEl = el.querySelector('.cc-pl-ct-glyph') as HTMLButtonElement | null
      if (glyphEl) {
        const inFlight = st === 'active'
        glyphEl.classList.toggle('is-connecting', inFlight)
        // Patch only the status mark so the hover refresh layer survives the burst.
        const markEl = glyphEl.querySelector('.cc-pl-ct-glyph-mark') as HTMLElement | null
        if (markEl) markEl.innerHTML = inFlight ? globe : contractGlyph
        // In-flight → not actionable; done → the action becomes "regenerate".
        glyphEl.disabled = inFlight
        const genLabel = st === 'done' ? 'Regenerate contract' : 'Generate contract'
        glyphEl.title = genLabel
        glyphEl.setAttribute('aria-label', genLabel)
      }
      const copyBtn = el.querySelector('[data-action="copy-contract"]') as HTMLButtonElement | null
      if (copyBtn) copyBtn.disabled = st !== 'done'
    }
    return true
  }

  // Optimistic stage run: mark the row in flight and reconcile THIS frame (the row
  // flips to "Working…" with no round-trip), then post the intent. The main thread
  // acknowledges by re-streaming the stage as active, which retires the pending
  // entry; the eventual done/failed reconciles the same way. Rows are only ever
  // buttons when actionable, so the posted run is guaranteed to run — no stuck
  // "Working…".
  const runStage = (id: StageId, key: string | null, type: string): void => {
    if (key) {
      pendingActive.add(activeKey(id, key))
      syncStage()
    }
    post(type, key ? { componentKey: key } : undefined)
  }

  const render = (): void => {
    const rollups = computeRollup(state)
    nav.innerHTML = navHtml(rollups, selected)
    if (selected === 'template' && configOpen) {
      main.classList.add('cc-pl-main-fill')
      main.innerHTML = configMainHtml()
      renderConfig()
      editor = null
      return
    }
    if (selected === 'template') {
      main.classList.add('cc-pl-main-fill')
      main.innerHTML = templateMainHtml()
      // Only wire the editor/signals when the full view actually rendered (not the
      // gating panel). mountTemplateEditor runs validateNow → renderSignalView; the
      // File Nav is painted separately since it lives outside the editor card.
      if (document.getElementById('cc-pl-tpl-edit')) {
        mountTemplateEditor()
        mountResizeHandle()
        renderFileNav()
      } else editor = null
      return
    }
    if (selected === 'contract' && contractConfigOpen) {
      main.classList.add('cc-pl-main-fill')
      main.innerHTML = contractConfigMainHtml()
      renderContractConfig()
      editor = null
      return
    }
    main.classList.remove('cc-pl-main-fill')
    main.innerHTML = mainHtml(selected, state, rollups, env, mounted, scopeFocus)
    editor = null
    // The Contract view (stage 3) fills its accordion + mounts the open row's viewer.
    if (selected === 'contract') renderContractList()
    // The Environment view (stage 1) carries live inputs — wire them each render.
    if (selected === 'platform') {
      mountEnvFields()
      mountTransformerBlock()
    }
    // The Scope view (stage 2) keeps the focused set in view as the canvas selection
    // moves it around.
    if (selected === 'scope') {
      const el = main.querySelector('.cc-field.is-focused') as HTMLElement | null
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data && event.data.pluginMessage
    if (!msg) return
    if (msg.type === 'pipeline-state') {
      // Take over the window from the legacy menu-command views.
      const legacy = document.getElementById('plugin-root')
      if (legacy) legacy.style.display = 'none'
      document.body.classList.add('cc-pipeline-active')
      shell.style.display = 'flex'
      if (typeof msg.config === 'string') validationConfig = msg.config
      if (typeof msg.contractConfig === 'string') contractConfig = msg.contractConfig
      if (msg.env && typeof msg.env === 'object') env = msg.env as EnvConfig
      // In Dev Mode the plugin is docked into the right panel (not a free-floating,
      // drag-resizable window), so the resize affordance on the right/bottom edges is
      // moot — flag the body so its blue edge glow is suppressed (see ui.html).
      document.body.classList.toggle('cc-dev-mode', env.editorType === 'dev')
      // The Scope view's mounted sets + canvas selection ride along on every state.
      // Selection drives the focused row (canvas → plugin focus).
      if (Array.isArray(msg.mounted)) mounted = msg.mounted as ComponentRef[]
      if (Array.isArray(msg.selection) && msg.selection.length) scopeFocus = String(msg.selection[0])
      // Soft-refresh guard: an autosave marks the stage done, which cascades and
      // re-streams state. If we're actively editing a template and the scoped set
      // is unchanged, a full render would tear down the live editor (losing cursor
      // + focus) and re-fetch the draft (clobbering unsent keystrokes). Instead we
      // repaint only the projections that can change — the Nav rail's status glyphs
      // and the File Nav bar — and leave the editor untouched.
      const prevKeys = templateKeys().join(' ')
      const wasEditing =
        selected === 'template' && !configOpen && !!editor && !!document.getElementById('cc-pl-tpl-edit')
      // The transformer completing flips the focused file's transform stage to
      // `done` and writes a fresh draft on the main thread. Capture the prior
      // status (against the outgoing state) so the soft-refresh path below can
      // tell "my autosave echoed back" from "new template content just landed".
      const prevTransform =
        wasEditing && templateFocus ? effectiveComponentStatus(state, templateFocus, 'transform') : null
      state = parseRunState(msg.state)
      if (wasEditing && templateKeys().join(' ') === prevKeys) {
        nav.innerHTML = navHtml(computeRollup(state), selected)
        renderFileNav()
        // Drafts are kept out of pipeline-state (fetched lazily via run-get-draft),
        // so the soft-refresh alone can't surface a just-generated template. When
        // the focused file's transform has newly completed, pull its draft into the
        // live editor — otherwise a single mounted file stays blank until you
        // switch files (which is the only other path that re-fetches).
        if (
          templateFocus &&
          prevTransform !== 'done' &&
          effectiveComponentStatus(state, templateFocus, 'transform') === 'done'
        ) {
          post('run-get-draft', { componentKey: templateFocus })
        }
        return
      }
      // Retire optimistic toggles this authoritative state now confirms (its scope
      // membership matches the desired value); any still-unconfirmed ones stay
      // sticky through syncScope, so a stale in-between message can't flip a row back.
      if (pendingScope.size) {
        const scoped = new Set(state.scope.map((r) => r.componentKey))
        for (const [k, want] of Array.from(pendingScope)) {
          if (scoped.has(k) === want) pendingScope.delete(k)
        }
      }
      // Scope soft-refresh: reconcile the rows in place (scoped check + focus edge,
      // plus any newly mounted/unmounted set) instead of rebuilding Main — so the
      // rapid burst of state messages a single click produces settles smoothly, and
      // the optimistic update the click already applied is confirmed, not torn down.
      if (selected === 'scope' && syncScope()) {
        nav.innerHTML = navHtml(computeRollup(state), selected)
        const el = main.querySelector('.cc-field.is-focused') as HTMLElement | null
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        return
      }
      // Retire optimistic in-flight entries this authoritative state accounts for:
      // the run is acknowledged (active) or finished (done/failed/skipped). One
      // still pending (its stage unchanged from the pre-click state) stays sticky
      // through syncStage, so an unrelated in-between message can't flip the row
      // back to a clickable CTA for a frame.
      if (pendingActive.size) {
        for (const pk of Array.from(pendingActive)) {
          const sep = pk.indexOf(' ')
          const id = pk.slice(0, sep) as StageId
          const st = effectiveComponentStatus(state, pk.slice(sep + 1), id)
          if (st === 'active' || st === 'done' || st === 'failed' || st === 'skipped') pendingActive.delete(pk)
        }
      }
      // Contract settings overlay open: a background state burst must not tear down
      // the overlay (and clobber a half-typed prompt). Just refresh the Nav glyphs.
      if (selected === 'contract' && contractConfigOpen) {
        nav.innerHTML = navHtml(computeRollup(state), selected)
        return
      }
      // Contract accordion: reconcile card headers in place so a burst doesn't
      // remount the open row's viewer; full render only when the set/open-row status
      // changed (syncContractHeaders returns false).
      if (selected === 'contract') {
        nav.innerHTML = navHtml(computeRollup(state), selected)
        if (!syncContractHeaders()) render()
        return
      }
      // Per-component stage soft-refresh: reconcile rows in place so the run's
      // state burst settles without tearing down Main (or the row the user just
      // clicked). Full render is the fallback when the list isn't mountable.
      if (isComponentStage(selected) && syncStage()) {
        nav.innerHTML = navHtml(computeRollup(state), selected)
        return
      }
      render()
      // If the template view is open, request the focused component's draft.
      if (selected === 'template' && !configOpen && templateFocus && document.getElementById('cc-pl-tpl-edit')) {
        post('run-get-draft', { componentKey: templateFocus })
      }
    } else if (msg.type === 'draft-content' && msg.componentKey === templateFocus) {
      // The reply to run-get-draft: load the stored paste / transformer output as
      // editable code.
      draftText = typeof msg.text === 'string' ? msg.text : ''
      if (editor) {
        editor.setValue(draftText)
        // setValue fires onChange → validateNow; nothing more to do.
      } else {
        const ta = document.getElementById('cc-pl-tpl-textarea') as HTMLTextAreaElement | null
        if (ta) ta.value = draftText
        validateNow()
      }
    } else if (msg.type === 'contract-generated' && typeof msg.componentKey === 'string') {
      // A contract just finished building on the main thread. Auto-clip it silently
      // (the generate toast already fired) — the iframe is the only context that can
      // reach navigator.clipboard — and flash the row's Copy pill so the clip is
      // visible. Cache the JSON so a later manual copy skips the round-trip.
      const key = String(msg.componentKey)
      const json = typeof msg.contract === 'string' ? msg.contract : ''
      if (json) {
        contractCache[key] = json
        // If this row's card is open, fill its viewer with the fresh contract.
        if (contractOpenKey === key) setContractEditorValue(json)
        copyToClipboard(json, (ok) => {
          if (ok) flashCopyPill(key)
        })
      }
    } else if (msg.type === 'contract-content' && typeof msg.componentKey === 'string') {
      // The reply to run-get-contract (manual copy of a contract not in the cache —
      // e.g. generated in a prior session). Cache it, and if a copy is pending for
      // this key, complete the clip now and confirm it.
      const key = String(msg.componentKey)
      const json = typeof msg.contract === 'string' ? msg.contract : ''
      if (json) contractCache[key] = json
      // Fill the open viewer (this is also the reply to mountContractEditor's fetch).
      if (json && contractOpenKey === key) setContractEditorValue(json)
      if (pendingCopyKey === key) {
        pendingCopyKey = null
        if (json) {
          copyToClipboard(json, (ok) => {
            if (ok) flashCopyPill(key)
            post('notify', { message: ok ? 'Copied the contract to your clipboard' : 'Couldn’t copy the contract', error: !ok })
          })
        } else {
          post('notify', { message: 'No contract yet — generate it first', error: true })
        }
      }
    } else if (msg.type === 'semantic-result') {
      // Fold the main-thread figma.* findings into the last structural result and
      // repaint the signals — unless a newer keystroke has superseded this reqId.
      if (!pendingSem || msg.reqId !== pendingSem.reqId) return
      const CV = window.CCValidation
      if (!CV) return
      const findings: CCSemanticFinding[] = Array.isArray(msg.findings) ? msg.findings : []
      ccResult = CV.mergeSemantic(pendingSem.base, findings, pendingSem.cfg)
      ccChecking = false
      pendingSem = null
      renderSignalView()
    } else if (msg.type === 'transformer-connect-config' && typeof msg.clientId === 'string') {
      // Main resolved the backend's public client_id (registered once). Run the
      // second hop of connect — the PKCE + relay + poll dance — with it.
      void doConnect(String(msg.clientId))
    } else if (msg.type === 'transformer-connected') {
      // Main redeemed the code (or we disconnected). The pipeline-state that rode
      // alongside already re-rendered the block; just settle the foot message.
      setEnvFoot(msg.account ? 'Connected as ' + String(msg.account) : '')
    } else if (msg.type === 'transformer-error') {
      // A begin/connect failure — reset the guard so the user can retry.
      tfConnecting = false
      renderTfConnecting(false)
      setEnvFoot(
        msg.denied
          ? 'That transformer’s origin isn’t allowed — add it to the manifest allowlist.'
          : 'Connect failed: ' + String(msg.message || 'unknown error'),
        'err',
      )
    } else if (msg.type === 'transformer-run-grant' && typeof msg.componentKey === 'string') {
      // Main minted a run grant — stream the transformer here (the iframe can read a
      // ReadableStream; the main-thread sandbox can't), showing partial output live
      // in the stage-5 editor when that component is focused, then report the result
      // back to main to persist.
      const grant: RunGrant = {
        componentKey: String(msg.componentKey),
        url: String(msg.url),
        token: String(msg.token),
        slug: String(msg.slug),
        response: msg.response === 'json' ? 'json' : 'stream',
        contract: msg.contract,
      }
      void streamTransformRun(grant, {
        onChunk: (text: string) => {
          // Live-fill the editor only when this component's template view is open.
          if (selected === 'template' && templateFocus === grant.componentKey && editor) {
            editor.setValue(text)
          }
        },
      }).then((res) => {
        post('transformer-run-result', {
          componentKey: grant.componentKey,
          ok: res.ok,
          file: res.file,
          message: res.error,
        })
      })
    } else if (msg.type === 'download-package' && msg.package) {
      // Main gathered the run's drafts + contracts — author the CLI project around
      // them, ZIP it, and trigger the browser download (the iframe is the only DOM
      // context that can reach disk).
      const pkg = msg.package as DownloadPackage
      try {
        const entries = assemblePackageEntries(pkg)
        const stamp = pkg.generatedAt.slice(0, 10) // YYYY-MM-DD
        downloadBytes(`code-connect-${stamp}.zip`, buildZip(entries))
        const n = pkg.components.length
        post('notify', { message: `Downloaded a Code Connect package (${n} template${n === 1 ? '' : 's'})` })
      } catch (e) {
        post('notify', { message: 'Couldn’t build the package: ' + (e instanceof Error ? e.message : String(e)), error: true })
      }
    }
  })

  // Selecting a step drives what renders in Main.
  nav.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null
    const btn = target && target.closest ? (target.closest('.cc-pl-step') as HTMLElement | null) : null
    if (!btn) return
    const id = btn.getAttribute('data-stage') as StageId | null
    if (!id || id === selected) return
    // Leaving the template stage: flush the draft so nothing typed is lost.
    if (selected === 'template') doAutosave()
    selected = id
    configOpen = false // leaving/entering a stage closes any open settings
    contractConfigOpen = false
    editor = null
    render()
    if (id === 'template') {
      // Entering the template stage: resolve the focus (first entry picks one)
      // and always pull the current persisted draft. A transformer run may have
      // rewritten it while we were on another stage, and render() rebuilds the
      // editor from the stale cached draftText — so refetch every entry, not just
      // the first, or a returning visit would show pre-generation content.
      resolveFocus()
      if (templateFocus && document.getElementById('cc-pl-tpl-edit')) post('run-get-draft', { componentKey: templateFocus })
    }
  })

  // Main's controls. Non-template stages post their stage actions; the template
  // view handles switcher / actions / config inline.
  main.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null
    if (!target || !target.closest) return

    // Copyable code block (delegated so it survives canvas rebuilds).
    const block = target.closest('.cc-pl-sig-code') as HTMLElement | null
    if (block) {
      copyCodeBlock(block)
      return
    }

    const btn = target.closest('[data-action], [data-file-nav], [data-sig-nav], [data-ct-toggle], [data-ct-remove], [data-ct-add], .cc-pl-cfg-rule, #cc-pl-cfg-back, #cc-pl-cfg-reset, #cc-pl-act-copy, #cc-pl-ct-settings, #cc-pl-ct-back, #cc-pl-ct-reset') as HTMLElement | null
    if (!btn || (btn as HTMLButtonElement).disabled) return

    // ── File Nav: page through the scoped template files (first/prev/next/last) ──
    const fileNav = btn.getAttribute('data-file-nav')
    if (fileNav) {
      const keys = templateKeys()
      resolveFocus()
      const cur = templateFocus ? keys.indexOf(templateFocus) : 0
      if (fileNav === 'first') focusIndex(0)
      else if (fileNav === 'prev') focusIndex(cur - 1)
      else if (fileNav === 'next') focusIndex(cur + 1)
      else if (fileNav === 'last') focusIndex(keys.length - 1)
      return
    }
    // ── Signal Nav: page the active signal with the flanking carets ──
    const sigNav = btn.getAttribute('data-sig-nav')
    if (sigNav) {
      signalIndex += sigNav === 'next' ? 1 : -1
      renderSignalView()
      return
    }
    // ── Config rule row: cycle its severity ──
    const rule = btn.closest('.cc-pl-cfg-rule') as HTMLElement | null
    if (rule) {
      const CV = window.CCValidation
      const id = rule.getAttribute('data-rule')
      if (!CV || !id) return
      const cfg = parsedConfig()
      const cur = CV.effectiveSeverity(id, cfg)
      const next = CC_CYCLE[(CC_CYCLE.indexOf(cur) + 1) % CC_CYCLE.length]
      const merged = { ...(cfg as Record<string, string>), [id]: next }
      validationConfig = CV.serializeConfig(merged)
      post('set-validation-config', { config: validationConfig })
      renderConfig()
      return
    }
    if (btn.id === 'cc-pl-cfg-reset') {
      const CV = window.CCValidation
      validationConfig = CV ? CV.serializeConfig({}) : '{}'
      post('set-validation-config', { config: validationConfig })
      renderConfig()
      return
    }
    if (btn.id === 'cc-pl-cfg-back') {
      configOpen = false
      render()
      if (templateFocus) post('run-get-draft', { componentKey: templateFocus })
      return
    }
    // ── Contract settings (stage 3) overlay ──
    if (btn.id === 'cc-pl-ct-settings') {
      contractConfigScope = null // the run-wide defaults
      contractConfigOpen = true
      render()
      return
    }
    if (btn.id === 'cc-pl-ct-back') {
      contractConfigOpen = false
      render()
      return
    }
    if (btn.id === 'cc-pl-ct-reset') {
      resetContractConfig()
      return
    }
    const ctToggle = btn.getAttribute('data-ct-toggle')
    if (ctToggle) {
      const eff = effectiveContract() as Record<string, unknown>
      setContractField(ctToggle, !eff[ctToggle])
      renderContractConfig()
      return
    }
    const ctRemove = btn.getAttribute('data-ct-remove')
    if (ctRemove) {
      removeContractListItem(ctRemove, parseInt(btn.getAttribute('data-index') || '-1', 10))
      return
    }
    const ctAdd = btn.getAttribute('data-ct-add')
    if (ctAdd) {
      const input = document.getElementById('cc-ct-add-' + ctAdd) as HTMLInputElement | null
      if (input) addContractListItem(ctAdd, input.value)
      return
    }
    // ── Action bar ──
    if (btn.id === 'cc-pl-act-copy') {
      const text = editor ? editor.getValue() : draftText
      if (!text.trim()) return
      const blob = buildAgentBlob(text, ccResult)
      copyToClipboard(blob, (ok) => {
        post('notify', {
          message: ok ? 'Copied template & signals to the clipboard' : 'Couldn’t copy to the clipboard',
          error: !ok,
        })
      })
      return
    }

    // ── Non-template stage actions ──
    const action = btn.getAttribute('data-action')
    const key = btn.getAttribute('data-key')
    if (action === 'scope-toggle' && key) {
      // Optimistic: flip scope in the local model and reconcile THIS frame, then tell
      // the main thread. The desired value is recorded in pendingScope so it stays
      // sticky until an authoritative message confirms it — no round-trip latency,
      // and no stale-message blink back to the old glyph.
      scopeFocus = key
      const want = !state.scope.some((r) => r.componentKey === key)
      pendingScope.set(key, want)
      // Keep the local state (and the Nav rollup) honest during the optimism.
      if (want) {
        const ref = mounted.find((r) => r.componentKey === key)
        if (ref) state.scope = [...state.scope, ref]
      } else {
        state.scope = state.scope.filter((r) => r.componentKey !== key)
      }
      syncScope()
      nav.innerHTML = navHtml(computeRollup(state), selected)
      post('run-scope-toggle', { componentKey: key })
    } else if (action === 'download-package') {
      // Run-level fallback publish — no component key; main gathers the whole run and
      // replies with 'download-package' for the iframe to ZIP + download.
      post('run-download-package')
    } else if (action === 'toggle-contract' && key) {
      // Expand/collapse the contract card (single-open); opening mounts its viewer.
      toggleContract(key)
    } else if (action === 'generate-contract' && key) {
      // Generate (or regenerate) from within the card. Keep the row open so the
      // result lands in view, and optimistically flip its header + pane to in-flight.
      contractOpenKey = key
      pendingActive.add(activeKey('contract', key))
      renderContractList()
      post('run-generate-contract', { componentKey: key })
    } else if (action === 'tune-contract' && key) {
      // Open the contract settings scoped to this component's overrides.
      contractConfigScope = key
      contractConfigOpen = true
      render()
    } else if (action === 'copy-contract' && key) copyContract(key)
    else if (action === 'transform') runStage('transform', key, 'run-transform')
    else if (action === 'validate-draft') runStage('validate', key, 'run-validate-draft')
    else if (action === 'publish-draft') runStage('publish', key, 'run-publish-draft')
  })

  // Focusing a Scope field reveals its set on the canvas (plugin → viewport) and
  // moves the row highlight right away — optimistically, via the same in-place sync,
  // so it never waits on the round-trip. Fires on click (the body is a button, so it
  // takes focus) and on Tab. The click handler above separately toggles scope; this
  // only moves focus + viewport, never scope, so the two gestures don't fight.
  main.addEventListener('focusin', (event: FocusEvent) => {
    const target = event.target as HTMLElement | null
    const btn = target && target.closest ? (target.closest('[data-action="scope-toggle"]') as HTMLElement | null) : null
    if (!btn) return
    const key = btn.getAttribute('data-key')
    const node = btn.getAttribute('data-node')
    if (key) {
      scopeFocus = key
      syncScope()
    }
    if (node) post('reveal-component', { nodeId: node })
  })

  // Copy a code block's raw snippet and briefly flash "Copied".
  const codeFlashTimers = new WeakMap<HTMLElement, number>()
  const copyCodeBlock = (block: HTMLElement): void => {
    const code = block.getAttribute('data-copy') || ''
    copyToClipboard(code, (ok) => {
      if (!ok) return
      block.classList.add('is-copied')
      const prev = codeFlashTimers.get(block)
      if (prev) clearTimeout(prev)
      codeFlashTimers.set(
        block,
        setTimeout(() => block.classList.remove('is-copied'), 1100) as unknown as number,
      )
    })
  }

  // Enter/Space copies a focused code block.
  main.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    const target = event.target as HTMLElement | null
    const block = target && target.closest ? (target.closest('.cc-pl-sig-code') as HTMLElement | null) : null
    if (!block) return
    event.preventDefault()
    copyCodeBlock(block)
  })

  // [ / ] cycle the focused template file — but only outside the editor and inputs,
  // so typing a bracket in the code still inserts one. Mirrors the File Nav's
  // prev/next carets for keyboard users.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (selected !== 'template' || configOpen) return
    if (event.key !== '[' && event.key !== ']') return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Don't hijack bracket entry inside the editor or any input/textarea.
    const active = document.activeElement as HTMLElement | null
    if (active && (active.closest('.cm-editor') || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
    event.preventDefault()
    cycleFocus(event.key === ']' ? 1 : -1)
  })

  // Last-chance flush: if the iframe is hidden or torn down while a template draft
  // is dirty, persist it before it's gone. Keeps auto-save reliable even when the
  // user closes the plugin mid-edit.
  window.addEventListener('pagehide', () => doAutosave())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') doAutosave()
  })

  parent.postMessage({ pluginMessage: { type: 'pipeline-ready' } }, '*')
}

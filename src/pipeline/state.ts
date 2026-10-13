// The persistent run-state model for the cc-processor pipeline.
//
// A "run" is scoped to a set of component sets (stage 2). Setup stages
// (platform, scope) are tracked once at the run level; the remaining stages
// (contract → transform → template → validate → publish) are tracked
// independently per component set. This whole object is serialized to a single
// root pluginData blob (`cc-processor:run`) by the main thread — see code.ts.
//
// Two rules define the data flow:
//   • Auto-invalidation — re-running a stage resets that component's downstream
//     stages to `pending` (see reRunComponentStage). Re-validating the platform
//     resets every component. This guarantees artifacts never outlive their
//     inputs (PLAN.md §3).
//   • Derived blocking — `blocked` is never stored. A pending stage is shown as
//     blocked whenever its upstream stage isn't yet cleared (see
//     effectiveComponentStatus). Storing only what actually happened keeps the
//     cascade a simple reset-to-pending.

import {
  STAGES,
  COMPONENT_STAGES,
  type StageId,
  downstreamComponentStages,
  upstreamComponentStage,
} from './stages'

// Stored statuses reflect only what has actually been attempted for a stage.
export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped'
// `blocked` is a derived, display-only status (see effectiveComponentStatus).
export type EffectiveStatus = StageStatus | 'blocked'

export interface ComponentRef {
  componentKey: string // stable identity — survives node move/rename
  nodeId: string // last-known node, for canvas focus
  name: string
}

export interface ComponentRunState {
  ref: ComponentRef
  stages: Partial<Record<StageId, StageStatus>> // missing → 'pending'
  errors?: Partial<Record<StageId, string>>
}

export interface PlatformState {
  ready: boolean
  validatedAt?: number
  message?: string
}

export interface RunState {
  version: number
  platform: PlatformState // stage 1
  scope: ComponentRef[] // stage 2
  components: Record<string, ComponentRunState> // keyed by componentKey
}

export const RUN_STATE_VERSION = 1

export function createRunState(): RunState {
  return { version: RUN_STATE_VERSION, platform: { ready: false }, scope: [], components: {} }
}

// A stage unblocks the next one when it's done or deliberately skipped (e.g. the
// optional transformer with no token configured).
export function isCleared(status: StageStatus | undefined): boolean {
  return status === 'done' || status === 'skipped'
}

export function componentStageStatus(c: ComponentRunState, stage: StageId): StageStatus {
  return c.stages[stage] ?? 'pending'
}

// ─── Mutations (all return a new RunState; inputs are never mutated) ───

// Stage 1. Re-validating the platform invalidates every component's progress,
// since all component work assumes the platform is current.
export function setPlatform(state: RunState, ready: boolean, opts?: { validatedAt?: number; message?: string }): RunState {
  const platform: PlatformState = { ready, validatedAt: opts?.validatedAt, message: opts?.message }
  const components: Record<string, ComponentRunState> = {}
  for (const [k, c] of Object.entries(state.components)) {
    components[k] = { ref: c.ref, stages: {} }
  }
  return { ...state, platform, components }
}

// Stage 2. Keeps existing progress for sets still in scope, refreshes their ref
// (name/nodeId may have changed), and drops records for sets no longer scoped.
export function setScope(state: RunState, refs: ComponentRef[]): RunState {
  const components: Record<string, ComponentRunState> = {}
  for (const ref of refs) {
    const existing = state.components[ref.componentKey]
    components[ref.componentKey] = existing ? { ...existing, ref } : { ref, stages: {} }
  }
  return { ...state, scope: refs.slice(), components }
}

export function setComponentStage(
  state: RunState,
  componentKey: string,
  stage: StageId,
  status: StageStatus,
  error?: string,
): RunState {
  const c = state.components[componentKey]
  if (!c) return state
  const stages = { ...c.stages, [stage]: status }
  const errors = { ...(c.errors ?? {}) }
  if (error) errors[stage] = error
  else delete errors[stage]
  const next: ComponentRunState = { ref: c.ref, stages, errors: Object.keys(errors).length ? errors : undefined }
  return { ...state, components: { ...state.components, [componentKey]: next } }
}

// Re-run a component stage: mark it active and reset every downstream component
// stage back to pending (the auto-invalidation cascade).
export function reRunComponentStage(state: RunState, componentKey: string, stage: StageId): RunState {
  const c = state.components[componentKey]
  if (!c) return state
  const stages = { ...c.stages, [stage]: 'active' as StageStatus }
  const errors = { ...(c.errors ?? {}) }
  delete errors[stage]
  for (const d of downstreamComponentStages(stage)) {
    stages[d] = 'pending'
    delete errors[d]
  }
  const next: ComponentRunState = { ref: c.ref, stages, errors: Object.keys(errors).length ? errors : undefined }
  return { ...state, components: { ...state.components, [componentKey]: next } }
}

// ─── Derivation ───

// The status to *display* for a component stage: `blocked` when it hasn't started
// and its upstream isn't cleared yet; otherwise the stored status.
export function effectiveComponentStatus(state: RunState, componentKey: string, stage: StageId): EffectiveStatus {
  const c = state.components[componentKey]
  if (!c) return 'blocked'
  const stored = componentStageStatus(c, stage)
  if (stored !== 'pending') return stored
  const up = upstreamComponentStage(stage)
  if (up === null) return state.platform.ready ? 'pending' : 'blocked'
  return isCleared(componentStageStatus(c, up)) ? 'pending' : 'blocked'
}

// ─── Rollup (drives the process rail) ───

export interface StageRollup {
  id: StageId
  order: number
  label: string
  icon: string
  scope: 'run' | 'component'
  status: EffectiveStatus
  counts: Record<EffectiveStatus, number> // per-component breakdown (zeros for run stages)
  total: number
}

function emptyCounts(): Record<EffectiveStatus, number> {
  return { pending: 0, active: 0, done: 0, failed: 0, skipped: 0, blocked: 0 }
}

// When components are in mixed states, the single rail icon surfaces the most
// attention-worthy status first: working > failing > (all cleared) > pending.
function aggregate(counts: Record<EffectiveStatus, number>, total: number): EffectiveStatus {
  if (total === 0) return 'pending'
  if (counts.active > 0) return 'active'
  if (counts.failed > 0) return 'failed'
  if (counts.done + counts.skipped === total) return counts.done > 0 ? 'done' : 'skipped'
  if (counts.blocked > 0 && counts.done === 0) return 'blocked'
  return 'pending'
}

export function computeRollup(state: RunState): StageRollup[] {
  return STAGES.map((def) => {
    const counts = emptyCounts()
    let status: EffectiveStatus
    let total = 0
    if (def.scope === 'run') {
      if (def.id === 'platform') {
        status = state.platform.ready ? 'done' : 'pending'
      } else {
        // scope
        if (!state.platform.ready) status = 'blocked'
        else status = state.scope.length > 0 ? 'done' : 'pending'
      }
    } else {
      total = state.scope.length
      for (const ref of state.scope) {
        const eff = effectiveComponentStatus(state, ref.componentKey, def.id)
        counts[eff] += 1
      }
      status = aggregate(counts, total)
    }
    return { id: def.id, order: def.order, label: def.label, icon: def.icon, scope: def.scope, status, counts, total }
  })
}

// ─── Persistence (tolerant of stale / hand-edited blobs) ───

export function serializeRunState(state: RunState): string {
  return JSON.stringify(state)
}

const VALID_STATUS = new Set<StageStatus>(['pending', 'active', 'done', 'failed', 'skipped'])

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined
}

function toRef(v: unknown): ComponentRef | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const componentKey = str(o.componentKey)
  if (!componentKey) return null
  return { componentKey, nodeId: str(o.nodeId) ?? '', name: str(o.name) ?? componentKey }
}

function toStages(v: unknown): Partial<Record<StageId, StageStatus>> {
  const out: Partial<Record<StageId, StageStatus>> = {}
  if (!v || typeof v !== 'object') return out
  for (const stage of COMPONENT_STAGES) {
    const s = (v as Record<string, unknown>)[stage]
    if (typeof s === 'string' && VALID_STATUS.has(s as StageStatus)) out[stage] = s as StageStatus
  }
  return out
}

// Per-stage error/finding strings (e.g. a validation failure summary) must
// round-trip so Main can surface `lastError`. Only kept for component stages.
function toErrors(v: unknown): Partial<Record<StageId, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Partial<Record<StageId, string>> = {}
  for (const stage of COMPONENT_STAGES) {
    const s = (v as Record<string, unknown>)[stage]
    if (typeof s === 'string' && s) out[stage] = s
  }
  return Object.keys(out).length ? out : undefined
}

export function parseRunState(raw: unknown): RunState {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    if (!raw) return createRunState()
    try {
      obj = JSON.parse(raw)
    } catch {
      return createRunState()
    }
  }
  if (!obj || typeof obj !== 'object') return createRunState()
  const o = obj as Record<string, unknown>

  const p = o.platform as Record<string, unknown> | undefined
  const platform: PlatformState = p
    ? { ready: !!p.ready, validatedAt: num(p.validatedAt), message: str(p.message) }
    : { ready: false }

  const scope: ComponentRef[] = Array.isArray(o.scope)
    ? (o.scope.map(toRef).filter(Boolean) as ComponentRef[])
    : []

  const rawComponents = (o.components && typeof o.components === 'object' ? o.components : {}) as Record<string, unknown>

  // Reconcile against scope: every scoped ref gets a record; records for sets no
  // longer in scope are dropped.
  const components: Record<string, ComponentRunState> = {}
  for (const ref of scope) {
    const existing = rawComponents[ref.componentKey] as Record<string, unknown> | undefined
    components[ref.componentKey] = {
      ref,
      stages: toStages(existing?.stages),
      errors: toErrors(existing?.errors),
    }
  }

  return { version: RUN_STATE_VERSION, platform, scope, components }
}

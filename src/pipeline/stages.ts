// The cc-processor pipeline is a fixed, linear sequence of 7 stages. Each stage
// depends on the one before it, so a component set can only advance once its
// upstream stage is cleared. This module is the single source of truth for stage
// identity, order, and metadata — both the run-state model (state.ts) and the
// process rail (UI) read from it.

export type StageId =
  | 'platform' // 1
  | 'scope' //    2
  | 'contract' // 3
  | 'transform' //4
  | 'template' // 5
  | 'validate' // 6
  | 'publish' //  7

// A stage's status is either tracked once for the whole run (setup stages), or
// independently for each scoped component set (the per-component pipeline).
export type StageScope = 'run' | 'component'

export interface StageDef {
  id: StageId
  order: number // 1-based position in the pipeline
  label: string
  scope: StageScope
  icon: string // ICON registry key (src/ui/icons) — a Phosphor light glyph
  blurb: string // one-line description (from the design annotations)
}

export const STAGES: readonly StageDef[] = [
  {
    id: 'platform',
    order: 1,
    label: 'Figma platform',
    scope: 'run',
    icon: 'figma-platform',
    blurb: 'Core Figma connection and tokens are set and validated. Everything downstream builds on this.',
  },
  {
    id: 'scope',
    order: 2,
    label: 'Scope components',
    scope: 'run',
    icon: 'diamonds-four',
    blurb: 'Choose exactly which component sets are part of this run.',
  },
  {
    id: 'contract',
    order: 3,
    label: 'Generate contract',
    scope: 'component',
    icon: 'generate-contract',
    blurb: 'Fetch, validate and save each component set’s contract — the efficient, AI-tuned context the transformer consumes.',
  },
  {
    id: 'transform',
    order: 4,
    label: 'Transformer',
    scope: 'component',
    icon: 'transformer',
    blurb: 'Hand one contract to an LLM with source access, in a clean 1:1 session, to produce a template. Optional.',
  },
  {
    id: 'template',
    order: 5,
    label: 'Template file',
    scope: 'component',
    icon: 'template-file',
    blurb: 'Finished Code Connect template files land here — from the transformer or pasted in by hand.',
  },
  {
    id: 'validate',
    order: 6,
    label: 'Validate & repair',
    scope: 'component',
    icon: 'warning-diamond',
    blurb: 'Run templates through the validation engine and rules; repair what fails.',
  },
  {
    id: 'publish',
    order: 7,
    label: 'Publish',
    scope: 'component',
    icon: 'nut',
    blurb: 'Templates that pass validation are pushed and stored in Figma Variables.',
  },
]

export const STAGE_IDS: readonly StageId[] = STAGES.map((s) => s.id)

const BY_ID: Record<StageId, StageDef> = STAGES.reduce((m, s) => {
  m[s.id] = s
  return m
}, {} as Record<StageId, StageDef>)

export function stageDef(id: StageId): StageDef {
  return BY_ID[id]
}

export function stageIndex(id: StageId): number {
  return BY_ID[id].order - 1
}

export const COMPONENT_STAGES: readonly StageId[] = STAGES.filter((s) => s.scope === 'component').map((s) => s.id)
export const RUN_STAGES: readonly StageId[] = STAGES.filter((s) => s.scope === 'run').map((s) => s.id)

// Component stages strictly after `id`, in order. Run-level stages are excluded —
// the auto-invalidation cascade only ever resets per-component progress.
export function downstreamComponentStages(id: StageId): StageId[] {
  const i = stageIndex(id)
  return STAGES.filter((s) => s.scope === 'component' && s.order - 1 > i).map((s) => s.id)
}

// The component stage immediately before `id`, or null when `id` is the first
// component stage (its upstream is the run-level scope/platform readiness).
export function upstreamComponentStage(id: StageId): StageId | null {
  const comps = COMPONENT_STAGES
  const i = comps.indexOf(id)
  if (i <= 0) return null
  return comps[i - 1]
}

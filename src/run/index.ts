// The run-state MANAGER — the main-thread owner of the persistent pipeline run
// state (`cc-processor:run`). The pure core (src/pipeline) defines the state
// shape, the stage mutations, and the invalidation cascade; this module is the
// thin figma-facing layer that reads/writes that blob on the document root and
// runs the one side effect the pure core can't: clearing the working artifacts of
// a component that has just left scope.
//
// Stage ACTIONS that must gather figma data (prove the platform, read the canvas
// selection) live in code.ts — they resolve their inputs against `figma.*` and
// funnel the result through the `apply*` mutators here, so persistence and the
// cascade have a single home. Main-thread only (touches `figma.root`), so it
// stays out of the pure `src/pipeline/` core.

import {
  parseRunState,
  serializeRunState,
  setPlatform,
  setScope,
  setComponentStage,
  reRunComponentStage,
  type RunState,
  type StageId,
  type StageStatus,
  type ComponentRef,
} from '../pipeline'
import { clearWork } from '../workspace'

// One JSON blob on the document root. The process Nav is a pure projection of it.
export const RUN_STATE_KEY = 'cc-processor:run'

export function readRunState(): RunState {
  return parseRunState(figma.root.getPluginData(RUN_STATE_KEY))
}

function writeRunState(state: RunState): RunState {
  figma.root.setPluginData(RUN_STATE_KEY, serializeRunState(state))
  return state
}

// Stage 1 — record the platform verdict. `setPlatform` resets every component's
// stage progress (all component work assumes a current platform), so this is the
// widest cascade in the model: re-validating the platform invalidates everything.
export function applyPlatform(
  ready: boolean,
  opts?: { validatedAt?: number; message?: string },
): RunState {
  return writeRunState(setPlatform(readRunState(), ready, opts))
}

// Stage 2 — set the scoped component sets. Beyond the pure `setScope` (which keeps
// progress for still-scoped sets and drops records for the rest), this clears the
// working artifacts of any set that just left scope, so an orphaned
// contract/draft/findings blob can't linger on the document after its component
// is gone. Returns the new state.
export function applyScope(refs: ComponentRef[]): RunState {
  const before = readRunState()
  const nextKeys = new Set(refs.map((r) => r.componentKey))
  for (const key of Object.keys(before.components)) {
    if (!nextKeys.has(key)) clearWork(key)
  }
  return writeRunState(setScope(before, refs))
}

// Merge more sets into the current scope (additive — existing progress is kept).
// De-duped by componentKey; an incoming ref wins over an existing one so the
// freshest name/nodeId is stored, while keeping the set's original position.
export function addToScope(refs: ComponentRef[]): RunState {
  const merged = new Map<string, ComponentRef>()
  for (const r of readRunState().scope) merged.set(r.componentKey, r)
  for (const r of refs) merged.set(r.componentKey, { ...merged.get(r.componentKey), ...r })
  return applyScope([...merged.values()])
}

export function clearScope(): RunState {
  return applyScope([])
}

// Drop specific sets from scope (the per-row remove gesture). Routes through
// applyScope, so each removed set's working artifacts are cleared too.
export function removeFromScope(keys: string[]): RunState {
  const drop = new Set(keys)
  return applyScope(readRunState().scope.filter((r) => !drop.has(r.componentKey)))
}

// ─── Per-component stages (3, 5–7) ───

// Mark a component stage active and reset its downstream stages to pending — the
// invalidation cascade for a stage that's mid-run. Used when a stage kicks off
// before its outcome is known.
export function startComponentStage(componentKey: string, stage: StageId): RunState {
  return writeRunState(reRunComponentStage(readRunState(), componentKey, stage))
}

// Set one component stage to an explicit status WITHOUT cascading — for a stage
// whose outcome doesn't invalidate downstream work. Used to mark the optional
// transformer `skipped` (no token) so the manual template stage unblocks.
export function setComponentStageStatus(
  componentKey: string,
  stage: StageId,
  status: StageStatus,
  error?: string,
): RunState {
  return writeRunState(setComponentStage(readRunState(), componentKey, stage, status, error))
}

// Record the OUTCOME of running a component stage in one persist: run the
// invalidation cascade (reset every downstream stage to pending — a fresh result
// here invalidates the work built on the old one) and stamp this stage `done` or
// `failed`. A failure still cascades, so stale downstream artifacts never outlive
// the input that produced them.
export function finishComponentStage(
  componentKey: string,
  stage: StageId,
  status: Extract<StageStatus, 'done' | 'failed'>,
  error?: string,
): RunState {
  const reset = reRunComponentStage(readRunState(), componentKey, stage)
  return writeRunState(setComponentStage(reset, componentKey, stage, status, error))
}

// Public surface of the pipeline core. This module is pure and dependency-free
// so both the main thread (code.ts → run-state persistence) and the UI can share
// one definition of the stages, the state model, and the rollup that drives the
// process rail.

export {
  STAGES,
  STAGE_IDS,
  COMPONENT_STAGES,
  RUN_STAGES,
  stageDef,
  stageIndex,
  downstreamComponentStages,
  upstreamComponentStage,
} from './stages'
export type { StageId, StageScope, StageDef } from './stages'

export {
  RUN_STATE_VERSION,
  createRunState,
  isCleared,
  componentStageStatus,
  setPlatform,
  setScope,
  setComponentStage,
  reRunComponentStage,
  effectiveComponentStatus,
  computeRollup,
  serializeRunState,
  parseRunState,
} from './state'
export type {
  StageStatus,
  EffectiveStatus,
  ComponentRef,
  ComponentRunState,
  PlatformState,
  RunState,
  StageRollup,
} from './state'

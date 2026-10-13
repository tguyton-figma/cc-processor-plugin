// Public surface of the validation engine. esbuild bundles this into an IIFE
// exposed as `window.CCValidation` (see .figma/make/build-ui.mjs), consumed by the
// Template panel and the config UI in ui.html.

// Core validation
export { validate, mergeSemantic, summarize, extractNodeId, SEMANTIC_RULE_IDS } from './engine'
export type { Issue, Result, Summary, SemanticFinding } from './engine'

// Rule registry (drives both validation and the config UI)
export { RULES, RULE_GROUPS, RULE_IDS, ruleDef, ruleIcon, isSemantic } from './rules'
export type { RuleId, RuleGroup, RulePhase, RuleDef } from './rules'

// Severity model
export { SEVERITY_ORDER, SEVERITY_LABEL, blocks, passes } from './severity'
export type { Severity } from './severity'

// Config (persistence + resolution)
export {
  CONFIG_KEY,
  defaultConfig,
  effectiveSeverity,
  isDefault,
  normalizeConfig,
  parseConfig,
  serializeConfig,
} from './config'
export type { ValidationConfig } from './config'

// Parsing (exposed for reuse/debugging)
export { parseTemplate, locate } from './parse'
export type { ParsedTemplate, Example, SourceLoc } from './parse'

// Icons
export { ICONS, icon, MODE_ICON, SEVERITY_ICON, STATE_ICON } from './icons'

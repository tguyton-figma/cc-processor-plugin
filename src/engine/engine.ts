// The orchestrator. Turns raw template text into a typed, config-resolved
// Result the UI can render directly:
//
//   validate(text, config)          → structural + lint issues (pure, instant)
//   mergeSemantic(result, findings) → fold in main-thread figma.* findings
//
// Every issue is resolved through the rule registry + the user's severity config,
// so 'off' rules are dropped here and the UI never has to know about severity math.
import { parseTemplate, locate, type ParsedTemplate, type SourceLoc } from './parse'
import { runStructuralRules } from './structural'
import { RULES, RULE_GROUPS, ruleIcon, type RuleDef, type RuleId, type RuleGroup, type RulePhase } from './rules'
import { effectiveSeverity, type ValidationConfig } from './config'
import { passes, SEVERITY_ORDER, type Severity } from './severity'
import { SEVERITY_ICON, STATE_ICON } from './icons'

export interface Issue {
  ruleId: RuleId
  level: Exclude<Severity, 'mute'>
  group: RuleGroup
  phase: RulePhase
  title: string
  message: string
  hint: string
  // Optional copyable code block shown beneath the message (see RuleDef.code).
  code?: string
  // Icon for the row: the rule's group/override glyph.
  icon: string
  // Icon reflecting the effective severity (for the leading status dot).
  severityIcon: string
  loc?: SourceLoc
}

export interface Summary {
  errors: number
  comments: number
  pass: boolean
  // Top-of-panel signal: worst present level, or 'pass' when clean.
  state: 'pass' | 'error' | 'comment'
  stateIcon: string
}

export interface Result {
  parsed: ParsedTemplate
  issues: Issue[]
  summary: Summary
  // node-id pulled from the URL, for the semantic round-trip ('' if none).
  nodeId: string
}

// Build an Issue for a fired rule, or null if the user turned it 'off'.
function toIssue(ruleId: RuleId, config: ValidationConfig | undefined, loc?: SourceLoc): Issue | null {
  const level = effectiveSeverity(ruleId, config)
  if (level === 'mute') return null
  const def: RuleDef = RULES[ruleId]
  return {
    ruleId,
    level,
    group: def.group,
    phase: def.phase,
    title: def.title,
    message: def.message,
    hint: def.hint,
    code: def.code,
    icon: ruleIcon(ruleId),
    severityIcon: SEVERITY_ICON[level],
    loc,
  }
}

const LEVEL_RANK: Record<Exclude<Severity, 'mute'>, number> = { error: 0, comment: 1 }

// Errors first, then by group order, then by source position — a stable, scannable
// reading order for the panel.
function sortIssues(issues: Issue[]): Issue[] {
  return issues.slice().sort((a, b) => {
    if (LEVEL_RANK[a.level] !== LEVEL_RANK[b.level]) return LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    const ga = RULE_GROUPS[a.group].order
    const gb = RULE_GROUPS[b.group].order
    if (ga !== gb) return ga - gb
    return (a.loc?.index ?? Infinity) - (b.loc?.index ?? Infinity)
  })
}

export function summarize(issues: Issue[]): Summary {
  let errors = 0
  let comments = 0
  for (const i of issues) {
    if (i.level === 'error') errors++
    else comments++
  }
  const pass = passes(issues.map((i) => i.level))
  const state = errors ? 'error' : comments ? 'comment' : 'pass'
  return { errors, comments, pass, state, stateIcon: STATE_ICON[state] }
}

// The node-id from a Figma URL, normalized to the colon form Figma APIs expect
// (getNodeByIdAsync uses "1:2", URLs use "1-2" or "1%3A2"). '' when absent.
export function extractNodeId(url: string): string {
  const m = /node-id(?:=|%3d)([^&\s]+)/i.exec(url)
  if (!m) return ''
  return decodeURIComponent(m[1]).replace(/-/g, ':')
}

// Pure structural + lint validation — safe to run on every keystroke in the iframe.
export function validate(text: string, config?: ValidationConfig): Result {
  const parsed = parseTemplate(text)

  const issues: Issue[] = []
  for (const { ruleId, index } of runStructuralRules(parsed)) {
    const loc = index >= 0 ? locate(parsed.raw, index) : undefined
    const issue = toIssue(ruleId, config, loc)
    if (issue) issues.push(issue)
  }

  return {
    parsed,
    issues: sortIssues(issues),
    summary: summarize(issues),
    nodeId: extractNodeId(parsed.url),
  }
}

// A semantic finding reported by the main thread: the rule that fired, and an
// optional override message with concrete detail (e.g. the resolved node type).
export interface SemanticFinding {
  ruleId: RuleId
  message?: string
}

// Fold main-thread semantic findings into a structural Result. Returns a new
// Result; the structural issues are preserved and re-sorted alongside the
// semantic ones so the panel shows a single unified list.
export function mergeSemantic(
  base: Result,
  findings: SemanticFinding[],
  config?: ValidationConfig,
): Result {
  // Drop any prior semantic issues so repeated round-trips don't stack up.
  const structural = base.issues.filter((i) => i.phase !== 'semantic')
  const semantic: Issue[] = []
  for (const f of findings) {
    const issue = toIssue(f.ruleId, config)
    if (!issue) continue
    if (f.message) issue.message = f.message
    semantic.push(issue)
  }
  const all = sortIssues(structural.concat(semantic))
  return { ...base, issues: all, summary: summarize(all) }
}

// The set of semantic rule ids (for the main thread to know what it may report).
export const SEMANTIC_RULE_IDS = (Object.keys(RULES) as RuleId[]).filter((id) => RULES[id].phase === 'semantic')

export { SEVERITY_ORDER }

// The user-tunable severity config.
//
// A config is just a partial map of RuleId → chosen Severity. Anything not set
// falls back to the rule's shipped default, so the persisted blob only ever holds
// the user's *deviations* — small, forward-compatible, and impossible to key-drift
// because RuleId is derived from the registry.
import type { Severity } from './severity'
import { RULES, RULE_IDS, type RuleId } from './rules'

export type ValidationConfig = Partial<Record<RuleId, Severity>>

// pluginData key the main thread persists this under (see code.ts).
export const CONFIG_KEY = 'cc-processor:validation_config'

// The shipped defaults, materialized from the registry.
export function defaultConfig(): Record<RuleId, Severity> {
  const out = {} as Record<RuleId, Severity>
  for (const id of RULE_IDS) out[id] = RULES[id].defaultLevel
  return out
}

// The level a rule is *actually* running at right now.
export function effectiveSeverity(id: RuleId, config?: ValidationConfig): Severity {
  const override = config && config[id]
  return override ?? RULES[id].defaultLevel
}

export function isDefault(id: RuleId, config?: ValidationConfig): boolean {
  return effectiveSeverity(id, config) === RULES[id].defaultLevel
}

// Drop any override that just restates the default, and any unknown keys, so what
// we persist stays minimal and valid. Returns a fresh object.
export function normalizeConfig(config?: ValidationConfig): ValidationConfig {
  const out: ValidationConfig = {}
  if (!config) return out
  for (const id of RULE_IDS) {
    const v = config[id]
    if (v && v !== RULES[id].defaultLevel) out[id] = v
  }
  return out
}

// Tolerant parse of whatever came back from pluginData (may be stale/hand-edited).
export function parseConfig(raw: unknown): ValidationConfig {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!obj || typeof obj !== 'object') return {}
  const valid: Severity[] = ['error', 'comment', 'mute']
  // Migrate the retired levels from older persisted configs: 'off' meant "disabled",
  // which is now 'mute', so preserve that intent. Legacy 'warn' has no successor —
  // drop it so the rule falls back to its (now 'comment') shipped default.
  const migrate: Record<string, Severity | undefined> = { off: 'mute', warn: undefined }
  const out: ValidationConfig = {}
  const known = new Set<string>(RULE_IDS)
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!known.has(k) || typeof v !== 'string') continue
    const level = (valid as string[]).indexOf(v) !== -1 ? (v as Severity) : migrate[v]
    if (level) out[k as RuleId] = level
  }
  return normalizeConfig(out)
}

export function serializeConfig(config: ValidationConfig): string {
  return JSON.stringify(normalizeConfig(config))
}

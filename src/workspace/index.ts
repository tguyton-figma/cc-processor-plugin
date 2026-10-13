// The per-component WORKING store — intermediate pipeline artifacts that are NOT
// the published output: the contract (stage 3), the draft template file before it
// is published (stage 4/5), and validation findings (stage 6). These live in root
// pluginData, keyed by the component's stable key (survives rename/move), and are
// deliberately kept OFF the Variables panel. Only the final stage promotes a draft
// into Variables (see src/variables).
//
// Separate from the lean run-state blob (src/pipeline, `cc-processor:run`) on
// purpose: that blob is read on every rail render, so the heavy artifacts get
// their own per-component keys instead of bloating it. Main-thread only (uses
// `figma.root`), so it stays out of the pure `src/pipeline/` core.

const WORK_KEY_PREFIX = 'cc-processor:work:'

export interface ComponentWork {
  /** Serialized contract — the AI-tuned context the transformer consumes (stage 3). */
  contract?: string
  /** Draft Code Connect template file, pre-publish (stage 4/5). */
  draft?: string
  /** Serialized validation findings (stage 6). */
  findings?: string
}

function keyFor(componentKey: string): string {
  return WORK_KEY_PREFIX + componentKey
}

/** Read a component's working artifacts. Missing/corrupt → empty record. */
export function readWork(componentKey: string): ComponentWork {
  try {
    const raw = figma.root.getPluginData(keyFor(componentKey))
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    return obj && typeof obj === 'object' ? (obj as ComponentWork) : {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into a component's working artifacts and persist. Setting a field
 * to `undefined` or `''` drops it, so a cleared artifact doesn't linger. Returns
 * the persisted record.
 */
export function writeWork(componentKey: string, patch: Partial<ComponentWork>): ComponentWork {
  const next: ComponentWork = { ...readWork(componentKey), ...patch }
  for (const k of Object.keys(next) as Array<keyof ComponentWork>) {
    if (next[k] === undefined || next[k] === '') delete next[k]
  }
  figma.root.setPluginData(keyFor(componentKey), JSON.stringify(next))
  return next
}

/** Drop all working artifacts for a component (e.g. when it leaves scope). */
export function clearWork(componentKey: string): void {
  figma.root.setPluginData(keyFor(componentKey), '')
}

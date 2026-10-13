// Pure schema layer for the published-output Variables store — NO Figma API here,
// so the naming + marker rules stay unit-testable in isolation. The Figma-facing
// store (./store.ts) is the only thing that touches `figma.variables.*`.
//
// The data model (PLAN.md §3.1): one flat collection per library, single mode.
// Each variable is one Code Connect template file, named `<component>/<label>`
// using Figma's native `/` variable-group convention — the panel renders the
// prefix as a folder. There is no per-component collection, no mode-per-label, and
// no shredding of a file across fields. One file = one variable value = the atomic
// unit (Figma has no cross-variable transaction), which is what makes every write
// ACID-safe.

// ─── Discovery marker ───
// Stored as *shared* plugin data on the collection (not a variable, not private
// plugin data) so the library is discoverable by every surface — this plugin,
// other plugins, Agent, and the REST API — which is the whole point of treating
// Variables as a public database. The collection itself carries the tag; the
// variable list stays 100% template files.
// Figma's shared-plugin-data namespace only allows [A-Za-z0-9_.] — no hyphen —
// so this can't mirror the hyphenated `cc-processor:` pluginData key prefix.
export const MARKER_NAMESPACE = 'cc_processor'
export const MARKER_KEYS = {
  kind: 'kind',
  schema: 'schema',
  library: 'library',
} as const
export const MARKER_KIND = 'code-connect'
export const SCHEMA_VERSION = '1'

// ─── Naming ───
// `<component>/<label>` where the label is the LEAF after the LAST slash. Component
// names may themselves contain slashes (Figma renders nested groups) — labels may
// not. Splitting on the last slash is what makes nested component names work.
export const NAME_SEP = '/'

export interface TemplateRef {
  /** Group prefix — the component set's display name. May contain `/` (nests). */
  component: string
  /** Leaf label — the Code Connect label (e.g. `web`, `ios`). No `/`. */
  label: string
}

export interface TemplateRecord extends TemplateRef {
  /** The whole Code Connect template file. Identity (node-id/key/url) lives inside it. */
  file: string
  /** Backing Figma variable id — for updates and removal. */
  variableId: string
}

/** Build the variable name for a template. Throws on inputs that can't round-trip. */
export function buildVarName(ref: TemplateRef): string {
  const component = ref.component.trim()
  const label = ref.label.trim()
  if (!component) throw new Error('template component name is empty')
  if (!label) throw new Error('template label is empty')
  if (label.includes(NAME_SEP)) throw new Error(`template label cannot contain "${NAME_SEP}": ${label}`)
  return component + NAME_SEP + label
}

/**
 * Parse a variable name into a template ref by splitting on the LAST slash.
 * Returns null for names with no slash (not a template — e.g. a stray variable).
 */
export function parseVarName(name: string): TemplateRef | null {
  const i = name.lastIndexOf(NAME_SEP)
  if (i <= 0 || i === name.length - 1) return null
  return { component: name.slice(0, i), label: name.slice(i + 1) }
}

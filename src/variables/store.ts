// The published-output Variables store — the SOLE owner of `figma.variables.*` in
// the whole plugin. Nothing else touches the Variables API directly; everything
// goes through this typed interface. Main-thread only (it needs the Figma API), so
// it deliberately lives outside the pure `src/pipeline/` core.
//
// Because the schema is one flat single-mode collection (see ./schema.ts), all the
// machinery the old code needed — extension collections, parent-aware read
// fallbacks, mode-per-label juggling, `as unknown as ExtendedVariableCollection`
// casts — simply doesn't exist here. A read is `valuesByMode[modeId]`. A write is
// one `setValueForMode`. That's the whole surface.

import {
  MARKER_NAMESPACE,
  MARKER_KEYS,
  MARKER_KIND,
  SCHEMA_VERSION,
  buildVarName,
  parseVarName,
  type TemplateRef,
  type TemplateRecord,
} from './schema'

function asString(v: VariableValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

export class TemplateStore {
  private constructor(
    private readonly collection: VariableCollection,
    private readonly modeId: string,
  ) {}

  get collectionId(): string {
    return this.collection.id
  }

  get libraryName(): string {
    return this.collection.name
  }

  // ─── Discovery / lifecycle ───

  /** Wrap a collection, resolving its single mode. */
  private static wrap(collection: VariableCollection): TemplateStore {
    const modeId = collection.modes[0]?.modeId
    if (!modeId) throw new Error(`collection "${collection.name}" has no modes`)
    return new TemplateStore(collection, modeId)
  }

  /** Is this collection tagged as one of our libraries? */
  private static isMarked(collection: VariableCollection): boolean {
    return collection.getSharedPluginData(MARKER_NAMESPACE, MARKER_KEYS.kind) === MARKER_KIND
  }

  /** All library collections in the file, found by the shared-plugin-data marker. */
  static async discover(): Promise<TemplateStore[]> {
    const cols = await figma.variables.getLocalVariableCollectionsAsync()
    return cols.filter(TemplateStore.isMarked).map(TemplateStore.wrap)
  }

  /** Find-or-create the library collection for `name`, tagging it on creation. */
  static async ensure(name: string): Promise<TemplateStore> {
    const existing = await TemplateStore.discover()
    const match = existing.find(s => s.libraryName === name)
    if (match) return match

    // A collection created out-of-band carries the right NAME but not our
    // shared-plugin-data marker, so discover() (marker-based) misses it. This is
    // exactly what the Dev Mode publish path produces — the backend writes via the
    // Variables REST API, which can't set shared plugin data. Adopt such a collection
    // by name and (re-)apply the
    // marker rather than creating a duplicate `.code-connect`; the two paths then
    // converge. Falls through to a real create when there's genuinely no match.
    const all = await figma.variables.getLocalVariableCollectionsAsync()
    const collection = all.find(c => c.name === name) || figma.variables.createVariableCollection(name)
    collection.setSharedPluginData(MARKER_NAMESPACE, MARKER_KEYS.kind, MARKER_KIND)
    collection.setSharedPluginData(MARKER_NAMESPACE, MARKER_KEYS.schema, SCHEMA_VERSION)
    collection.setSharedPluginData(MARKER_NAMESPACE, MARKER_KEYS.library, name)
    return TemplateStore.wrap(collection)
  }

  // ─── Reads ───

  /** Every template file in this library. Grouping is derived from names, never stored. */
  async list(): Promise<TemplateRecord[]> {
    const mine = await this.myVars()
    const out: TemplateRecord[] = []
    for (const v of mine) {
      const ref = parseVarName(v.name)
      if (!ref) continue // a stray variable with no `/` — not a template
      out.push({ ...ref, file: asString(v.valuesByMode[this.modeId]), variableId: v.id })
    }
    return out
  }

  /** One template file's contents, or null if it doesn't exist. */
  async read(ref: TemplateRef): Promise<string | null> {
    const v = await this.findVar(buildVarName(ref))
    return v ? asString(v.valuesByMode[this.modeId]) : null
  }

  // ─── Writes ───

  /** Write one template file. Exactly one `setValueForMode` — the atomic ACID unit. */
  async write(rec: TemplateRef & { file: string }): Promise<TemplateRecord> {
    const name = buildVarName(rec)
    let v = await this.findVar(name)
    if (!v) v = figma.variables.createVariable(name, this.collection, 'STRING')
    v.setValueForMode(this.modeId, rec.file)
    return { component: rec.component, label: rec.label, file: rec.file, variableId: v.id }
  }

  /**
   * Remove one template file (label given) or a whole component group (label
   * omitted). Returns how many variables were removed. A group delete is N separate
   * removes and thus not atomic — acceptable because it's cosmetic: identity lives
   * inside each file, not in the group name.
   */
  async remove(component: string, label?: string): Promise<number> {
    const mine = await this.myVars()
    let removed = 0
    for (const v of mine) {
      const ref = parseVarName(v.name)
      if (!ref) continue
      if (ref.component !== component) continue
      if (label !== undefined && ref.label !== label) continue
      v.remove()
      removed++
    }
    return removed
  }

  // ─── Internals ───

  private async myVars(): Promise<Variable[]> {
    const all = await figma.variables.getLocalVariablesAsync('STRING')
    return all.filter(v => v.variableCollectionId === this.collection.id)
  }

  private async findVar(name: string): Promise<Variable | null> {
    const mine = await this.myVars()
    return mine.find(v => v.name === name) ?? null
  }
}

// Barrel for the published-output Variables store. Import from here.
//
//   import { TemplateStore, type TemplateRecord } from './src/variables'
//
// `./schema` is pure (no Figma API) and unit-testable; `./store` is the
// main-thread-only owner of `figma.variables.*`.
export {
  MARKER_NAMESPACE,
  MARKER_KEYS,
  MARKER_KIND,
  SCHEMA_VERSION,
  NAME_SEP,
  buildVarName,
  parseVarName,
  type TemplateRef,
  type TemplateRecord,
} from './schema'
export { TemplateStore } from './store'

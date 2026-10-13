// Every *structural* rule, as one plain pass over a ParsedTemplate.
//
// parseTemplate() produces a structured object; runStructuralRules() walks it and
// returns a flat list of findings — each a { ruleId, index } naming the rule that
// fired and the source offset to point at (-1 for "no specific spot"). The engine
// maps each finding through the registry + config to a final severity. Severity is
// a plugin concept layered on top; this pass only answers "did rule X fire, and
// where". (Previously a Zod superRefine acted as this issue bus; Zod validated
// ~nothing here — every field was a z.string — so it's gone, and with it a
// dynamic import() in Zod's source that the main-thread sandbox rejected.)
import type { ParsedTemplate } from './parse'
import type { RuleId } from './rules'

// What we attach to every finding so the engine can resolve it.
export interface RuleFinding {
  ruleId: RuleId
  index: number
}

const FIGMA_URL = /figma\.com/i
const NODE_ID = /node-id(=|%3d)/i
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

// imports must be an array of string literals. Given the extracted `[...]` text,
// confirm every top-level element is a quoted string.
function importsAreStrings(bracketText: string): boolean {
  const inner = bracketText.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!inner) return true // empty array is fine
  // Split on top-level commas (strings can't contain commas that matter here,
  // but be defensive about commas inside the quotes).
  const items: string[] = []
  let buf = ''
  let inStr: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (inStr) {
      if (ch === inStr && inner[i - 1] !== '\\') inStr = null
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      buf += ch
      continue
    }
    if (ch === ',') {
      items.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) items.push(buf)
  return items.every((it) => /^\s*(['"`]).*\1\s*$/s.test(it))
}

// Distinct capitalized JSX tags in a snippet — a proxy for "renders child
// components". Used by the childrenMisuse pitfall.
function capitalizedTags(example: string): string[] {
  const seen = new Set<string>()
  const re = /<([A-Z][A-Za-z0-9]*)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(example))) seen.add(m[1])
  return [...seen]
}

// Globals + runtime handles an example may interpolate without a local declaration.
// Anything else must be declared in the template body to resolve at render time.
const INTERP_GLOBALS = new Set([
  'figma', 'instance', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'console', 'undefined', 'null', 'true', 'false', 'NaN',
])

// Names declared anywhere in the file — const/let/var (incl. destructuring),
// function declarations, and import bindings. Used to tell whether an example's
// ${interpolation} refers to something real.
function declaredNames(raw: string): Set<string> {
  const names = new Set<string>()
  const add = (n: string) => { if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n) }
  let m: RegExpExecArray | null
  const simple = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  while ((m = simple.exec(raw))) add(m[1])
  const objDe = /\b(?:const|let|var)\s*\{([^}]*)\}/g
  while ((m = objDe.exec(raw))) for (const p of m[1].split(',')) add(p.split(':').pop()!.split('=')[0].trim())
  const arrDe = /\b(?:const|let|var)\s*\[([^\]]*)\]/g
  while ((m = arrDe.exec(raw))) for (const p of m[1].split(',')) add(p.split('=')[0].trim())
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)/g
  while ((m = fn.exec(raw))) add(m[1])
  const impDefault = /\bimport\s+([A-Za-z_$][\w$]*)/g
  while ((m = impDefault.exec(raw))) add(m[1])
  const impNamed = /\bimport\b[^{}]*\{([^}]*)\}/g
  while ((m = impNamed.exec(raw))) for (const p of m[1].split(',')) add(p.split(/\bas\b/).pop()!.trim())
  return names
}

// Root identifiers interpolated in the example that resolve to nothing — neither a
// known global nor declared in the file. `${size}` with no `const size` anywhere.
function undefinedInterpolations(example: string, raw: string): string[] {
  const declared = declaredNames(raw)
  const missing = new Set<string>()
  const interp = /\$\{([\s\S]*?)\}/g
  let m: RegExpExecArray | null
  while ((m = interp.exec(example))) {
    const root = /^\s*([A-Za-z_$][\w$]*)/.exec(m[1])
    if (!root) continue // string/number literal or other non-identifier expression
    const name = root[1]
    if (!INTERP_GLOBALS.has(name) && !declared.has(name)) missing.add(name)
  }
  return [...missing]
}

// Run every structural rule against a parsed template, returning one finding per
// fired rule. The engine resolves each through the registry + config to a severity.
export function runStructuralRules(t: ParsedTemplate): RuleFinding[] {
  const found: RuleFinding[] = []
  const fire = (ruleId: RuleId, index: number): void => {
    found.push({ ruleId, index })
  }
  const o = t.offsets

  // ── Deprecated parser format: check first; it reframes everything below. ──
  const parserConnect = /figma\.connect\s*\(/.exec(t.raw)
  if (parserConnect) fire('format.parserConnect', parserConnect.index)

  // ── import figma from 'figma' (always required) ──
  if (!t.hasFigmaImport) fire('figmaImport.missing', 0)

  // ── URL header ──
  if (!t.url) {
    fire('url.missing', Math.max(o.url, 0))
  } else {
    if (!FIGMA_URL.test(t.url)) fire('url.notFigma', Math.max(o.url, 0))
    else if (!NODE_ID.test(t.url)) fire('url.noNodeId', Math.max(o.url, 0))
  }

  // ── Object body (only meaningful when export default exists) ──
  if (!t.hasExportDefault) {
    fire('export.missing', 0)
  } else {
    // example
    if (!t.hasCodeCall && !t.hasExampleKey) {
      fire('example.missing', o.exportDefault)
    } else if (t.hasExampleKey && !t.hasCodeCall) {
      fire('format.exampleNotCode', Math.max(o.exampleKey, 0))
    } else {
      // Tag(s) present but a branch's literal is empty/whitespace — no snippet
      // there at all. Checks every example, so a bad branch can't hide behind
      // a good first one.
      const empty = t.examples.find((e) => !e.code.trim())
      if (empty) fire('example.empty', empty.offset)
    }

    // id
    if (!t.id) fire('id.missing', o.exportDefault)

    // imports (optional, but if present must be string[])
    if (t.hasImportsKey && (!t.imports || !importsAreStrings(t.imports))) {
      fire('imports.notStringArray', Math.max(o.importsKey, 0))
    }

    // metadata shape (optional)
    if (t.hasMetadataKey && t.metadata) {
      const nestable = /\bnestable\s*:\s*([^,}\n]+)/.exec(t.metadata)
      if (nestable) {
        const v = nestable[1].trim()
        if (v !== 'true' && v !== 'false') fire('metadata.nestableType', o.metadataKey)
      }
      const props = /\bprops\s*:\s*(\S)/.exec(t.metadata)
      if (props && props[1] !== '{') fire('metadata.propsType', o.metadataKey)
    }

    // ── Authoring pitfalls (opinionated lint, checked across every example) ──
    // Each rule fires at most once, pointing at the first offending branch, so a
    // clean first branch can't mask a problem in a later one.
    const rawPropEx = t.examples.find((e) => /\bprops\s*\./.test(e.code))
    if (rawPropEx) fire('pitfall.rawPropAccess', rawPropEx.offset)

    // Parserless templates render nested instances dynamically off the selected
    // instance (getInstanceSwap/findInstance/getSlot → executeTemplate), then
    // interpolate the result. Look across the whole file (raw), since those
    // accessor calls usually live in the definitions above `example`.
    const rendersChildren =
      /\b(?:executeTemplate|getSlot|getInstanceSwap|findInstance|findChildren|findConnectedInstances?)\s*\(/.test(t.raw)
    if (!rendersChildren) {
      const childEx = t.examples.find((e) => capitalizedTags(e.code).length >= 2)
      if (childEx) fire('pitfall.childrenMisuse', childEx.offset)
    }

    // Every ${…} in a snippet must resolve to a global or something declared in
    // the template; a bare ${size} with no accessor renders as undefined.
    const undefEx = t.examples.find((e) => undefinedInterpolations(e.code, t.raw).length > 0)
    if (undefEx) fire('pitfall.undefinedInterpolation', undefEx.offset)

    // executeTemplate() returns an object ({ example, metadata }), and `example`
    // is itself an object. Turning either into a string (interpolating the whole
    // result, or never reading .example/.metadata off it) renders "[object Object]"
    // in Dev Mode.
    const usesExecuteTemplate = /\bexecuteTemplate\s*\(/.test(t.raw)
    const dereferencesResult = /\.\s*(?:example|metadata)\b/.test(t.raw)
    if (usesExecuteTemplate && !dereferencesResult) {
      fire('pitfall.resultStringified', Math.max(o.codeCall, o.exportDefault))
    }

    // Building the example by pushing tagged literals into an array and join()-ing
    // them interleaves rendered CODE/INSTANCE sections — it renders "[object Object]"
    // and can crash the Dev Mode panel.
    const pushesTemplate = /\.\s*push\s*\(\s*figma\.(?:code|tsx|jsx|html|swift|kotlin)\s*`/.test(t.raw)
    const joinsResults = /\.\s*join\s*\(/.test(t.raw)
    if (pushesTemplate && joinsResults) {
      fire('pitfall.interleavedResults', Math.max(o.codeCall, o.exportDefault))
    }
  }

  // ── Plugin conventions (headers + naming; don't depend on the body) ──
  if (!t.source) fire('ext.sourceMissing', 0)
  if (!t.component) fire('ext.componentMissing', 0)
  if (t.id && !KEBAB.test(t.id)) fire('ext.idNaming', Math.max(o.id, 0))
  if (!t.label) fire('ext.labelHint', 0)
  if (!t.language) fire('ext.languageHint', 0)

  return found
}

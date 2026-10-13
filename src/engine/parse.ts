// Parser for parserless Code Connect template files
// (`.figma.ts`, `export default { example: figma.code`…`, id, imports?, metadata? }`).
//
// Structure is read from a real JavaScript AST via `@lezer/javascript` (pure JS,
// already bundled for the editor, safe in both the iframe and the main-thread
// sandbox). This replaces the old hand-rolled bracket/backtick scanner, which was
// fragile to comments (an apostrophe or a backtick inside a `//` comment corrupted
// its string-skipping) and — because it matched only the FIRST `figma.*` literal —
// silently ignored every branch but the first in a multi-example template.
//
// The parser is deliberately non-judgemental: it extracts structure and records
// source offsets. All severity/rule judgement lives in the schema + rule registry.
import { parser } from '@lezer/javascript'
import type { SyntaxNode } from '@lezer/common'

// The `figma.*` tag family that marks a code example (generic + framework-specific).
const FIGMA_TAGS = new Set(['code', 'tsx', 'jsx', 'html', 'swift', 'kotlin'])

// A 1-based line/column derived from a character offset, for pointing the UI at
// the exact spot an issue was found. -1 offset means "no specific location".
export interface SourceLoc {
  index: number
  line: number
  column: number
}

export function locate(text: string, index: number): SourceLoc | undefined {
  if (index < 0 || index > text.length) return undefined
  let line = 1
  let last = -1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line++
      last = i
    }
  }
  return { index, line, column: index - last }
}

// One `figma.<tag>`…`` code example, with its inner literal text (verbatim,
// including any `${…}` interpolations) and the offset of the tagged call.
export interface Example {
  tag: string
  code: string
  offset: number
}

export interface ParsedTemplate {
  // Full source, kept for lint scans and location math.
  raw: string
  // Header comments (leading comment block only).
  url: string
  source: string
  component: string
  label: string
  language: string
  // Body slices.
  dependencies: string
  definitions: string
  // EVERY figma.* tagged example found under the `example` key — one per branch
  // of a multi-example function, so example-level rules can check them all.
  examples: Example[]
  imports: string
  id: string
  metadata: string
  // Presence flags the schema branches on (cheaper + clearer than re-deriving).
  hasExportDefault: boolean
  hasFigmaImport: boolean
  hasCodeCall: boolean
  hasExampleKey: boolean
  hasImportsKey: boolean
  hasMetadataKey: boolean
  // Source offsets (or -1) so rules can point at the problem.
  offsets: {
    exportDefault: number
    figmaImport: number
    codeCall: number
    exampleKey: number
    importsKey: number
    metadataKey: number
    url: number
    id: number
  }
}

function headerOffset(text: string, key: string): number {
  const re = new RegExp('^[ \\t]*//[ \\t]*' + key + '[ \\t]*=', 'm')
  const m = re.exec(text)
  return m ? m.index : -1
}

// Text of a node.
function txt(text: string, node: SyntaxNode): string {
  return text.slice(node.from, node.to)
}

// Drop a matching pair of surrounding quotes from a string/template literal.
function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`') && s[s.length - 1] === s[0]) {
    return s.slice(1, -1)
  }
  return s
}

// Read a `figma.<tag>`…`` tagged template, or null if it isn't one.
function readTagged(text: string, node: SyntaxNode): Example | null {
  const member = node.getChild('MemberExpression')
  const tmpl = node.getChild('TemplateString')
  if (!member || !tmpl) return null
  const obj = member.getChild('VariableName')
  const prop = member.getChild('PropertyName')
  if (!obj || !prop) return null
  if (txt(text, obj) !== 'figma') return null
  const tag = txt(text, prop)
  if (!FIGMA_TAGS.has(tag)) return null
  // TemplateString spans include the backticks; the inner text is what renders.
  return { tag, code: text.slice(tmpl.from + 1, tmpl.to - 1), offset: node.from }
}

// Collect every figma.* tagged template in a subtree (the node itself, then its
// descendants) — so a function that returns different snippets per branch yields
// one Example per branch.
function collectExamples(text: string, node: SyntaxNode, out: Example[]): void {
  if (node.name === 'TaggedTemplateExpression') {
    const ex = readTagged(text, node)
    if (ex) out.push(ex)
  }
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) collectExamples(text, ch, out)
}

// Is this ImportDeclaration `import figma from 'figma'`?
function isFigmaImport(text: string, node: SyntaxNode): boolean {
  const binding = node.getChild('VariableDefinition')
  if (!binding || txt(text, binding) !== 'figma') return false
  const src = node.getChild('String')
  return !!src && unquote(txt(text, src)) === 'figma'
}

export function parseTemplate(text: string): ParsedTemplate {
  // Header comments live in the leading comment block only — stop at first code.
  const readHeader = (key: string): string => {
    const re = new RegExp('^\\s*//\\s*' + key + '\\s*=\\s*(.+?)\\s*$')
    for (const ln of text.split('\n')) {
      const m = ln.match(re)
      if (m) return m[1].trim()
      if (ln.trim() && ln.trim().indexOf('//') !== 0) break
    }
    return ''
  }

  const url = readHeader('url')
  const source = readHeader('source')
  const component = readHeader('component')
  const label = readHeader('label')
  const language = readHeader('language')

  const root = parser.parse(text).topNode

  // import figma from 'figma'
  let figmaImportOffset = -1
  for (const imp of root.getChildren('ImportDeclaration')) {
    if (isFigmaImport(text, imp)) {
      figmaImportOffset = imp.from
      break
    }
  }

  // export default { … }
  const exportDecl = root.getChildren('ExportDeclaration').find((n) => !!n.getChild('default')) ?? null
  const hasExportDefault = !!exportDecl

  const base: ParsedTemplate = {
    raw: text,
    url,
    source,
    component,
    label,
    language,
    dependencies: '',
    definitions: '',
    examples: [],
    imports: '',
    id: '',
    metadata: '',
    hasExportDefault,
    hasFigmaImport: figmaImportOffset !== -1,
    hasCodeCall: false,
    hasExampleKey: false,
    hasImportsKey: false,
    hasMetadataKey: false,
    offsets: {
      exportDefault: hasExportDefault ? exportDecl!.from : -1,
      figmaImport: figmaImportOffset,
      codeCall: -1,
      exampleKey: -1,
      importsKey: -1,
      metadataKey: -1,
      url: headerOffset(text, 'url'),
      id: -1,
    },
  }

  if (!exportDecl) return base

  // Preamble (before export default, minus header comments): import lines are
  // dependencies, everything else is definitions.
  const depLines: string[] = []
  const defLines: string[] = []
  for (const raw of text.slice(0, exportDecl.from).split('\n')) {
    const ln = raw.trim()
    if (!ln || ln.indexOf('//') === 0) continue
    if (/^import\b/.test(ln)) depLines.push(raw.replace(/\s+$/, ''))
    else defLines.push(raw.replace(/\s+$/, ''))
  }
  base.dependencies = depLines.join('\n')
  base.definitions = defLines.join('\n')

  const obj = exportDecl.getChild('ObjectExpression')
  if (obj) {
    for (const prop of obj.getChildren('Property')) {
      const keyNode = prop.getChild('PropertyDefinition')
      if (!keyNode) continue
      const key = txt(text, keyNode)
      const value = prop.lastChild // PropertyDefinition, ':', value → value is last
      if (!value || value === keyNode) continue

      if (key === 'example') {
        base.hasExampleKey = true
        base.offsets.exampleKey = keyNode.from
        collectExamples(text, value, base.examples)
      } else if (key === 'imports') {
        base.hasImportsKey = true
        base.offsets.importsKey = keyNode.from
        if (value.name === 'ArrayExpression') base.imports = txt(text, value)
      } else if (key === 'id') {
        base.offsets.id = keyNode.from
        if (value.name === 'String') base.id = unquote(txt(text, value))
      } else if (key === 'metadata') {
        base.hasMetadataKey = true
        base.offsets.metadataKey = keyNode.from
        if (value.name === 'ObjectExpression') base.metadata = txt(text, value)
      }
    }
  }

  base.hasCodeCall = base.examples.length > 0
  base.offsets.codeCall = base.examples.length ? base.examples[0].offset : -1

  return base
}

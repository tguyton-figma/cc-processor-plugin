// The rule-authoring contract — the spec every structural rule must satisfy.
//
// The characterization corpus (characterization.test.ts) only *pins* today's
// behavior. This file asserts the *intended* behavior, in both directions, so a
// rule can't silently rot into a false positive or a false negative:
//
//   • fires        — a template that MUST trip the rule
//   • silent       — a near-miss that looks similar but MUST NOT trip it
//   • multiBranch  — (example-level rules) a clean first branch followed by an
//                    offending later one; the rule must still fire (the Phase 1
//                    multi-example fix — regex parsers only ever saw branch #1)
//
// A completeness guard asserts every `structural` rule has an entry here, so
// adding a rule to the registry without a contract fails the suite. Semantic
// rules run on the main thread (they need live figma.*) and are out of scope for
// validate(), so they're intentionally excluded.
//
// Cases are built from build()/twoBranch() rather than fixture files: a near-miss
// is usually a one-line deviation from a valid template, and keeping the firing
// and silent variants adjacent makes the contract read like documentation.
import { describe, expect, it } from 'vitest'
import { validate, RULES, RULE_IDS, type RuleId } from '../src/engine'

// The rule ids that fired for a given source.
function fired(text: string): Set<RuleId> {
  return new Set(validate(text).issues.map((i) => i.ruleId))
}

const URL_OK = 'https://www.figma.com/design/abc123/File?node-id=1-2'
const DEFAULT_BODY = "example: figma.code`<Button />`,\n  id: 'button',"

interface Parts {
  // A header value, or '' to omit that header line entirely.
  url?: string
  source?: string
  component?: string
  label?: string
  language?: string
  // Drop `import figma from 'figma'` when false.
  figmaImport?: boolean
  // Extra lines between the import and the export default.
  defs?: string
  // The object body (properties). Defaults to a clean example + id.
  body?: string
  // Replace the whole export-default with arbitrary trailing code (for cases
  // that need no valid object, e.g. export.missing / parserConnect).
  instead?: string
}

// Compose a parserless template. Defaults form a clean, passing file; each field
// is a seam a case overrides to isolate exactly one rule.
function build(p: Parts = {}): string {
  const header = (key: string, val: string | undefined, def: string) =>
    val === '' ? null : `// ${key}=${val ?? def}`
  const lines = [
    header('url', p.url, URL_OK),
    header('source', p.source, 'src/Button.tsx'),
    header('component', p.component, 'Button'),
    header('label', p.label, 'Web'),
    header('language', p.language, 'typescript'),
    p.figmaImport === false ? null : "import figma from 'figma'",
    p.defs ?? null,
    p.instead ?? `export default {\n  ${p.body ?? DEFAULT_BODY}\n}`,
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// A function-form example with a clean first branch and a caller-supplied second
// branch — the shape the old regex parsers linted on branch #1 alone.
function twoBranch(second: string): string {
  return build({
    defs: "const variant = instance.getEnum('Variant')",
    body:
      'example: () => {\n' +
      "    if (variant === 'a') return figma.code`<Button />`\n" +
      `    return ${second}\n` +
      '  },\n' +
      "  id: 'button',",
  })
}

interface Case {
  fires: string
  silent: string
  multiBranch?: string
}

// One entry per structural rule. Read each as: "this trips it; this close cousin
// must not."
const CONTRACT: Record<RuleId, Case> = {
  // ── Required structure ─────────────────────────────────────────────────────
  'export.missing': {
    fires: build({ instead: 'const x = figma.code`<Button/>`' }),
    silent: build(),
  },
  'figmaImport.missing': {
    fires: build({ figmaImport: false }),
    silent: build(),
  },
  'example.missing': {
    fires: build({ body: "id: 'button'," }),
    silent: build(),
  },
  'example.empty': {
    fires: build({ body: 'example: figma.code``,\n  id: ' + "'button'," }),
    silent: build(),
    multiBranch: twoBranch('figma.code``'),
  },
  'id.missing': {
    fires: build({ body: 'example: figma.code`<Button/>`,' }),
    silent: build(),
  },
  'imports.notStringArray': {
    fires: build({ body: "example: figma.code`<Button/>`,\n  id: 'button',\n  imports: [Button]," }),
    silent: build({
      body: "example: figma.code`<Button/>`,\n  id: 'button',\n  imports: [\"import { Button } from './button'\"],",
    }),
  },

  // ── Component URL ──────────────────────────────────────────────────────────
  'url.missing': {
    fires: build({ url: '' }),
    silent: build(),
  },
  'url.notFigma': {
    fires: build({ url: 'https://example.com/foo?node-id=1-2' }),
    silent: build(),
  },
  'url.noNodeId': {
    fires: build({ url: 'https://www.figma.com/design/abc123/File' }),
    silent: build(),
  },

  // ── Template format ────────────────────────────────────────────────────────
  'format.parserConnect': {
    fires: build({ instead: "figma.connect(Button, 'https://figma.com?node-id=1-2', {})" }),
    // connectManually( isn't connect( — the \s*\( boundary must hold.
    silent: build({ defs: 'const noop = () => figma.connectManually()' }),
  },
  'format.exampleNotCode': {
    fires: build({ body: "example: '<Button/>',\n  id: 'button'," }),
    silent: build(),
  },

  // ── Metadata shape ─────────────────────────────────────────────────────────
  'metadata.nestableType': {
    fires: build({ body: DEFAULT_BODY + "\n  metadata: { nestable: 'yes' }," }),
    silent: build({ body: DEFAULT_BODY + '\n  metadata: { nestable: true },' }),
  },
  'metadata.propsType': {
    fires: build({ body: DEFAULT_BODY + "\n  metadata: { props: 'x' }," }),
    silent: build({ body: DEFAULT_BODY + '\n  metadata: { props: {} },' }),
  },

  // ── Authoring pitfalls ─────────────────────────────────────────────────────
  'pitfall.rawPropAccess': {
    fires: build({ body: 'example: figma.code`<Button label="${props.label}" />`,\n  id: ' + "'button'," }),
    // propsList is not props. — the \bprops\s*\. boundary must hold.
    silent: build({
      defs: "const propsList = instance.getString('Label')",
      body: 'example: figma.code`<Button label="${propsList}" />`,\n  id: ' + "'button',",
    }),
    multiBranch: twoBranch('figma.code`<Button label="${props.x}" />`'),
  },
  'pitfall.childrenMisuse': {
    fires: build({ body: 'example: figma.code`<Card><Button/></Card>`,\n  id: ' + "'card'," }),
    // Two child tags, but resolved dynamically (getInstanceSwap → executeTemplate).
    silent: build({
      defs: "const child = instance.getInstanceSwap('Icon')",
      body: 'example: figma.code`<Card>${child.executeTemplate().example}<Button/></Card>`,\n  id: ' + "'card',",
    }),
    multiBranch: twoBranch('figma.code`<Card><Button/></Card>`'),
  },
  'pitfall.resultStringified': {
    fires: build({
      defs: "const child = instance.getInstanceSwap('Icon')\nconst result = child.executeTemplate()",
      body: 'example: figma.code`${result}`,\n  id: ' + "'button',",
    }),
    // Reads .example off the result instead of stringifying the whole object.
    silent: build({
      defs: "const child = instance.getInstanceSwap('Icon')",
      body: 'example: figma.code`${child.executeTemplate().example}`,\n  id: ' + "'button',",
    }),
  },
  'pitfall.interleavedResults': {
    fires: build({
      defs: 'const parts = []\n  parts.push(figma.code`<Button/>`)',
      body: "example: figma.code`${parts.join('')}`,\n  id: 'button',",
    }),
    // A plain string join — no figma.* templates pushed — is fine.
    silent: build({
      defs: "const labels = ['a', 'b'].join(', ')",
      body: 'example: figma.code`<Button label="${labels}" />`,\n  id: ' + "'button',",
    }),
  },
  'pitfall.undefinedInterpolation': {
    fires: build({ body: 'example: figma.code`<Button label="${missingLabel}" />`,\n  id: ' + "'button'," }),
    silent: build({
      defs: "const label = instance.getString('Label')",
      body: 'example: figma.code`<Button label="${label}" />`,\n  id: ' + "'button',",
    }),
    multiBranch: twoBranch('figma.code`<Button label="${missingLabel}" />`'),
  },

  // ── Plugin conventions ─────────────────────────────────────────────────────
  'ext.sourceMissing': {
    fires: build({ source: '' }),
    silent: build(),
  },
  'ext.componentMissing': {
    fires: build({ component: '' }),
    silent: build(),
  },
  'ext.idNaming': {
    fires: build({ body: "example: figma.code`<Button/>`,\n  id: 'MyButton'," }),
    silent: build(),
  },
  'ext.labelHint': {
    fires: build({ label: '' }),
    silent: build(),
  },
  'ext.languageHint': {
    fires: build({ language: '' }),
    silent: build(),
  },
} as Record<RuleId, Case>

describe('rule authoring contract', () => {
  const structural = RULE_IDS.filter((id) => RULES[id].phase === 'structural').sort()

  it('covers every structural rule — and only those', () => {
    expect(Object.keys(CONTRACT).sort()).toEqual(structural)
  })

  for (const id of Object.keys(CONTRACT) as RuleId[]) {
    const c = CONTRACT[id]
    describe(id, () => {
      it('fires on the offending template', () => {
        expect(fired(c.fires).has(id)).toBe(true)
      })
      it('stays silent on the near-miss', () => {
        expect(fired(c.silent).has(id)).toBe(false)
      })
      if (c.multiBranch) {
        it('fires on a later branch, not just the first', () => {
          expect(fired(c.multiBranch!).has(id)).toBe(true)
        })
      }
    })
  }
})

// Gnarly-looking templates that are nonetheless entirely legitimate. These guard
// the whole engine (not one rule) against over-firing on realistic authoring.
describe('weird but valid — must stay fully clean', () => {
  const cases: Record<string, string> = {
    'multiple clean branches': twoBranch('figma.code`<Button variant="secondary" />`'),
    'accessors + framework tag + metadata': build({
      defs:
        'const instance = figma.selectedInstance\n' +
        "  const size = instance.getEnum('Size')\n" +
        "  const child = instance.getInstanceSwap('Icon')",
      body:
        'example: figma.tsx`<Avatar size="${size}">${child.executeTemplate().example}</Avatar>`,\n' +
        "  id: 'avatar',\n" +
        '  imports: ["import { Avatar } from \'./avatar\'"],\n' +
        '  metadata: { nestable: true, props: {} },',
    }),
    'normal array join, single child tag': build({
      defs: "const labels = ['a', 'b'].join(', ')",
      body: 'example: figma.code`<Button label="${labels}" />`,\n  id: ' + "'button',",
    }),
  }
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      expect(validate(text).summary.state).toBe('pass')
    })
  }
})

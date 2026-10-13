// The rule registry — the single source of truth for every check.
//
// RuleId is DERIVED from this object (`keyof typeof RULES`), so the config type,
// the schema's issue tags, the icon map, and the config UI can never drift out of
// sync with the rules that actually exist. Add a rule here and it flows
// everywhere; there is no second list to keep aligned.
import type { Severity } from './severity'

// Groups order the config UI and give each rule a default icon + heading.
export type RuleGroup = 'required' | 'url' | 'format' | 'metadata' | 'pitfalls' | 'extensions' | 'semantic'

// Structural/lint rules run in the iframe on every keystroke. Semantic rules need
// figma.* and run on the main thread; the engine skips them during structural
// validation and merges their findings back in.
export type RulePhase = 'structural' | 'semantic'

export interface RuleDef {
  group: RuleGroup
  phase: RulePhase
  defaultLevel: Severity
  // Short label for the config UI row.
  title: string
  // Shown when the rule fires. Kept static + specific; the parser supplies the
  // location, so messages don't need to interpolate values.
  message: string
  // The short, concrete path to a manual fix (no auto-fix button by design).
  hint: string
  // Optional copyable code block shown beneath the message — a ready-to-paste
  // starting point for the fix. Rendered read-only (click anywhere to copy) in
  // the signal canvas, where it SUPERSEDES the prose hint — so the guidance
  // lives in the snippet's own comments. Keep it a minimal, correct example, not
  // a full template. The hint field still feeds the config UI + agent copy blob,
  // so keep both populated.
  code?: string
  // Optional per-rule icon override (see icons.ts keys). Defaults to the group icon.
  icon?: string
}

export const RULE_GROUPS: Record<RuleGroup, { title: string; icon: string; order: number }> = {
  required: { title: 'Required structure', icon: 'asterisk', order: 0 },
  url: { title: 'Component URL', icon: 'link-break', order: 1 },
  format: { title: 'Template format', icon: 'shield-warning', order: 2 },
  metadata: { title: 'Metadata', icon: 'file-x', order: 3 },
  pitfalls: { title: 'Authoring pitfalls', icon: 'seal-warning', order: 4 },
  extensions: { title: 'Plugin conventions', icon: 'chat-teardrop', order: 5 },
  semantic: { title: 'Resolves in Figma', icon: 'cloud-warning', order: 6 },
}

export const RULES = {
  // ── Required structure (hard fails) ─────────────────────────────────────────
  'export.missing': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'export default block',
    message: 'The plugin can’t find the single block that holds your template. There needs to be exactly one, sitting on its own at the top of the file — if it’s tucked inside a condition or a function, it won’t be seen.',
    hint: 'Work out any values first, then write a single export default at the top. To change the snippet per case, branch inside a value and drop it in with ${…} — not with a separate export for each case.',
    code:
      "import figma from 'figma'\n\n" +
      '// Work out per-case values first — this is where you branch.\n' +
      'const instance = figma.selectedInstance\n' +
      "const size = instance.getEnum('Size')\n" +
      "const label = size === 'icon' ? '' : instance.getString('Label')\n\n" +
      '// Exactly one export default, at the top level — never inside an if/else\n' +
      '// or a function. Drop each per-case value in with ${…}.\n' +
      'export default {\n' +
      '  example: figma.code`<Button size="${size}">${label}</Button>`,\n' +
      "  id: 'button',\n" +
      '}',
  },
  'figmaImport.missing': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: "import figma from 'figma'",
    message: 'The first line that makes Figma’s authoring helpers available is missing, so none of them can run.',
    hint: "Add import figma from 'figma' at the top of the file.",
    code:
      '// At the very top of the file — figma.code and every figma.* helper needs it.\n' +
      "import figma from 'figma'",
  },
  'example.missing': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'figma.* example',
    message: 'Your template doesn’t include the code snippet that Dev Mode shows to developers.',
    hint: 'Add example: figma.code`…` (or figma.tsx/jsx/html/swift/kotlin for framework-specific highlighting).',
    code:
      "import figma from 'figma'\n\n" +
      'export default {\n' +
      '  // The snippet Dev Mode shows. Use figma.tsx / jsx / html / swift / kotlin\n' +
      '  // instead of .code for framework-specific syntax highlighting.\n' +
      '  example: figma.code`<Avatar size="medium" />`,\n' +
      "  id: 'avatar',\n" +
      '}',
  },
  'example.empty': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'Example has content',
    message: 'The snippet Dev Mode shows is empty — the placeholder is there, but there’s no code inside it.',
    hint: 'Put your component markup inside the tag: figma.code`<Avatar … />`.',
    code:
      'export default {\n' +
      "  // Put the component's markup inside the tag — that's what Dev Mode renders.\n" +
      '  example: figma.code`<Avatar size="medium" src="/user.png" />`,\n' +
      "  id: 'avatar',\n" +
      '}',
  },
  'id.missing': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'id field',
    message: 'Your template has no stable identity, so there’s nothing to save or update it against.',
    hint: "Add id: 'component-name' to the exported object.",
    code:
      'export default {\n' +
      '  example: figma.code`<Button label="Save" />`,\n' +
      '  // A stable, lower-kebab-case identity the plugin saves and updates against.\n' +
      "  id: 'button',\n" +
      '}',
  },
  'imports.notStringArray': {
    group: 'required',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'imports is a string[]',
    message: 'The list of import lines needs to be written as plain text, but yours isn’t.',
    hint: "Write imports: [\"import { X } from 'y'\"] — quoted strings only.",
    code:
      'export default {\n' +
      '  example: figma.code`<Button label="Save" />`,\n' +
      "  id: 'button',\n" +
      '  // Each import is a plain string; they get pasted above the snippet.\n' +
      '  imports: ["import { Button } from \'@acme/ui\'"],\n' +
      '}',
  },

  // ── Component URL ───────────────────────────────────────────────────────────
  'url.missing': {
    group: 'url',
    phase: 'structural',
    defaultLevel: 'error',
    title: '// url= header',
    message: 'Every template starts with a comment on the first line that points to a specific Figma component — yours is missing it.',
    hint: 'Add // url=… using Copy link to selection on the component.',
    code:
      '// Copy link to selection on the component, then paste it as a header:\n' +
      '// url=https://www.figma.com/design/FILE_KEY/File?node-id=1-23',
  },
  'url.notFigma': {
    group: 'url',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'URL points to Figma',
    message: 'The link on the first line of your template isn’t a Figma link, so it can’t resolve to a component.',
    hint: 'Paste the component’s Figma link (Copy link to selection).',
    code:
      '// Must be a figma.com link — use Copy link to selection on the component:\n' +
      '// url=https://www.figma.com/design/FILE_KEY/File?node-id=1-23',
  },
  'url.noNodeId': {
    group: 'url',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'URL has a node-id',
    message: 'The link on the first line points at the whole file, not a specific component.',
    hint: 'Copy the link from the component itself so it includes ?node-id=…',
    code:
      '// Copy the link from the component itself so it carries ?node-id=… —\n' +
      '// that part is what resolves to one specific component:\n' +
      '// url=https://www.figma.com/design/FILE_KEY/File?node-id=1-23',
  },

  // ── Template format (deprecated / wrong shape) ──────────────────────────────
  'format.parserConnect': {
    group: 'format',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'deprecated figma.connect() format',
    message: 'This template uses the older format the plugin no longer reads — it needs the newer, simpler structure.',
    hint: 'Rewrite as export default { example: figma.code`…`, id }.',
    code:
      "import figma from 'figma'\n\n" +
      '// The plugin reads only this parserless shape — a single export default,\n' +
      '// with no figma.connect() wrapper around it.\n' +
      'export default {\n' +
      '  example: figma.code`<Button label="Save" />`,\n' +
      "  id: 'button',\n" +
      '}',
    icon: 'shield-warning',
  },
  'format.exampleNotCode': {
    group: 'format',
    phase: 'structural',
    defaultLevel: 'error',
    title: 'example is a figma.* tagged template',
    message: 'Your snippet is there, but it isn’t wrapped the way Figma needs, so its contents aren’t treated as code.',
    hint: 'Wrap the snippet in a tagged template: figma.code`…` (or figma.tsx/jsx/html/swift/kotlin).',
    code:
      'export default {\n' +
      '  // example must be a figma.* tagged template so its contents are treated\n' +
      '  // as code — not a plain string and not an object.\n' +
      '  example: figma.code`<Button label="Save" />`,\n' +
      "  id: 'button',\n" +
      '}',
    icon: 'shield-warning',
  },

  // ── Metadata shape ──────────────────────────────────────────────────────────
  'metadata.nestableType': {
    group: 'metadata',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'metadata.nestable is boolean',
    message: 'The setting for whether this component can nest inside others has to be a simple yes or no.',
    hint: 'Set nestable: true or nestable: false — no quotes.',
    code:
      'export default {\n' +
      '  example: figma.code`<Card />`,\n' +
      "  id: 'card',\n" +
      '  // true or false, no quotes — whether this can nest inside other components.\n' +
      '  metadata: { nestable: true },\n' +
      '}',
  },
  'metadata.propsType': {
    group: 'metadata',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'metadata.props is an object',
    message: 'The property mappings need to be written as a set of key-and-value pairs, not a single value.',
    hint: 'Write props: { … } inside metadata, or drop it.',
    code:
      'export default {\n' +
      '  example: figma.code`<Card />`,\n' +
      "  id: 'card',\n" +
      '  // props is an object of mappings (or drop it entirely) — never a string.\n' +
      "  metadata: { props: { elevation: 'raised' } },\n" +
      '}',
  },

  // ── Authoring pitfalls (opinionated lint, non-blocking) ─────────────────────
  'pitfall.rawPropAccess': {
    group: 'pitfalls',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'Raw props access in example',
    message: 'Your snippet reads properties directly, but templates like this have no properties to read from — so those values show up as raw text instead.',
    hint: "Read from the instance: const instance = figma.selectedInstance, then interpolate ${instance.getString('Prop')} / getBoolean / getEnum.",
    code:
      "import figma from 'figma'\n\n" +
      '// Parserless templates have no props object. Read from the instance,\n' +
      '// then interpolate the values into the snippet with ${…}.\n' +
      'const instance = figma.selectedInstance\n' +
      "const label = instance.getString('Label')\n" +
      "const disabled = instance.getBoolean('Disabled')\n\n" +
      'export default {\n' +
      '  example: figma.code`<Button disabled={${disabled}}>${label}</Button>`,\n' +
      "  id: 'button',\n" +
      '}',
    icon: 'seal-warning',
  },
  'pitfall.childrenMisuse': {
    group: 'pitfalls',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'Hardcoded child instances',
    message: 'Nested components look hardcoded — they won’t reflect the instance actually placed in Figma.',
    hint: 'Resolve children dynamically — instance.getInstanceSwap()/findInstance()/getSlot() → executeTemplate().example — and interpolate the result.',
    code:
      "import figma from 'figma'\n\n" +
      '// Resolve nested components from the actual instance, so the snippet\n' +
      "// reflects what's placed in Figma — don't hardcode child markup.\n" +
      'const instance = figma.selectedInstance\n' +
      "const icon = instance.getInstanceSwap('Icon')\n\n" +
      'export default {\n' +
      '  example: figma.code`<Button>${icon.executeTemplate().example}</Button>`,\n' +
      "  id: 'button',\n" +
      '}',
    icon: 'seal-warning',
  },
  'pitfall.resultStringified': {
    group: 'pitfalls',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'Template result stringified',
    message: 'A nested component’s result is being treated as plain text, but it’s structured data — so it shows up as broken placeholder text in Dev Mode.',
    hint: 'Read .example (or .metadata) and interpolate it inside a figma.* tagged literal: figma.code`${child.executeTemplate().example}` — never with + or .join().',
    code:
      "import figma from 'figma'\n\n" +
      'const instance = figma.selectedInstance\n' +
      "const icon = instance.getInstanceSwap('Icon')\n\n" +
      'export default {\n' +
      '  // Interpolate .example INSIDE a figma.* tag — never build the string with\n' +
      '  // + or .join(), which stringifies the object to [object Object].\n' +
      '  example: figma.code`<Button>${icon.executeTemplate().example}</Button>`,\n' +
      "  id: 'button',\n" +
      '}',
    icon: 'seal-warning',
  },
  'pitfall.interleavedResults': {
    group: 'pitfalls',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'Joined template results',
    message: 'Collecting nested results into a list and stitching them together scrambles their pieces — it shows broken placeholder text and can crash the Dev Mode panel.',
    hint: 'Compose a single figma.* tagged literal instead — interpolate the results directly (an array of results renders fine inside the tag), rather than .push() + .join().',
    code:
      "import figma from 'figma'\n\n" +
      'const instance = figma.selectedInstance\n' +
      "const left = instance.getInstanceSwap('Leading')\n" +
      "const right = instance.getInstanceSwap('Trailing')\n\n" +
      'export default {\n' +
      '  // Compose ONE tagged literal and interpolate each result directly. Don’t\n' +
      '  // .push() results into an array and .join() them (that renders [object\n' +
      '  // Object] and can crash the Dev Mode panel).\n' +
      '  example: figma.code`${left.executeTemplate().example}${right.executeTemplate().example}`,\n' +
      "  id: 'toolbar',\n" +
      '}',
    icon: 'seal-warning',
  },
  'pitfall.undefinedInterpolation': {
    group: 'pitfalls',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'Interpolations are defined',
    message: 'Your snippet drops in a value that isn’t defined anywhere in the template, so it will show up as the word “undefined”.',
    hint: 'Define each interpolated value from the instance first — e.g. const size = instance.getEnum(\'Size\') — or drop it from the snippet.',
    code:
      "import figma from 'figma'\n\n" +
      '// Define every ${…} value before the snippet — usually off the instance —\n' +
      '// so nothing renders as `undefined`.\n' +
      'const instance = figma.selectedInstance\n' +
      "const size = instance.getEnum('Size')\n\n" +
      'export default {\n' +
      '  example: figma.code`<Icon size="${size}" />`,\n' +
      "  id: 'icon',\n" +
      '}',
    icon: 'seal-warning',
  },

  // ── Plugin conventions (opinionated, quietest by default) ───────────────────
  'ext.sourceMissing': {
    group: 'extensions',
    phase: 'structural',
    defaultLevel: 'comment',
    title: '// source= header',
    message: 'Your template doesn’t note which code file it maps to, so the connection won’t record it.',
    hint: 'Add // source=path/to/Component.tsx.',
    code:
      '// Records which code file this connection maps to:\n' +
      '// source=src/components/Button.tsx',
  },
  'ext.componentMissing': {
    group: 'extensions',
    phase: 'structural',
    defaultLevel: 'comment',
    title: '// component= header',
    message: 'Your template has no readable name, so it’ll show under its internal identifier instead.',
    hint: 'Add // component=ComponentName.',
    code:
      '// Gives the connection a readable name instead of falling back to its id:\n' +
      '// component=Button',
  },
  'ext.idNaming': {
    group: 'extensions',
    phase: 'structural',
    defaultLevel: 'comment',
    title: 'id naming convention',
    message: 'The identifier doesn’t follow the lowercase, hyphenated naming that other templates use.',
    hint: 'Prefer my-component — lowercase, hyphenated.',
    code:
      'export default {\n' +
      '  example: figma.code`<Button label="Save" />`,\n' +
      '  // Lowercase, hyphenated — the convention other templates follow.\n' +
      "  id: 'my-component',\n" +
      '}',
  },
  'ext.labelHint': {
    group: 'extensions',
    phase: 'structural',
    defaultLevel: 'comment',
    title: '// label= hint',
    message: 'Your template doesn’t say which platform to save under, so the plugin will pause to ask when you push it.',
    hint: 'Add // label=Web (etc.) to route it automatically.',
    code:
      '// Routes the template to a target on push (Web / iOS / Android) without\n' +
      '// stopping to ask:\n' +
      '// label=Web',
  },
  'ext.languageHint': {
    group: 'extensions',
    phase: 'structural',
    defaultLevel: 'comment',
    title: '// language= hint',
    message: 'Your template doesn’t say which language its snippet is, so a downloaded package can’t label the code correctly and falls back to a default.',
    hint: 'Add // language=typescript (etc.) — it sets the language in the generated Code Connect config.',
    code:
      '// Sets the snippet’s language in the generated figma.config.json when the\n' +
      '// template is downloaded as a package (typescript / javascript / html / …):\n' +
      '// language=typescript',
  },

  // ── Semantic (main thread — needs figma.*) ──────────────────────────────────
  // No code blocks here: these fire on Figma state (the node, its type, its
  // publish status), so the fix is an action in Figma — re-copy the link, point
  // at a component, publish the library — not a snippet to paste.
  'semantic.nodeNotFound': {
    group: 'semantic',
    phase: 'semantic',
    defaultLevel: 'comment',
    title: 'Node exists in this file',
    message: 'The component this template points to can’t be found in this file.',
    hint: 'Re-copy the component’s link, or open the file that contains it.',
    icon: 'cloud-x',
  },
  'semantic.notComponent': {
    group: 'semantic',
    phase: 'semantic',
    defaultLevel: 'error',
    title: 'URL is a component',
    message: 'This template points to something that isn’t a component or component set, and connections can only attach to components.',
    hint: 'Point the link at the main component or component set.',
    icon: 'file-x',
  },
  'semantic.notPublished': {
    group: 'semantic',
    phase: 'semantic',
    defaultLevel: 'error',
    title: 'Component is published',
    message: 'The component isn’t published to a library, so a saved connection would have nothing to attach to.',
    hint: 'Publish the component’s library, then save the template.',
    icon: 'globe-simple-x',
  },
} satisfies Record<string, RuleDef>

export type RuleId = keyof typeof RULES

export const RULE_IDS = Object.keys(RULES) as RuleId[]

export function ruleDef(id: RuleId): RuleDef {
  return RULES[id]
}

export function isSemantic(id: RuleId): boolean {
  return RULES[id].phase === 'semantic'
}

// Icon key for a rule: explicit override, else the group's icon.
export function ruleIcon(id: RuleId): string {
  const def: RuleDef = RULES[id]
  return def.icon ?? RULE_GROUPS[def.group].icon
}

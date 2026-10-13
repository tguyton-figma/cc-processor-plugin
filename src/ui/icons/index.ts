// ─── The Field icon set ───
//
// One registry, one weight: Phosphor `light` (@phosphor-icons/core). esbuild's
// `.svg=text` loader inlines each imported file as an SVG string, and only the
// icons imported here ship — the registry is tree-shaken, so the full 1,512-glyph
// light library is one import line away without bloating the bundle.
//
// To add an icon: `import x from '@phosphor-icons/core/assets/light/<name>-light.svg'`
// then add a `'<key>': x` line below. Keys are the semantic names the UI already
// speaks (stage glyphs, status marks, credential lifecycle) so call sites read as
// intent, not as Phosphor filenames.
//
// Phosphor light glyphs ship as `viewBox="0 0 256 256" fill="currentColor"` with a
// single <path> and no background rect, so they inherit `color` for free — the same
// contract our CSS already relies on.
//
// Two marks stay local because Phosphor's light weight has no equivalent: the Nav
// edge connector (a bespoke hairline arrow sized to the rail) and the filled status
// dot (light weight is all outlines — the "active" signal wants a solid disc).

// Stage / Nav glyphs
import figmaLogo from '@phosphor-icons/core/assets/light/figma-logo-light.svg'
import diamondsFour from '@phosphor-icons/core/assets/light/diamonds-four-light.svg'
import scroll from '@phosphor-icons/core/assets/light/scroll-light.svg'
import sparkle from '@phosphor-icons/core/assets/light/sparkle-light.svg'
import fileCode from '@phosphor-icons/core/assets/light/file-code-light.svg'
import warningDiamond from '@phosphor-icons/core/assets/light/warning-diamond-light.svg'
import nut from '@phosphor-icons/core/assets/light/nut-light.svg'

// Field controls
import floppyDisk from '@phosphor-icons/core/assets/light/floppy-disk-light.svg'
import trash from '@phosphor-icons/core/assets/light/trash-light.svg'
import copy from '@phosphor-icons/core/assets/light/copy-light.svg'
import faders from '@phosphor-icons/core/assets/light/faders-light.svg'
import arrowLeft from '@phosphor-icons/core/assets/light/arrow-left-light.svg'
import caretCircleLeft from '@phosphor-icons/core/assets/light/caret-circle-left-light.svg'
import caretCircleRight from '@phosphor-icons/core/assets/light/caret-circle-right-light.svg'
import gear from '@phosphor-icons/core/assets/light/gear-light.svg'
import plus from '@phosphor-icons/core/assets/light/plus-light.svg'
import fileTs from '@phosphor-icons/core/assets/light/file-ts-light.svg'
import fileZip from '@phosphor-icons/core/assets/light/file-zip-light.svg'

// Template file/signal navigation
import caretLeft from '@phosphor-icons/core/assets/light/caret-left-light.svg'
import caretRight from '@phosphor-icons/core/assets/light/caret-right-light.svg'
import caretLineLeft from '@phosphor-icons/core/assets/light/caret-line-left-light.svg'
import caretLineRight from '@phosphor-icons/core/assets/light/caret-line-right-light.svg'

// Status signals (per-component row + env resting)
import checkCircle from '@phosphor-icons/core/assets/light/check-circle-light.svg'
import xCircle from '@phosphor-icons/core/assets/light/x-circle-light.svg'
import circle from '@phosphor-icons/core/assets/light/circle-light.svg'
import minusCircle from '@phosphor-icons/core/assets/light/minus-circle-light.svg'
import caretDoubleRight from '@phosphor-icons/core/assets/light/caret-double-right-light.svg'

// Credential lifecycle (env fields)
import userCircleCheck from '@phosphor-icons/core/assets/light/user-circle-check-light.svg'
import arrowsClockwise from '@phosphor-icons/core/assets/light/arrows-clockwise-light.svg'
import globe from '@phosphor-icons/core/assets/light/globe-light.svg'

// Backend config routes (the "Backend" panel). Each route
// wears a link glyph that reads its state: a whole chain when set, a broken one when
// empty; the slug (a name, not a URL) keeps the broken-link mark, and the publish
// route a globe (its Variables write reaches the web).
import linkSimple from '@phosphor-icons/core/assets/light/link-simple-light.svg'
import linkSimpleBreak from '@phosphor-icons/core/assets/light/link-simple-break-light.svg'
import linkBreak from '@phosphor-icons/core/assets/light/link-break-light.svg'
import globeSimple from '@phosphor-icons/core/assets/light/globe-simple-light.svg'

// Bespoke local marks (no light-weight equivalent)
import edge from './pipeline/arrow.svg'
import circleFill from './pipeline/circle-fill.svg'

export const ICON = {
  // stage / nav
  'figma-platform': figmaLogo,
  'diamonds-four': diamondsFour,
  'generate-contract': scroll,
  transformer: sparkle,
  'template-file': fileCode,
  'warning-diamond': warningDiamond,
  nut,
  // field controls
  floppy: floppyDisk,
  trash,
  copy,
  faders,
  gear,
  plus,
  'file-ts': fileTs,
  'file-zip': fileZip,
  'arrow-left': arrowLeft,
  'caret-circle-left': caretCircleLeft,
  'caret-circle-right': caretCircleRight,
  'caret-left': caretLeft,
  'caret-right': caretRight,
  'caret-line-left': caretLineLeft,
  'caret-line-right': caretLineRight,
  // status signals
  'check-circle': checkCircle,
  'x-circle': xCircle,
  circle,
  'circle-fill': circleFill,
  'minus-circle': minusCircle,
  skip: caretDoubleRight,
  // credential lifecycle
  'user-circle-check': userCircleCheck,
  'arrows-clockwise': arrowsClockwise,
  globe,
  // backend config routes
  'link-simple': linkSimple,
  'link-simple-break': linkSimpleBreak,
  'link-break': linkBreak,
  'globe-simple': globeSimple,
  // nav connector
  edge,
} as const

export type IconName = keyof typeof ICON

// The SVG string for a registered icon (empty string for an unknown name, so a
// caller never injects `undefined` into markup).
export function icon(name: IconName): string {
  return ICON[name] || ''
}

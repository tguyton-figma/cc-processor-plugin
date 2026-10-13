// SVG icon set, imported as raw markup (esbuild `loader: { '.svg': 'text' }`) and
// bundled into the UI. Each glyph uses fill="currentColor" so the panel can tint
// it per severity with plain CSS. Keys match the icon names referenced by the
// rule registry (rules.ts) and the severity/summary display.
import asterisk from '../ui/icons/asterisk.svg'
import chatTeardrop from '../ui/icons/chat-teardrop.svg'
import checkCircle from '../ui/icons/check-circle.svg'
import checkFat from '../ui/icons/check-fat.svg'
import cloudWarning from '../ui/icons/cloud-warning.svg'
import cloudX from '../ui/icons/cloud-x.svg'
import fileX from '../ui/icons/file-x.svg'
import globeSimpleX from '../ui/icons/globe-simple-x.svg'
import linkBreak from '../ui/icons/link-break.svg'
import linkSimpleBreak from '../ui/icons/link-simple-break.svg'
import modeComment from '../ui/icons/mode-comment.svg'
import modeError from '../ui/icons/mode-error.svg'
import modeMute from '../ui/icons/mode-mute.svg'
import sealWarning from '../ui/icons/seal-warning.svg'
import shieldWarning from '../ui/icons/shield-warning.svg'
import warning from '../ui/icons/warning.svg'
import warningCircle from '../ui/icons/warning-circle.svg'
import warningDiamond from '../ui/icons/warning-diamond.svg'
import warningOctagon from '../ui/icons/warning-octagon.svg'
import x from '../ui/icons/x.svg'
import xCircle from '../ui/icons/x-circle.svg'
import type { Severity } from './severity'

export const ICONS: Record<string, string> = {
  asterisk,
  'chat-teardrop': chatTeardrop,
  'check-circle': checkCircle,
  'check-fat': checkFat,
  'cloud-warning': cloudWarning,
  'cloud-x': cloudX,
  'file-x': fileX,
  'globe-simple-x': globeSimpleX,
  'link-break': linkBreak,
  'link-simple-break': linkSimpleBreak,
  'mode-comment': modeComment,
  'mode-error': modeError,
  'mode-mute': modeMute,
  'seal-warning': sealWarning,
  'shield-warning': shieldWarning,
  warning,
  'warning-circle': warningCircle,
  'warning-diamond': warningDiamond,
  'warning-octagon': warningOctagon,
  x,
  'x-circle': xCircle,
}

export function icon(name: string): string {
  return ICONS[name] ?? ''
}

// The 3-way mode toggle in the config UI: one glyph per severity level.
export const MODE_ICON: Record<Severity, string> = {
  error: 'mode-error',
  comment: 'mode-comment',
  mute: 'mode-mute',
}

// The glyph shown next to an individual issue, by its effective severity.
export const SEVERITY_ICON: Record<Exclude<Severity, 'mute'>, string> = {
  error: 'x-circle',
  comment: 'chat-teardrop',
}

// The overall validation-state signal at the top of the panel.
export const STATE_ICON = {
  pass: 'check-circle',
  error: 'x-circle',
  comment: 'chat-teardrop',
} as const

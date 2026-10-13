// The three global severity levels a rule can be tuned to.
//
//   error   → hard validation fail (blocks push)
//   comment → quiet neutral signal; passes (our opinionated defaults live here)
//   mute    → check disabled entirely
//
// "comment" is the quietest signal that still surfaces; "mute" turns a check off.
// There is deliberately no loud non-blocking "warn" tier — a finding either blocks
// (error) or reads as a quiet note (comment). This keeps the panel calm and honest:
// nothing shouts unless it actually stops a push.
export type Severity = 'error' | 'comment' | 'mute'

// Display/toggle order (loudest → quietest → disabled). The config UI cycles
// through these; the summary counts them in this order too.
export const SEVERITY_ORDER: Severity[] = ['error', 'comment', 'mute']

// Only 'error' blocks a push. Everything else is informational.
export function blocks(level: Severity): boolean {
  return level === 'error'
}

// A run passes when no *effective* issue is an error. 'mute' issues never make it
// into the list, so this only ever sees error/comment.
export function passes(levels: Severity[]): boolean {
  return !levels.some(blocks)
}

// Human labels for the config UI toggle.
export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  comment: 'Comment',
  mute: 'Mute',
}

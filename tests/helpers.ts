// Shared test helpers: fixture loading + a compact validation fingerprint.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate } from '../src/engine'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

// A compact, reviewable summary of what a template validates to: the overall
// state and the sorted rule ids that fired, each with its effective level.
export function fingerprint(text: string) {
  const res = validate(text)
  return {
    state: res.summary.state,
    errors: res.summary.errors,
    comments: res.summary.comments,
    rules: res.issues.map((i) => `${i.level}:${i.ruleId}`).sort(),
  }
}

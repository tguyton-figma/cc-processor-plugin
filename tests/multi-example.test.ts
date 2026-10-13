// The multi-example fix — Phase 1 (lezer AST parser).
//
// The old regex parsers extracted only the FIRST `figma.code`` literal, so a
// template whose `example` is a function returning different snippets per branch
// was linted on branch #1 alone — branches 2..N were invisible. The AST parser
// collects EVERY tagged template under the `example` key, so example-level rules
// now see all branches.
//
// fixtures/multi-example.figma.ts has a clean first branch and a second branch
// that interpolates an undefined `${missingLabel}`. That second branch must now
// be flagged.
import { describe, expect, it } from 'vitest'
import { validate } from '../src/engine'
import { parseTemplate } from '../src/engine/parse'
import { readFixture } from './helpers'

describe('multi-example templates', () => {
  const text = readFixture('multi-example.figma.ts')

  it('parses every branch, not just the first', () => {
    const parsed = parseTemplate(text)
    expect(parsed.examples.map((e) => e.code)).toEqual([
      '<Button variant="primary" />',
      '<Button variant="secondary" label="${missingLabel}" />',
    ])
  })

  it('flags an undefined interpolation in a later branch', () => {
    const fired = validate(text).issues.map((i) => i.ruleId)
    expect(fired).toContain('pitfall.undefinedInterpolation')
  })
})

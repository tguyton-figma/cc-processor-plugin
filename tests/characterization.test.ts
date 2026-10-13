// Characterization tests — the safety net for the engine refactor.
//
// These lock in the CURRENT observable behavior of `validate()` over a corpus of
// real template files. They make no claim that today's behavior is *correct* — they
// only pin it, so Phase 1 (lezer parser) and Phase 2 (drop Zod) can be proven
// behavior-preserving: any drift shows up as a snapshot diff to review deliberately.
//
// Known-wrong behavior is captured too (see multi-example.test.ts) so the refactor
// has an explicit target to flip green.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fingerprint, readFixture } from './helpers'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.figma.ts'))
  .sort()

describe('validate() corpus fingerprint', () => {
  for (const name of fixtureNames) {
    it(name, () => {
      expect(fingerprint(readFixture(name))).toMatchSnapshot()
    })
  }
})

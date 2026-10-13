// stripCodeFence guards the stage-4 → stage-5 boundary: some models wrap their
// template in a Markdown fence despite the prompt, and a fenced file trips the
// validation signals. The load-bearing property is that it strips ONLY a fence
// wrapping the whole output — never the backticks a template legitimately carries.
import { describe, expect, it } from 'vitest'
import { stripCodeFence } from '../src/ui/transformer'

const TEMPLATE = [
  '// url=https://www.figma.com/design/abc/File?node-id=1-2',
  "import figma from 'figma'",
  'const instance = figma.selectedInstance',
  "const label = instance.getString('Label')",
  'export default {',
  '  example: figma.code`<Button>${label}</Button>`,',
  "  id: 'button',",
  '}',
].join('\n')

describe('stripCodeFence', () => {
  it('strips a ```ts fence wrapping the whole file', () => {
    expect(stripCodeFence('```ts\n' + TEMPLATE + '\n```')).toBe(TEMPLATE)
  })

  it('strips a bare ``` fence (no language token)', () => {
    expect(stripCodeFence('```\n' + TEMPLATE + '\n```')).toBe(TEMPLATE)
  })

  it('strips other language tokens (tsx, typescript)', () => {
    expect(stripCodeFence('```tsx\n' + TEMPLATE + '\n```')).toBe(TEMPLATE)
    expect(stripCodeFence('```typescript\n' + TEMPLATE + '\n```')).toBe(TEMPLATE)
  })

  it('leaves an unfenced file untouched', () => {
    expect(stripCodeFence(TEMPLATE)).toBe(TEMPLATE)
  })

  it('preserves the template’s own figma.code`…` backticks', () => {
    expect(stripCodeFence('```ts\n' + TEMPLATE + '\n```')).toContain(
      'figma.code`<Button>${label}</Button>`',
    )
  })

  it('handles a mid-stream chunk: opening fence stripped, no closing yet', () => {
    const partial = '```ts\n// url=https://www.figma.com/design/abc/File?node-id=1-2\nimport figma'
    expect(stripCodeFence(partial)).toBe(
      '// url=https://www.figma.com/design/abc/File?node-id=1-2\nimport figma',
    )
  })

  it('trims surrounding whitespace around a fence', () => {
    expect(stripCodeFence('\n\n```ts\n' + TEMPLATE + '\n```\n\n')).toBe(TEMPLATE)
  })
})

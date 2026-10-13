// The download-package assembler — the Dev Mode publish fallback's file layout.
//
// assemblePackageEntries turns a DownloadPackage (drafts + contracts gathered on the
// main thread) into the archive's files. The one load-bearing decision it encodes:
// a figma.config.json's `label` is single-valued and applies to a whole publish, so
// the LABEL is the publish boundary. These tests pin that boundary in both regimes —
// flat for one label, split subfolders for many — plus the reference-only contract
// placement, the frontmatter→config projection, and collision handling.
import { describe, expect, it } from 'vitest'
import { assemblePackageEntries, safeSegment, type DownloadPackage, type PackageComponent } from '../src/ui/package'

// A template body is opaque to the assembler (it only trims + re-terminates it), so a
// marker string is enough to prove which file got which draft.
function comp(p: Partial<PackageComponent> & { component: string }): PackageComponent {
  return {
    component: p.component,
    label: p.label ?? '',
    language: p.language ?? '',
    template: p.template ?? `// draft for ${p.component}\n`,
    contract: 'contract' in p ? p.contract : null,
  }
}

function pkg(components: PackageComponent[], over: Partial<DownloadPackage> = {}): DownloadPackage {
  return {
    fileKey: over.fileKey ?? 'FILEKEY',
    library: over.library ?? 'Lib',
    generatedAt: over.generatedAt ?? '2026-01-01T00:00:00.000Z',
    components,
  }
}

// path → text, for terse assertions.
function byPath(entries: ReturnType<typeof assemblePackageEntries>): Map<string, string> {
  return new Map(entries.map((e) => [e.path, e.text]))
}
function paths(entries: ReturnType<typeof assemblePackageEntries>): string[] {
  return entries.map((e) => e.path)
}
function config(text: string) {
  return JSON.parse(text).codeConnect as { include: string[]; label: string; language: string }
}

describe('safeSegment', () => {
  it('strips path-hostile characters', () => {
    expect(safeSegment('Foo/Bar:Baz')).toBe('Foo-Bar-Baz')
    expect(safeSegment('a\\b*c?"<>|')).toBe('a-b-c-') // trailing run collapses to one '-'
  })
  it('collapses whitespace and strips leading dots', () => {
    expect(safeSegment('..Hidden   Name  ')).toBe('Hidden Name')
  })
  it('falls back to "component" only when nothing survives', () => {
    expect(safeSegment('')).toBe('component')
    expect(safeSegment('...')).toBe('component') // leading dots stripped → empty
    expect(safeSegment('///')).toBe('-') // path chars map to '-', which is non-empty
  })
})

describe('single label → flat layout', () => {
  const entries = assemblePackageEntries(
    pkg([
      comp({ component: 'Avatar', label: 'Web', language: 'typescript', contract: { _schema: 'x', a: 1 } }),
      comp({ component: 'Button', label: 'Web', language: 'typescript' }),
    ]),
  )
  const map = byPath(entries)

  it('places templates at the root (no label subfolder)', () => {
    expect(map.has('code-connect/Avatar.figma.ts')).toBe(true)
    expect(map.has('code-connect/Button.figma.ts')).toBe(true)
  })
  it('writes exactly one config at the root', () => {
    const configs = paths(entries).filter((p) => p.endsWith('figma.config.json'))
    expect(configs).toEqual(['code-connect/figma.config.json'])
  })
  it('projects label + language from frontmatter into the config', () => {
    const c = config(map.get('code-connect/figma.config.json')!)
    expect(c.label).toBe('Web')
    expect(c.language).toBe('typescript')
    expect(c.include).toEqual(['**/*.figma.ts'])
  })
  it('puts contracts under a top-level contracts/ folder, only when present', () => {
    expect(map.has('code-connect/contracts/Avatar.contract.json')).toBe(true)
    expect(map.has('code-connect/contracts/Button.contract.json')).toBe(false)
  })
  it('ships a README that names the single publish command', () => {
    const readme = map.get('code-connect/README.md')!
    expect(readme).toContain('npx figma connect publish')
    expect(readme).not.toContain('for d in */')
  })
})

describe('multiple labels → split subfolders', () => {
  const entries = assemblePackageEntries(
    pkg([
      comp({ component: 'Avatar', label: 'Web', language: 'typescript' }),
      comp({ component: 'Avatar', label: 'iOS', language: 'swift', contract: { native: true } }),
      comp({ component: 'Button', label: 'Web', language: 'typescript' }),
    ]),
  )
  const map = byPath(entries)

  it('nests each label in its own subfolder', () => {
    expect(map.has('code-connect/Web/Avatar.figma.ts')).toBe(true)
    expect(map.has('code-connect/Web/Button.figma.ts')).toBe(true)
    expect(map.has('code-connect/iOS/Avatar.figma.ts')).toBe(true)
  })
  it('writes one config per label, each projecting its own language', () => {
    expect(config(map.get('code-connect/Web/figma.config.json')!)).toMatchObject({ label: 'Web', language: 'typescript' })
    expect(config(map.get('code-connect/iOS/figma.config.json')!)).toMatchObject({ label: 'iOS', language: 'swift' })
  })
  it('keeps contracts shared + top-level, not duplicated per label', () => {
    const contractPaths = paths(entries).filter((p) => p.includes('/contracts/'))
    expect(contractPaths).toEqual(['code-connect/contracts/Avatar.contract.json'])
  })
  it('ships a README with the publish-all loop', () => {
    expect(map.get('code-connect/README.md')!).toContain('for d in */')
  })
})

describe('collisions and edge cases', () => {
  it('disambiguates two distinct components that sanitize to the same filename', () => {
    const entries = assemblePackageEntries(
      pkg([comp({ component: 'Foo/Bar', label: 'Web' }), comp({ component: 'Foo:Bar', label: 'Web' })]),
    )
    const templates = paths(entries).filter((p) => p.endsWith('.figma.ts'))
    expect(templates).toEqual(['code-connect/Foo-Bar.figma.ts', 'code-connect/Foo-Bar-2.figma.ts'])
  })

  it('falls back to defaults when no label/language authored', () => {
    const entries = assemblePackageEntries(pkg([comp({ component: 'Button' })]))
    const c = config(byPath(entries).get('code-connect/figma.config.json')!)
    expect(c).toMatchObject({ label: 'React', language: 'jsx' })
  })

  it('names an unlabeled subfolder when a blank label coexists with a real one', () => {
    const entries = assemblePackageEntries(
      pkg([comp({ component: 'Button', label: '' }), comp({ component: 'Avatar', label: 'Web' })]),
    )
    expect(byPath(entries).has('code-connect/unlabeled/Button.figma.ts')).toBe(true)
    expect(byPath(entries).has('code-connect/Web/Avatar.figma.ts')).toBe(true)
  })

  it('re-terminates a template with exactly one trailing newline', () => {
    const entries = assemblePackageEntries(pkg([comp({ component: 'Button', label: 'Web', template: 'body\n\n\n' })]))
    expect(byPath(entries).get('code-connect/Button.figma.ts')).toBe('body\n')
  })

  it('notes the missing file key in the README when fileKey is empty', () => {
    const entries = assemblePackageEntries(pkg([comp({ component: 'Button', label: 'Web' })], { fileKey: '' }))
    expect(byPath(entries).get('code-connect/README.md')!).toContain('File key not set')
  })
})

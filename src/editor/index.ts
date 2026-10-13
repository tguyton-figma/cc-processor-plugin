// A small, self-contained CodeMirror 6 wrapper for the Template panel's code
// editor. esbuild bundles this into an IIFE exposed as `window.CCEditor` (see
// .figma/make/build-ui.mjs), inlined into ui.html the same way the validation
// engine is — the plugin iframe can't load scripts off the network, so every
// dependency ships inside the HTML.
//
// The surface is deliberately tiny: one `create()` that mounts an editor into a
// container and hands back a textarea-shaped handle (getValue / setValue /
// focus), plus onChange / onEscape callbacks. That lets the panel controller in
// ui.html keep treating the editor like the <textarea> it replaced.

import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder as placeholderExt,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language'
import { javascript, typescriptLanguage } from '@codemirror/lang-javascript'
import { tags as t, highlightTree, tagHighlighter, type Tag } from '@lezer/highlight'

// Editor chrome — a quiet dark surface that defers to the plugin's own palette
// (the same --figma-color-* variables the rest of ui.html uses). No border: the
// panel it sits in already provides the rounded background, and colored strokes
// are off-limits in this UI.
const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      width: '100%',
      color: 'var(--text-2)',
      backgroundColor: 'transparent',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none', color: 'var(--text)' },
    '.cm-scroller': {
      fontFamily: "'SF Mono', 'Menlo', ui-monospace, monospace",
      lineHeight: '1.6',
      // No padding here: the scroller wraps BOTH the gutter and the content, so any
      // padding on it insets the gutter and leaves a gap at the top/left/bottom
      // edges of the editor card. Breathing room lives on .cm-content instead (the
      // gutter numbers track the content's line positions), so the numbers field
      // runs the full height of the editor and sits flush to its edges.
      padding: '0',
    },
    // Text breathing room — top/bottom + a right margin. Left is 0 so the content
    // butts against the gutter (whose own right padding provides number↔code space).
    '.cm-content': { caretColor: 'var(--text)', padding: '8px 12px 8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(13, 153, 255, 0.20)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(13, 153, 255, 0.32)' },
    // Line-number gutter: a recessed well tone (darker than the editor surface) so
    // the numbers read as their own field. It runs the full editor height, flush to
    // the top/left/bottom edges (the scroller carries no padding). CodeMirror keeps
    // it fixed to the left on horizontal scroll, so it needs an OPAQUE background —
    // scrolled code slides behind it instead of showing through the numbers.
    '.cm-gutters': {
      backgroundColor: 'var(--pl-panel)',
      color: 'var(--text-3)',
      border: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 20px', minWidth: '32px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
    '.cm-placeholder': { color: 'var(--text-3)' },
    // Keep the caret visible against the dark surface.
    '.cm-selectionMatch': { backgroundColor: 'rgba(255, 255, 255, 0.06)' },
  },
  { dark: true }
)

// TypeScript syntax colors — a restrained material-dark palette tuned to read
// well on the panel's #383838 surface. Kept as one array so the live editor
// (HighlightStyle, below) and the static highlighter that renders read-only code
// blocks (`highlight()`, below) tokenize with the exact same colors.
interface PaletteEntry {
  tags: Tag | readonly Tag[]
  color: string
  fontStyle?: string
}
const PALETTE: PaletteEntry[] = [
  { tags: [t.keyword, t.modifier, t.operatorKeyword], color: '#c792ea' },
  { tags: [t.controlKeyword, t.moduleKeyword], color: '#c792ea' },
  { tags: [t.name, t.deleted, t.character, t.macroName], color: '#e6e6e6' },
  { tags: [t.propertyName], color: '#82aaff' },
  { tags: [t.function(t.variableName), t.labelName], color: '#82aaff' },
  { tags: [t.definition(t.name), t.separator], color: '#e6e6e6' },
  { tags: [t.typeName, t.className, t.namespace], color: '#ffcb6b' },
  { tags: [t.number, t.bool, t.null, t.atom], color: '#f78c6c' },
  { tags: [t.constant(t.name), t.standard(t.name)], color: '#f78c6c' },
  { tags: [t.string, t.special(t.string), t.inserted], color: '#c3e88d' },
  { tags: [t.regexp, t.escape], color: '#c3e88d' },
  { tags: [t.operator], color: '#89ddff' },
  { tags: [t.punctuation, t.bracket], color: '#a0a0a0' },
  { tags: [t.comment, t.blockComment, t.lineComment], color: '#6f6f6f', fontStyle: 'italic' },
  { tags: [t.meta, t.annotation], color: '#a0a0a0' },
  { tags: t.invalid, color: '#ff8577' },
]

const highlightStyle = HighlightStyle.define(
  PALETTE.map((p) => (p.fontStyle ? { tag: p.tags, color: p.color, fontStyle: p.fontStyle } : { tag: p.tags, color: p.color }))
)

export interface EditorHandle {
  /** Current document text. */
  getValue(): string
  /** Replace the whole document. */
  setValue(text: string): void
  /** Move keyboard focus into the editor. */
  focus(): void
  /** The underlying CodeMirror view, for advanced callers. */
  view: EditorView
}

export interface CreateOptions {
  /** Initial document text. */
  doc?: string
  /** Placeholder shown while the document is empty. */
  placeholder?: string
  /** Fired after every document change (typing, paste, programmatic edits). */
  onChange?: (value: string) => void
  /** Fired when Escape is pressed inside the editor. */
  onEscape?: () => void
  /**
   * Read-only viewer: the document can't be edited (no caret, no input), but it
   * still highlights, scrolls, and shows the line-number gutter. Used for the
   * contract accordion, where the JSON is generated, not hand-authored.
   */
  readOnly?: boolean
}

// Mount an editor into `parent` and return a textarea-shaped handle.
export function create(parent: HTMLElement, opts: CreateOptions = {}): EditorHandle {
  const onChange = opts.onChange
  const onEscape = opts.onEscape

  const escapeKey = onEscape
    ? [
        {
          key: 'Escape',
          run: () => {
            onEscape()
            return true
          },
        },
      ]
    : []

  // Read-only viewer: block edits but keep highlighting, scrolling, selection and
  // the gutter. Active-line emphasis is dropped — with no caret it just adds noise.
  const readOnly = !!opts.readOnly
  const editExts = readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [highlightActiveLine(), highlightActiveLineGutter(), history(), indentOnInput()]

  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      lineNumbers(),
      ...editExts,
      drawSelection(),
      bracketMatching(),
      syntaxHighlighting(highlightStyle, { fallback: true }),
      javascript({ typescript: true }),
      placeholderExt(opts.placeholder || ''),
      EditorState.tabSize.of(2),
      // Escape first so it wins over any default binding; indentWithTab keeps Tab
      // in the editor instead of moving focus out of the iframe.
      keymap.of([...escapeKey, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onChange) onChange(u.state.doc.toString())
      }),
    ],
  })

  const view = new EditorView({ state, parent })

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (text: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text || '' },
      }),
    focus: () => view.focus(),
    view,
  }
}

// ── Static highlighting ──────────────────────────────────────────────────────
// The signal canvas renders read-only code blocks by rebuilding innerHTML (it
// paginates by measuring heights), so a live EditorView per block would be torn
// down and remounted on every render. Instead we reuse CodeMirror's TypeScript
// parser and the shared PALETTE to emit a static string of colored <span>s —
// same tokens, same colors, zero editor overhead, and safe to drop into HTML.

// Map each palette entry to an opaque class, then look the color back up by that
// class when highlightTree hands it to us.
const staticHighlighter = tagHighlighter(PALETTE.map((p, i) => ({ tag: p.tags, class: `cchl-${i}` })))
const CLASS_STYLE: Record<string, string> = {}
PALETTE.forEach((p, i) => {
  CLASS_STYLE[`cchl-${i}`] = `color:${p.color}` + (p.fontStyle ? `;font-style:${p.fontStyle}` : '')
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Tokenize `code` as TypeScript and return HTML with inline-styled spans. The
// output is fully self-contained (no CSS classes to inject) and every text run
// is HTML-escaped, so callers can drop it straight into innerHTML.
export function highlight(code: string): string {
  const src = code || ''
  const tree = typescriptLanguage.parser.parse(src)
  let out = ''
  let pos = 0
  const emit = (from: number, to: number, style: string) => {
    if (to <= from) return
    const text = escapeHtml(src.slice(from, to))
    out += style ? `<span style="${style}">${text}</span>` : text
  }
  highlightTree(tree, staticHighlighter, (from, to, classes) => {
    if (from > pos) emit(pos, from, '') // untokenized gap (whitespace, etc.)
    emit(from, to, CLASS_STYLE[classes] || CLASS_STYLE[classes.split(' ')[0]] || '')
    pos = to
  })
  if (pos < src.length) emit(pos, src.length, '')
  return out
}

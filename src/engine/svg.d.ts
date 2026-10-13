// SVG files are imported as raw text (esbuild `loader: { '.svg': 'text' }`).
declare module '*.svg' {
  const content: string
  export default content
}

// url=https://www.figma.com/design/abc123/File?node-id=1-2
// source=src/Button.tsx
// component=Button
// label=Web
import figma from 'figma'

const instance = figma.selectedInstance
const variant = instance.getEnum('Variant')

export default {
  // A multi-branch mapping: the FIRST branch is clean, but the SECOND branch
  // interpolates a value that is never defined in the file. The current parser
  // reads only the first tagged literal, so the bad second branch is invisible.
  example: () => {
    if (variant === 'primary') return figma.code`<Button variant="primary" />`
    return figma.code`<Button variant="secondary" label="${missingLabel}" />`
  },
  id: 'button',
}

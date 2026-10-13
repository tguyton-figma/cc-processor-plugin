// url=https://www.figma.com/design/abc123/File?node-id=1-2
// source=src/Card.tsx
// component=Card
// label=Web
import figma from 'figma'

const instance = figma.selectedInstance
const child = instance.getInstanceSwap('Icon')

export default {
  example: figma.code`<Card>${child.executeTemplate()}</Card>`,
  id: 'card',
}

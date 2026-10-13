// url=https://www.figma.com/design/abc123/File?node-id=1-2
// source=src/Avatar.tsx
// component=Avatar
// label=Web
import figma from 'figma'

const instance = figma.selectedInstance
const size = instance.getEnum('Size')
const child = instance.getInstanceSwap('Icon')

export default {
  example: figma.code`<Avatar size="${size}">${child.executeTemplate().example}</Avatar>`,
  id: 'avatar',
}

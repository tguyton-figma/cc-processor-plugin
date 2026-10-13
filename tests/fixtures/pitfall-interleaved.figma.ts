// url=https://www.figma.com/design/abc123/File?node-id=1-2
// source=src/List.tsx
// component=List
// label=Web
import figma from 'figma'

const instance = figma.selectedInstance
const rows = []
rows.push(figma.code`<Row />`)
rows.push(figma.code`<Row />`)

export default {
  example: figma.code`<List>${rows.join('\n')}</List>`,
  id: 'list',
}

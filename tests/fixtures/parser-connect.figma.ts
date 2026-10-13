// url=https://www.figma.com/design/abc123/File?node-id=1-2
// source=src/Button.tsx
// component=Button
// label=Web
import figma from 'figma'

figma.connect(Button, 'https://www.figma.com/design/abc123/File?node-id=1-2', {
  example: () => <Button />,
})

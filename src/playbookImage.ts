import {paintDrawing} from './drawing'
import type {Book, Player} from './types'

const WIDTH = 1_400
const MARGIN = 90
const HEADER_HEIGHT = 250
const TEXT_HEIGHT = 700
const DRAWING_HEIGHT = 980
const FOOTER_HEIGHT = 90
const MAX_CANVAS_EDGE = 30_000

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fill()
  context.stroke()
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = (text || 'An empty description').split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return cleaned || 'playbook'
}

export async function downloadPlaybookImage(
  book: Book,
  players: Record<string, Player>,
): Promise<void> {
  await document.fonts?.ready
  const logicalHeight =
    HEADER_HEIGHT +
    book.entries.reduce(
      (height, entry) =>
        height +
        (entry.content.kind === 'drawing' ? DRAWING_HEIGHT : TEXT_HEIGHT),
      0,
    ) +
    FOOTER_HEIGHT
  const scale = Math.min(1, MAX_CANVAS_EDGE / logicalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(WIDTH * scale)
  canvas.height = Math.round(logicalHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to create the playbook image.')
  context.scale(scale, scale)

  context.fillStyle = '#f5f0e7'
  context.fillRect(0, 0, WIDTH, logicalHeight)
  context.fillStyle = '#f15b43'
  context.fillRect(0, 0, 24, logicalHeight)

  const owner = players[book.ownerId]
  context.fillStyle = '#20201f'
  context.font = '800 76px Manrope, system-ui, sans-serif'
  context.fillText(`${owner?.name ?? 'Player'}’s playbook`, MARGIN, 112)
  context.fillStyle = '#6d6b66'
  context.font = '500 25px "DM Mono", monospace'
  context.fillText(
    `${book.entries.length} pages · Teleopstrations`,
    MARGIN,
    165,
  )
  context.strokeStyle = '#d8d1c5'
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(MARGIN, 205)
  context.lineTo(WIDTH - MARGIN, 205)
  context.stroke()

  let y = HEADER_HEIGHT
  book.entries.forEach((entry, index) => {
    const isDrawing = entry.content.kind === 'drawing'
    const sectionHeight = isDrawing ? DRAWING_HEIGHT : TEXT_HEIGHT
    const cardX = MARGIN
    const cardY = y + 18
    const cardWidth = WIDTH - MARGIN * 2
    const cardHeight = sectionHeight - 36

    context.fillStyle = '#fffdf8'
    context.strokeStyle = '#d8d1c5'
    context.lineWidth = 2
    roundedRect(context, cardX, cardY, cardWidth, cardHeight, 24)

    context.fillStyle = '#2967e8'
    context.beginPath()
    context.arc(cardX + 54, cardY + 54, 30, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#ffffff'
    context.font = '800 25px Manrope, system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText(String(index + 1), cardX + 54, cardY + 63)
    context.textAlign = 'left'

    const author = players[entry.authorId]
    context.fillStyle = '#6d6b66'
    context.font = '500 20px "DM Mono", monospace'
    context.fillText(
      isDrawing ? 'THEY DREW…' : index === 0 ? 'THE PROMPT…' : 'THEY GUESSED…',
      cardX + 105,
      cardY + 60,
    )
    context.textAlign = 'right'
    context.fillText(
      `BY ${(author?.name ?? 'PLAYER').toUpperCase()}`,
      cardX + cardWidth - 38,
      cardY + 60,
    )
    context.textAlign = 'left'

    if (entry.content.kind === 'drawing') {
      const bounds = {
        x: cardX + 45,
        y: cardY + 100,
        width: cardWidth - 90,
        height: cardHeight - 145,
      }
      context.fillStyle = '#ffffff'
      context.strokeStyle = '#e3ddd3'
      roundedRect(
        context,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        12,
      )
      paintDrawing(context, entry.content.strokes, bounds)
    } else {
      context.fillStyle = '#20201f'
      context.font = '700 48px Manrope, system-ui, sans-serif'
      const lines = wrapText(
        context,
        entry.content.text,
        cardWidth - 120,
      )
      lines.slice(0, 8).forEach((line, lineIndex) => {
        context.fillText(line, cardX + 60, cardY + 150 + lineIndex * 62)
      })
    }

    y += sectionHeight
  })

  context.fillStyle = '#6d6b66'
  context.font = '500 18px "DM Mono", monospace'
  context.fillText('DRAW IT · GUESS IT · PASS IT ON', MARGIN, logicalHeight - 35)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value)
      else reject(new Error('Unable to encode the playbook image.'))
    }, 'image/png')
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFileName(owner?.name ?? 'playbook')}-playbook.png`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

import type {Stroke} from './types'

export const DRAWING_COLORS = [
  '#171717',
  '#5b6472',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#facc15',
  '#84cc16',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
  '#92400e',
]

export const PEN_SIZES = [2, 4, 7, 11, 16, 23, 32, 44]

export interface DrawingBounds {
  x: number
  y: number
  width: number
  height: number
}

export function paintStroke(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  bounds: DrawingBounds = {
    x: 0,
    y: 0,
    width: context.canvas.width,
    height: context.canvas.height,
  },
): void {
  const color = DRAWING_COLORS[stroke.color] ?? DRAWING_COLORS[0]
  const width =
    (PEN_SIZES[stroke.size] ?? PEN_SIZES[2]) * (bounds.width / 1_000)
  context.strokeStyle = color
  context.fillStyle = color
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, width)

  if (stroke.points.length === 1) {
    const point = stroke.points[0]
    context.beginPath()
    context.arc(
      bounds.x + point.x * bounds.width,
      bounds.y + point.y * bounds.height,
      Math.max(1, width / 2),
      0,
      Math.PI * 2,
    )
    context.fill()
    return
  }

  context.beginPath()
  stroke.points.forEach((point, index) => {
    const x = bounds.x + point.x * bounds.width
    const y = bounds.y + point.y * bounds.height
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.stroke()
}

export function paintDrawing(
  context: CanvasRenderingContext2D,
  strokes: Stroke[],
  bounds?: DrawingBounds,
): void {
  for (const stroke of strokes) paintStroke(context, stroke, bounds)
}

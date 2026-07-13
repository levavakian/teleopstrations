import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {createId} from './game'
import {DRAWING_COLORS, PEN_SIZES, paintDrawing, paintStroke} from './drawing'
import type {DrawPoint, Stroke} from './types'

interface CanvasSurfaceProps {
  strokes: Stroke[]
  onChange?: (strokes: Stroke[]) => void
  readOnly?: boolean
  label?: string
}

function pointOnCanvas(
  event: ReactPointerEvent<HTMLCanvasElement>,
): DrawPoint {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    pressure: event.pressure || 0.5,
  }
}

export function DrawingCanvas({
  strokes,
  onChange,
  readOnly = false,
  label = 'Drawing canvas',
}: CanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const currentStrokeRef = useRef<Stroke | null>(null)
  const [color, setColor] = useState(0)
  const [size, setSize] = useState(2)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    paintDrawing(context, strokes)
  }, [strokes])

  useEffect(redraw, [redraw])

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !onChange) return
    event.currentTarget.setPointerCapture(event.pointerId)
    currentStrokeRef.current = {
      id: createId(),
      color,
      size,
      points: [pointOnCanvas(event)],
    }
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = currentStrokeRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!stroke || !canvas || !context) return

    const point = pointOnCanvas(event)
    const previous = stroke.points[stroke.points.length - 1]
    stroke.points.push(point)
    paintStroke(context, {...stroke, points: [previous, point]})
  }

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = currentStrokeRef.current
    if (!stroke || !onChange) return
    if (stroke.points.length === 1) {
      const context = canvasRef.current?.getContext('2d')
      if (context) paintStroke(context, stroke)
    }
    currentStrokeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onChange([...strokes, stroke])
  }

  return (
    <div className={`drawing-shell${readOnly ? ' drawing-shell--readonly' : ''}`}>
      <canvas
        ref={canvasRef}
        width={1000}
        height={700}
        aria-label={label}
        className="drawing-canvas"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      {!readOnly && onChange ? (
        <div className="drawing-tools">
          <fieldset className="palette">
            <legend>Ink color</legend>
            <div className="palette__grid">
              {DRAWING_COLORS.map((hex, index) => (
                <button
                  className={`swatch${color === index ? ' is-selected' : ''}`}
                  style={{'--swatch': hex} as CSSProperties}
                  type="button"
                  aria-label={`Color ${index + 1}`}
                  aria-pressed={color === index}
                  key={hex}
                  onClick={() => setColor(index)}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="pen-sizes">
            <legend>Pen size</legend>
            <div className="pen-sizes__row">
              {PEN_SIZES.map((width, index) => (
                <button
                  className={`pen-size${size === index ? ' is-selected' : ''}`}
                  type="button"
                  aria-label={`Pen size ${index + 1}`}
                  aria-pressed={size === index}
                  key={width}
                  onClick={() => setSize(index)}
                >
                  <span style={{width, height: width}} />
                </button>
              ))}
            </div>
          </fieldset>

          <div className="drawing-actions">
            <button
              className="button button--quiet"
              type="button"
              disabled={strokes.length === 0}
              onClick={() => onChange(strokes.slice(0, -1))}
            >
              Undo stroke
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={strokes.length === 0}
              onClick={() => {
                if (window.confirm('Clear the entire drawing?')) onChange([])
              }}
            >
              Clear canvas
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

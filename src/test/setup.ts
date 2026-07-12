import '@testing-library/jest-dom/vitest'
import {vi} from 'vitest'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverStub,
})

const canvasContext = {
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  lineTo: vi.fn(),
  moveTo: vi.fn(),
  stroke: vi.fn(),
  set fillStyle(_value: string) {},
  set lineCap(_value: string) {},
  set lineJoin(_value: string) {},
  set lineWidth(_value: number) {},
  set strokeStyle(_value: string) {},
  canvas: {width: 1000, height: 700},
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => canvasContext),
})

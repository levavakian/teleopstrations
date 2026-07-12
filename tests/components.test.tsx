import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import App from '../src/App'
import {DrawingCanvas} from '../src/DrawingCanvas'
import {DRAWING_COLORS, PEN_SIZES} from '../src/drawing'

describe('landing experience', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?transport=broadcast')
    sessionStorage.clear()
  })

  it('shows the specified timer defaults and join flow', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByLabelText(/^Prompt timer/)).toHaveValue(60)
    expect(screen.getByLabelText(/^Drawing timer/)).toHaveValue(120)

    await user.click(screen.getByRole('button', {name: 'Join a room'}))
    expect(screen.getByLabelText('Room code')).toBeVisible()
    expect(screen.queryByLabelText(/^Prompt timer/)).not.toBeInTheDocument()
  })

  it('accepts an arbitrary positive integer timer', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Your name'), 'Ada')
    await user.clear(screen.getByLabelText(/^Prompt timer/))
    await user.type(screen.getByLabelText(/^Prompt timer/), '99999')
    await user.click(screen.getByRole('button', {name: /create room/i}))

    expect(
      screen.getByRole('heading', {name: 'Gather the storytellers'}),
    ).toBeVisible()
  })
})

describe('drawing tools', () => {
  it('provides exactly 16 colors and 8 pen sizes', () => {
    render(<DrawingCanvas strokes={[]} onChange={vi.fn()} />)

    expect(screen.getAllByRole('button', {name: /^Color \d+$/})).toHaveLength(
      DRAWING_COLORS.length,
    )
    expect(
      screen.getAllByRole('button', {name: /^Pen size \d+$/}),
    ).toHaveLength(PEN_SIZES.length)
    expect(DRAWING_COLORS).toHaveLength(16)
    expect(PEN_SIZES).toHaveLength(8)
  })
})

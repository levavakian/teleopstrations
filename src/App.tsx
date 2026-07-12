import {useEffect, useMemo, useState, type FormEvent} from 'react'

import {DrawingCanvas} from './DrawingCanvas'
import {
  DEFAULT_SETTINGS,
  MIN_PLAYERS,
  createId,
  createRoomCode,
  currentStageLabel,
  displayRoomCode,
  getAssignment,
  getAssignmentSource,
  getCurrentRevealBook,
  getSubmissionCount,
  isPendingPlayer,
  isValidSettings,
  normalizeName,
  normalizeRoomCode,
  playerIdForName,
} from './game'
import type {
  Content,
  DrawingContent,
  GameSettings,
  PlayerSession,
  RoomSessionConfig,
  RoomState,
  Stroke,
  TextContent,
} from './types'
import {useGameRoom} from './useGameRoom'

const LAST_SESSION_KEY = 'teleopstrations:last-session'

interface RememberedSession {
  roomCode: string
  name: string
  transportKind: 'webrtc' | 'broadcast'
}

function transportFromUrl(): 'webrtc' | 'broadcast' {
  return new URLSearchParams(location.search).get('transport') === 'broadcast'
    ? 'broadcast'
    : 'webrtc'
}

function roomFromUrl(): string {
  const params = new URLSearchParams(location.hash.slice(1))
  return normalizeRoomCode(params.get('room') ?? '')
}

function makePlayer(name: string): PlayerSession {
  const normalized = normalizeName(name)
  return {
    id: playerIdForName(normalized),
    name: normalized,
    sessionId: createId(),
    sessionStartedAt: Date.now(),
  }
}

function rememberSession(config: RoomSessionConfig): void {
  const remembered: RememberedSession = {
    roomCode: config.roomCode,
    name: config.player.name,
    transportKind: config.transportKind ?? 'webrtc',
  }
  sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify(remembered))
}

function loadRememberedSession(): RememberedSession | null {
  try {
    const remembered = JSON.parse(
      sessionStorage.getItem(LAST_SESSION_KEY) ?? 'null',
    ) as RememberedSession | null
    return remembered?.roomCode && remembered.name ? remembered : null
  } catch {
    return null
  }
}

function setInviteUrl(roomCode: string): void {
  const url = new URL(location.href)
  url.hash = new URLSearchParams({room: roomCode}).toString()
  history.replaceState(null, '', url)
}

function Landing({
  onStart,
}: {
  onStart: (config: RoomSessionConfig) => void
}) {
  const inviteCode = roomFromUrl()
  const [mode, setMode] = useState<'create' | 'join'>(
    inviteCode ? 'join' : 'create',
  )
  const [name, setName] = useState('')
  const [roomCode, setRoomCode] = useState(inviteCode)
  const [promptSeconds, setPromptSeconds] = useState(
    String(DEFAULT_SETTINGS.promptSeconds),
  )
  const [drawingSeconds, setDrawingSeconds] = useState(
    String(DEFAULT_SETTINGS.drawingSeconds),
  )
  const [error, setError] = useState('')
  const remembered = useMemo(() => loadRememberedSession(), [])
  const transportKind = transportFromUrl()

  const start = (event: FormEvent) => {
    event.preventDefault()
    const normalizedName = normalizeName(name)
    if (!normalizedName) {
      setError('Enter the name your friends will recognize.')
      return
    }

    const player = makePlayer(normalizedName)
    if (mode === 'create') {
      const settings = {
        promptSeconds: Number(promptSeconds),
        drawingSeconds: Number(drawingSeconds),
      }
      if (!isValidSettings(settings)) {
        setError('Both timers must be positive whole numbers.')
        return
      }
      const code = createRoomCode()
      const config: RoomSessionConfig = {
        mode,
        roomCode: code,
        player,
        settings,
        transportKind,
      }
      rememberSession(config)
      setInviteUrl(code)
      onStart(config)
      return
    }

    const code = normalizeRoomCode(roomCode)
    if (code.length !== 8) {
      setError('Enter the complete eight-character room code.')
      return
    }
    const config: RoomSessionConfig = {
      mode,
      roomCode: code,
      player,
      transportKind,
    }
    rememberSession(config)
    setInviteUrl(code)
    onStart(config)
  }

  const rejoin = () => {
    if (!remembered) return
    const config: RoomSessionConfig = {
      mode: 'join',
      roomCode: remembered.roomCode,
      player: makePlayer(remembered.name),
      transportKind: remembered.transportKind,
    }
    rememberSession(config)
    setInviteUrl(config.roomCode)
    onStart(config)
  }

  return (
    <main className="landing">
      <section className="hero">
        <div className="hero__eyebrow">Draw it. Guess it. Pass it on.</div>
        <h1>Teleopstrations</h1>
        <p>
          A delightfully unreliable game of visual telephone, played directly
          between your browsers.
        </p>
        <div className="hero__scribble" aria-hidden="true">
          <span>cat?</span>
          <svg viewBox="0 0 240 110">
            <path d="M12 83c26-9 34-55 67-49 22 5 13 44 38 44 28 0 22-62 59-58 30 3 17 54 52 57" />
            <path d="m187 17 15 14 19-11" />
          </svg>
          <span>space llama!</span>
        </div>
      </section>

      <section className="entry-card" aria-labelledby="entry-title">
        <div className="mode-switch" aria-label="Room action">
          <button
            type="button"
            className={mode === 'create' ? 'is-active' : ''}
            onClick={() => setMode('create')}
          >
            Create a room
          </button>
          <button
            type="button"
            className={mode === 'join' ? 'is-active' : ''}
            onClick={() => setMode('join')}
          >
            Join a room
          </button>
        </div>

        <form onSubmit={start}>
          <div>
            <span className="step-label">{mode === 'create' ? 'Host' : 'Join'}</span>
            <h2 id="entry-title">
              {mode === 'create' ? 'Start a fresh playbook' : 'Find your friends'}
            </h2>
          </div>

          <label>
            Your name
            <input
              autoComplete="nickname"
              maxLength={36}
              value={name}
              placeholder="e.g. Marlowe"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          {mode === 'create' ? (
            <div className="timer-fields">
              <label>
                Prompt timer
                <span className="input-with-unit">
                  <input
                    inputMode="numeric"
                    type="number"
                    min="1"
                    step="1"
                    value={promptSeconds}
                    onChange={(event) => setPromptSeconds(event.target.value)}
                  />
                  <span>seconds</span>
                </span>
              </label>
              <label>
                Drawing timer
                <span className="input-with-unit">
                  <input
                    inputMode="numeric"
                    type="number"
                    min="1"
                    step="1"
                    value={drawingSeconds}
                    onChange={(event) => setDrawingSeconds(event.target.value)}
                  />
                  <span>seconds</span>
                </span>
              </label>
            </div>
          ) : (
            <label>
              Room code
              <input
                autoCapitalize="characters"
                maxLength={9}
                value={roomCode}
                placeholder="ABCD-EFGH"
                onChange={(event) =>
                  setRoomCode(displayRoomCode(event.target.value))
                }
              />
            </label>
          )}

          {error ? <p className="form-error">{error}</p> : null}

          <button className="button button--primary button--wide" type="submit">
            {mode === 'create' ? 'Create room' : 'Join room'}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {remembered ? (
          <button className="rejoin-card" type="button" onClick={rejoin}>
            <span>
              Rejoin as <strong>{remembered.name}</strong>
              <small>{displayRoomCode(remembered.roomCode)}</small>
            </span>
            <span aria-hidden="true">↗</span>
          </button>
        ) : null}

        <p className="privacy-note">
          <span aria-hidden="true">↔</span>
          No account or game server. Your game travels peer-to-peer.
        </p>
      </section>
    </main>
  )
}

function ConnectionPill({
  state,
  config,
  peerCount,
  kind,
}: {
  state: RoomState
  config: RoomSessionConfig
  peerCount: number
  kind: 'webrtc' | 'broadcast'
}) {
  const self = state.players[config.player.id]
  return (
    <div className="connection-pill" title={`${peerCount} direct peer connections`}>
      <span className={`status-dot${self?.connected ? ' is-online' : ''}`} />
      {kind === 'webrtc' ? 'WebRTC mesh' : 'Local test mesh'} · {peerCount + 1}{' '}
      online
    </div>
  )
}

function RoomHeader({
  state,
  config,
  peerCount,
  transportKind,
  onExit,
}: {
  state: RoomState
  config: RoomSessionConfig
  peerCount: number
  transportKind: 'webrtc' | 'broadcast'
  onExit: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyInvite = async () => {
    const url = new URL(location.href)
    url.hash = new URLSearchParams({room: state.roomCode}).toString()
    let didCopy: boolean
    try {
      await navigator.clipboard.writeText(url.href)
      didCopy = true
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = url.href
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.append(fallback)
      fallback.focus()
      fallback.select()
      didCopy = document.execCommand('copy')
      fallback.remove()
    }
    if (didCopy) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    }
  }

  return (
    <header className="room-header">
      <button className="brand" type="button" onClick={onExit}>
        Teleop<span>strations</span>
      </button>
      <div className="room-header__meta">
        <ConnectionPill
          state={state}
          config={config}
          peerCount={peerCount}
          kind={transportKind}
        />
        <button className="room-code" type="button" onClick={copyInvite}>
          <span>{copied ? 'Invite copied!' : 'Room code'}</span>
          <strong>{displayRoomCode(state.roomCode)}</strong>
        </button>
      </div>
    </header>
  )
}

function PlayerList({
  state,
  compact = false,
}: {
  state: RoomState
  compact?: boolean
}) {
  const submitted = new Set(
    Object.values(state.round?.assignments ?? {})
      .filter((assignment) => assignment.submission)
      .map((assignment) => assignment.playerId),
  )
  const order = state.round?.order ?? state.joinOrder
  const pending = state.joinOrder.filter((id) => !order.includes(id))

  const renderPlayer = (playerId: string, pendingPlayer = false) => {
    const player = state.players[playerId]
    if (!player) return null
    return (
      <li key={playerId} className={!player.connected ? 'is-offline' : ''}>
        <span className="player-avatar">
          {player.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="player-name">
          {player.name}
          <small>
            {playerId === state.adminId ? 'Admin' : null}
            {playerId === state.creatorId && playerId !== state.adminId
              ? 'Creator'
              : null}
            {pendingPlayer ? 'Next round' : null}
            {!player.connected ? 'Disconnected' : null}
          </small>
        </span>
        {state.phase === 'stage' && !pendingPlayer ? (
          <span
            className={`submit-mark${submitted.has(playerId) ? ' is-done' : ''}`}
            aria-label={submitted.has(playerId) ? 'Submitted' : 'Still working'}
          >
            {submitted.has(playerId) ? '✓' : '…'}
          </span>
        ) : (
          <span className={`status-dot${player.connected ? ' is-online' : ''}`} />
        )}
      </li>
    )
  }

  return (
    <div className={`player-list${compact ? ' player-list--compact' : ''}`}>
      <ol>{order.map((playerId) => renderPlayer(playerId))}</ol>
      {pending.length ? (
        <>
          <p className="player-list__divider">Waiting for next round</p>
          <ol>{pending.map((playerId) => renderPlayer(playerId, true))}</ol>
        </>
      ) : null}
    </div>
  )
}

function SettingsEditor({
  state,
  onSave,
}: {
  state: RoomState
  onSave: (settings: GameSettings) => void
}) {
  const [prompt, setPrompt] = useState(String(state.settings.promptSeconds))
  const [drawing, setDrawing] = useState(String(state.settings.drawingSeconds))
  const settings = {
    promptSeconds: Number(prompt),
    drawingSeconds: Number(drawing),
  }

  return (
    <div className="settings-editor">
      <label>
        Prompt
        <span className="compact-number">
          <input
            type="number"
            min="1"
            step="1"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          sec
        </span>
      </label>
      <label>
        Drawing
        <span className="compact-number">
          <input
            type="number"
            min="1"
            step="1"
            value={drawing}
            onChange={(event) => setDrawing(event.target.value)}
          />
          sec
        </span>
      </label>
      <button
        className="button button--quiet"
        type="button"
        disabled={!isValidSettings(settings)}
        onClick={() => onSave(settings)}
      >
        Save timers
      </button>
    </div>
  )
}

function Lobby({
  state,
  config,
  sendControl,
}: {
  state: RoomState
  config: RoomSessionConfig
  sendControl: ReturnType<typeof useGameRoom>['sendControl']
}) {
  const connected = state.joinOrder.filter(
    (id) => state.players[id]?.connected,
  ).length
  const canAdmin =
    config.player.id === state.adminId ||
    config.player.id === state.creatorId

  return (
    <main className="room-main lobby-page">
      <section className="lobby-card lobby-card--intro">
        <span className="step-label">The waiting room</span>
        <h1>Gather the storytellers</h1>
        <p>
          Share the room code. When the round starts, player order is shuffled
          and frozen until every playbook is complete.
        </p>

        <div className="lobby-invite" aria-label="Room invite code">
          <span>Invite code</span>
          <strong>{displayRoomCode(state.roomCode)}</strong>
          <small>Share this code, or copy the invite link from the header.</small>
        </div>

        <div className="lobby-count">
          <strong>{connected}</strong>
          <span>
            connected player{connected === 1 ? '' : 's'}
            <small>Minimum {MIN_PLAYERS} to begin · no room limit</small>
          </span>
        </div>

        {canAdmin ? (
          <div className="admin-panel">
            <div>
              <span className="admin-panel__label">Admin controls</span>
              <h2>Set the pace</h2>
            </div>
            <SettingsEditor
              state={state}
              onSave={(settings) => sendControl({type: 'settings', settings})}
            />
            <button
              className="button button--primary button--wide"
              type="button"
              disabled={connected < MIN_PLAYERS}
              onClick={() => sendControl({type: 'start-round'})}
            >
              Shuffle & start round
              <span aria-hidden="true">→</span>
            </button>
            {connected < MIN_PLAYERS ? (
              <small className="helper">
                Waiting for {MIN_PLAYERS - connected} more{' '}
                {MIN_PLAYERS - connected === 1 ? 'player' : 'players'}.
              </small>
            ) : null}
          </div>
        ) : (
          <div className="waiting-note">
            <span className="waiting-note__spinner" />
            <span>
              Waiting for <strong>{state.players[state.adminId]?.name}</strong>{' '}
              to start the round
            </span>
          </div>
        )}
      </section>

      <aside className="lobby-card roster-card">
        <div className="section-heading">
          <div>
            <span className="step-label">Player order</span>
            <h2>At the table</h2>
          </div>
          <span>{connected}/{state.joinOrder.length}</span>
        </div>
        <PlayerList state={state} />
        <p className="roster-note">
          <span aria-hidden="true">⤨</span>
          The order shown here is shuffled when each round begins.
        </p>
      </aside>
    </main>
  )
}

function useCountdown(deadline: number, clockOffsetMs: number): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, deadline - (Date.now() + clockOffsetMs)),
  )
  useEffect(() => {
    const update = () =>
      setRemaining(Math.max(0, deadline - (Date.now() + clockOffsetMs)))
    update()
    const timer = window.setInterval(update, 200)
    return () => window.clearInterval(timer)
  }, [clockOffsetMs, deadline])
  return remaining
}

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.ceil(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function SourceCard({content}: {content: Content | null}) {
  if (!content) return null
  return (
    <section className="source-card">
      <span className="step-label">
        {content.kind === 'text' ? 'Your secret prompt' : 'Describe this drawing'}
      </span>
      {content.kind === 'text' ? (
        <blockquote>{content.text || <em>An empty description</em>}</blockquote>
      ) : (
        <DrawingCanvas
          strokes={content.strokes}
          readOnly
          label="Drawing to describe"
        />
      )}
    </section>
  )
}

function SubmitStatus({
  submitted,
  changed,
}: {
  submitted: boolean
  changed: boolean
}) {
  if (!submitted) return <span className="draft-status">Draft syncing…</span>
  return (
    <span className="submitted-status">
      <span>✓</span>
      {changed ? 'Edited since last submit' : 'Submitted'}
    </span>
  )
}

function TextStage({
  initial,
  source,
  onDraft,
  onSubmit,
  deadlinePassed,
}: {
  initial: TextContent
  source: Content | null
  onDraft: (content: TextContent) => void
  onSubmit: (content: TextContent) => void
  deadlinePassed: boolean
}) {
  const [text, setText] = useState(initial.text)
  const [submittedText, setSubmittedText] = useState<string | null>(null)
  const content: TextContent = {kind: 'text', text}

  return (
    <div className="work-area">
      <SourceCard content={source} />
      <section className="text-workbench">
        <label htmlFor="stage-text">
          {source ? 'What do you think it is?' : 'Start this playbook with…'}
        </label>
        <textarea
          id="stage-text"
          autoFocus
          maxLength={280}
          disabled={deadlinePassed}
          placeholder={
            source
              ? 'Describe only what you can see…'
              : 'A tiny wizard running a bakery on the moon…'
          }
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            onDraft({kind: 'text', text: event.target.value})
          }}
        />
        <div className="workbench-footer">
          <SubmitStatus
            submitted={submittedText !== null}
            changed={submittedText !== null && submittedText !== text}
          />
          <span className="character-count">{text.length}/280</span>
          <button
            className="button button--primary"
            type="button"
            disabled={deadlinePassed}
            onClick={() => {
              setSubmittedText(text)
              onSubmit(content)
            }}
          >
            {submittedText === null
              ? 'Submit prompt'
              : submittedText === text
                ? 'Submit again'
                : 'Update submission'}
          </button>
        </div>
      </section>
    </div>
  )
}

function DrawingStage({
  initial,
  source,
  onDraft,
  onSubmit,
  deadlinePassed,
}: {
  initial: DrawingContent
  source: Content | null
  onDraft: (content: DrawingContent) => void
  onSubmit: (content: DrawingContent) => void
  deadlinePassed: boolean
}) {
  const [strokes, setStrokes] = useState(initial.strokes)
  const [submittedSignature, setSubmittedSignature] = useState<string | null>(
    null,
  )
  const signature = strokes.map((stroke) => stroke.id).join(',')

  const update = (next: Stroke[]) => {
    setStrokes(next)
    onDraft({kind: 'drawing', strokes: next})
  }

  return (
    <div className="work-area">
      <SourceCard content={source} />
      <section className={deadlinePassed ? 'canvas-disabled' : ''}>
        <DrawingCanvas strokes={strokes} onChange={update} />
        <div className="drawing-submit">
          <SubmitStatus
            submitted={submittedSignature !== null}
            changed={
              submittedSignature !== null && submittedSignature !== signature
            }
          />
          <button
            className="button button--primary"
            type="button"
            disabled={deadlinePassed}
            onClick={() => {
              if (
                strokes.length === 0 &&
                !window.confirm('Submit a blank drawing?')
              ) {
                return
              }
              setSubmittedSignature(signature)
              onSubmit({kind: 'drawing', strokes})
            }}
          >
            {submittedSignature === null
              ? 'Submit drawing'
              : submittedSignature === signature
                ? 'Submit again'
                : 'Update submission'}
          </button>
        </div>
      </section>
    </div>
  )
}

function Stage({
  state,
  config,
  sendDraft,
  submit,
  sendControl,
  clockOffsetMs,
}: {
  state: RoomState
  config: RoomSessionConfig
  sendDraft: ReturnType<typeof useGameRoom>['sendDraft']
  submit: ReturnType<typeof useGameRoom>['submit']
  sendControl: ReturnType<typeof useGameRoom>['sendControl']
  clockOffsetMs: number
}) {
  const round = state.round!
  const remaining = useCountdown(round.deadline, clockOffsetMs)
  const assignment = getAssignment(state, config.player.id)
  const source = getAssignmentSource(state, config.player.id)
  const submittedCount = getSubmissionCount(state)
  const canAdmin =
    config.player.id === state.adminId ||
    config.player.id === state.creatorId

  if (!assignment || isPendingPlayer(state, config.player.id)) {
    return (
      <main className="room-main spectator-page">
        <section className="spectator-card">
          <span className="step-label">Next round</span>
          <h1>You’re in the room</h1>
          <p>
            This round’s order is already frozen. Watch the progress here; the
            admin can include you when the next round begins.
          </p>
          <div className="giant-progress">
            {submittedCount}<span>/{round.order.length} submitted</span>
          </div>
        </section>
        <aside className="lobby-card">
          <PlayerList state={state} />
        </aside>
      </main>
    )
  }

  const initialCandidate = assignment.draft ?? assignment.submission
  const deadlinePassed = remaining <= 0

  return (
    <main className="stage-page">
      <header className="stage-banner">
        <div>
          <span className="step-label">
            Round {round.number} · Stage {round.stageIndex + 1} of{' '}
            {round.order.length}
          </span>
          <h1>{currentStageLabel(round)}</h1>
        </div>
        <div className={`countdown${remaining < 10_000 ? ' is-urgent' : ''}`}>
          <span>{deadlinePassed ? 'Closing stage' : 'Time remaining'}</span>
          <strong>{formatCountdown(remaining)}</strong>
        </div>
      </header>

      <div className="stage-progress">
        <div>
          <strong>{submittedCount}</strong> of {round.order.length} submitted
          <small>You can keep editing and resubmit until time expires.</small>
        </div>
        <div className="progress-track">
          <span
            style={{
              width: `${(submittedCount / round.order.length) * 100}%`,
            }}
          />
        </div>
        {canAdmin ? (
          <button
            className="button button--danger-quiet"
            type="button"
            onClick={() => {
              if (window.confirm('Close this stage for everyone now?')) {
                sendControl({type: 'force-advance'})
              }
            }}
          >
            Force next stage
          </button>
        ) : null}
      </div>

      {assignment.kind === 'text' ? (
        <TextStage
          key={`${round.id}:${round.stageIndex}`}
          source={source}
          deadlinePassed={deadlinePassed}
          initial={
            initialCandidate?.content.kind === 'text'
              ? initialCandidate.content
              : {kind: 'text', text: ''}
          }
          onDraft={sendDraft}
          onSubmit={submit}
        />
      ) : (
        <DrawingStage
          key={`${round.id}:${round.stageIndex}`}
          source={source}
          deadlinePassed={deadlinePassed}
          initial={
            initialCandidate?.content.kind === 'drawing'
              ? initialCandidate.content
              : {kind: 'drawing', strokes: []}
          }
          onDraft={sendDraft}
          onSubmit={submit}
        />
      )}

      <details className="stage-roster">
        <summary>See everyone’s progress</summary>
        <PlayerList state={state} compact />
      </details>
    </main>
  )
}

function Reveal({
  state,
  config,
  sendControl,
}: {
  state: RoomState
  config: RoomSessionConfig
  sendControl: ReturnType<typeof useGameRoom>['sendControl']
}) {
  const round = state.round!
  const reveal = round.reveal!
  const book = getCurrentRevealBook(state)!
  const entry = book.entries[reveal.pageIndex]
  const owner = state.players[book.ownerId]
  const author = state.players[entry.authorId]
  const canPresent =
    config.player.id === state.creatorId || config.player.id === book.ownerId
  const canAdmin =
    config.player.id === state.adminId ||
    config.player.id === state.creatorId
  const connected = state.joinOrder.filter(
    (id) => state.players[id]?.connected,
  ).length

  return (
    <main className="reveal-page">
      <header className="reveal-heading">
        <div>
          <span className="step-label">
            The grand reveal · Playbook {reveal.bookIndex + 1} of{' '}
            {round.order.length}
          </span>
          <h1>{owner.name}’s playbook</h1>
          <p>
            {canPresent
              ? 'You have the controls. Take everyone through the story.'
              : `${owner.name} is presenting this beautiful disaster.`}
          </p>
        </div>
        <div className="presenter-badge">
          <span>{owner.name.slice(0, 1).toUpperCase()}</span>
          <div>
            Presenting
            <strong>{owner.name}</strong>
          </div>
        </div>
      </header>

      <section className="reveal-stage">
        <div className="paper-number">
          <span>{reveal.pageIndex + 1}</span>
          <small>of {book.entries.length}</small>
        </div>
        <div className="reveal-paper">
          <div className="reveal-paper__meta">
            <span>
              {entry.content.kind === 'text' ? 'They wrote…' : 'They drew…'}
            </span>
            <strong>by {author.name}</strong>
          </div>
          {entry.content.kind === 'text' ? (
            <blockquote>
              {entry.content.text || <em>An empty description</em>}
            </blockquote>
          ) : (
            <DrawingCanvas
              strokes={entry.content.strokes}
              readOnly
              label={`Drawing by ${author.name}`}
            />
          )}
          <div className="reveal-paper__source">
            {entry.source === 'fallback'
              ? 'Deadline fallback'
              : entry.source === 'submission'
                ? 'Submitted'
                : entry.source === 'draft'
                  ? 'Captured at deadline'
                  : 'Left blank'}
          </div>
        </div>
      </section>

      <div className="reveal-controls">
        {canPresent ? (
          <>
            <button
              className="button button--quiet"
              type="button"
              disabled={reveal.pageIndex === 0}
              onClick={() =>
                sendControl({
                  type: 'reveal-page',
                  pageIndex: reveal.pageIndex - 1,
                })
              }
            >
              ← Previous page
            </button>
            {reveal.pageIndex < book.entries.length - 1 ? (
              <button
                className="button button--primary"
                type="button"
                onClick={() =>
                  sendControl({
                    type: 'reveal-page',
                    pageIndex: reveal.pageIndex + 1,
                  })
                }
              >
                Next page →
              </button>
            ) : (
              <button
                className="button button--primary"
                type="button"
                onClick={() => sendControl({type: 'reveal-book', direction: 1})}
              >
                {reveal.bookIndex === round.order.length - 1
                  ? 'Finish the reveal'
                  : 'Next playbook'}{' '}
                →
              </button>
            )}
          </>
        ) : (
          <span className="waiting-note">
            <span className="waiting-note__spinner" />
            Waiting for the presenter
          </span>
        )}
      </div>

      {reveal.complete ? (
        <section className="round-complete">
          <span className="step-label">Round complete</span>
          <h2>Every masterpiece has had its moment.</h2>
          {canAdmin ? (
            <>
              <SettingsEditor
                state={state}
                onSave={(settings) =>
                  sendControl({type: 'settings', settings})
                }
              />
              <div className="round-complete__actions">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Return to the lobby and close this completed round?',
                      )
                    ) {
                      sendControl({type: 'reset-lobby'})
                    }
                  }}
                >
                  Return to lobby
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={connected < MIN_PLAYERS}
                  onClick={() => sendControl({type: 'start-round'})}
                >
                  Shuffle & start next round
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}

function Room({
  config,
  onExit,
}: {
  config: RoomSessionConfig
  onExit: () => void
}) {
  const room = useGameRoom(config)
  const {state, connection} = room

  const exit = async () => {
    await room.leave()
    onExit()
  }

  if (!state) {
    return (
      <main className="connection-page">
        <div className="connection-card">
          <div className="orbit-loader" aria-hidden="true">
            <span />
          </div>
          <span className="step-label">Finding room</span>
          <h1>{displayRoomCode(config.roomCode)}</h1>
          <p>Listening for a playbook keeper on the peer-to-peer network…</p>
          {connection.error ? (
            <p className="form-error">{connection.error}</p>
          ) : null}
          <button className="button button--quiet" type="button" onClick={exit}>
            Cancel
          </button>
        </div>
      </main>
    )
  }

  const recognized =
    state.players[config.player.id]?.sessionId === config.player.sessionId

  return (
    <div className="room-shell">
      <RoomHeader
        state={state}
        config={config}
        peerCount={connection.transport.peers.length}
        transportKind={connection.transport.kind}
        onExit={exit}
      />
      {connection.error ? (
        <div className="network-warning" role="status">
          Connection notice: {connection.error}
        </div>
      ) : null}
      {!recognized ? (
        <main className="connection-page connection-page--in-room">
          <div className="connection-card">
            <div className="orbit-loader" aria-hidden="true">
              <span />
            </div>
            <span className="step-label">Reclaiming your seat</span>
            <h1>Welcome back, {config.player.name}</h1>
            <p>An active peer is syncing your latest playbook and deadline.</p>
          </div>
        </main>
      ) : state.phase === 'lobby' ? (
        <Lobby
          state={state}
          config={config}
          sendControl={room.sendControl}
        />
      ) : state.phase === 'stage' ? (
        <Stage
          state={state}
          config={config}
          sendDraft={room.sendDraft}
          submit={room.submit}
          sendControl={room.sendControl}
          clockOffsetMs={room.clockOffsetMs}
        />
      ) : (
        <Reveal
          state={state}
          config={config}
          sendControl={room.sendControl}
        />
      )}
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState<RoomSessionConfig | null>(null)
  return config ? (
    <Room config={config} onExit={() => setConfig(null)} />
  ) : (
    <Landing onStart={setConfig} />
  )
}

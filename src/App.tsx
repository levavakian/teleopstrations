import {useEffect, useMemo, useState, type FormEvent} from 'react'
import {createPortal} from 'react-dom'

import {DrawingCanvas} from './DrawingCanvas'
import {downloadPlaybookImage} from './playbookImage'
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
  syncCursorForState,
} from './game'
import type {
  Content,
  DrawingContent,
  GameSettings,
  PeerSyncReport,
  PlayerSession,
  RoomSessionConfig,
  RoomState,
  Stroke,
  SyncCursor,
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

function isCreatorAuthority(
  state: RoomState,
  config: RoomSessionConfig,
): boolean {
  return (
    state.creatorId === config.player.id &&
    state.players[state.creatorId]?.sessionId === config.player.sessionId
  )
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
      {kind === 'webrtc'
        ? `WebRTC · ${peerCount} direct ${peerCount === 1 ? 'link' : 'links'}`
        : `Local test mesh · ${peerCount + 1} online`}
    </div>
  )
}

function CreatorSyncStatus({
  state,
  reports,
}: {
  state: RoomState
  reports: Record<string, PeerSyncReport>
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])
  const peers = state.joinOrder.filter((playerId) => playerId !== state.creatorId)
  if (!peers.length) return null
  const creatorCursor = syncCursorForState(state)
  const sameLocation = (cursor: SyncCursor): boolean =>
    cursor.creatorId === creatorCursor.creatorId &&
    cursor.creatorSessionId === creatorCursor.creatorSessionId &&
    cursor.phase === creatorCursor.phase &&
    cursor.roundId === creatorCursor.roundId &&
    cursor.stageIndex === creatorCursor.stageIndex &&
    cursor.revealBookIndex === creatorCursor.revealBookIndex &&
    cursor.revealPageIndex === creatorCursor.revealPageIndex &&
    cursor.revealComplete === creatorCursor.revealComplete
  const reportIsOnPage = (
    playerId: string,
    report: PeerSyncReport | undefined,
  ): boolean =>
    Boolean(
      report &&
        state.players[playerId]?.connected &&
        report.sessionId === state.players[playerId]?.sessionId &&
        now - report.receivedAt < 20_000 &&
        sameLocation(report.cursor),
    )
  const locationLabel = (cursor: SyncCursor): string => {
    if (cursor.phase === 'stage') {
      return `Stage ${(cursor.stageIndex ?? 0) + 1}`
    }
    if (cursor.phase === 'reveal') {
      if (cursor.revealComplete) return 'Reveal complete'
      return `Playbook ${(cursor.revealBookIndex ?? 0) + 1}, page ${(cursor.revealPageIndex ?? 0) + 1}`
    }
    if (cursor.phase === 'closed') return 'Room closed'
    return 'Lobby'
  }
  const syncedCount = peers.filter((playerId) => {
    return reportIsOnPage(playerId, reports[playerId])
  }).length

  return (
    <details className="sync-status" open>
      <summary>
        Player sync · {syncedCount}/{peers.length} on this page
      </summary>
      <ul>
        {peers.map((playerId) => {
          const report = reports[playerId]
          const player = state.players[playerId]
          const onPage = reportIsOnPage(playerId, report)
          const exact =
            onPage && report?.cursor.revision === creatorCursor.revision
          return (
            <li key={playerId} className={exact ? 'is-synced' : ''}>
              <span
                className="sync-status__mark"
                aria-label={onPage ? 'On the same page' : 'Not yet on this page'}
              >
                {onPage ? '✓' : '…'}
              </span>
              <span className="sync-status__player">
                <strong>{player?.name ?? playerId}</strong>
                <small>
                  {report
                    ? `Last update: ${locationLabel(report.cursor)}`
                    : 'Waiting for first update'}
                </small>
              </span>
              <span className="sync-status__state">
                {exact
                  ? 'In sync'
                  : onPage
                    ? 'Same page · state update pending'
                    : `Creator: ${locationLabel(creatorCursor)}`}
              </span>
            </li>
          )
        })}
      </ul>
    </details>
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
  showJoinOrder = false,
  onKick,
}: {
  state: RoomState
  compact?: boolean
  showJoinOrder?: boolean
  onKick?: (playerId: string) => void
}) {
  const submitted = new Set(
    Object.values(state.round?.assignments ?? {})
      .filter((assignment) => assignment.submission)
      .map((assignment) => assignment.playerId),
  )
  const order = showJoinOrder
    ? state.joinOrder
    : (state.round?.order ?? state.joinOrder)
  const pending = showJoinOrder
    ? []
    : state.joinOrder.filter((id) => !order.includes(id))

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
            {playerId === state.creatorId ? 'Creator · Authority' : null}
            {pendingPlayer ? 'Next round' : null}
            {!player.connected ? 'Disconnected' : null}
          </small>
        </span>
        {onKick &&
        playerId !== state.creatorId ? (
          <button
            className="kick-player"
            type="button"
            aria-label={`Kick ${player.name}`}
            onClick={() => onKick(playerId)}
          >
            Kick
          </button>
        ) : state.phase === 'stage' && !pendingPlayer ? (
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
  const canAdmin = isCreatorAuthority(state, config)

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
              <span className="admin-panel__label">Creator controls</span>
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
            <div className="room-danger-row">
              <span>Closing removes the room for everyone.</span>
              <button
                className="button button--danger-quiet"
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Close this room for everyone? The current game will be deleted.',
                    )
                  ) {
                    sendControl({type: 'close-room'})
                  }
                }}
              >
                Close room
              </button>
            </div>
          </div>
        ) : (
          <div className="waiting-note">
            <span className="waiting-note__spinner" />
            <span>
              Waiting for <strong>{state.players[state.creatorId]?.name}</strong>{' '}
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
        <PlayerList
          state={state}
          onKick={
            canAdmin
              ? (playerId) => {
                  const name = state.players[playerId]?.name ?? 'this player'
                  if (
                    window.confirm(
                      `Kick ${name}? They cannot rejoin with the same name.`,
                    )
                  ) {
                    sendControl({type: 'kick-player', playerId})
                  }
                }
              : undefined
          }
        />
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
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
      if (event.key === 'Tab') {
        event.preventDefault()
        document
          .querySelector<HTMLButtonElement>('.drawing-modal__close')
          ?.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [expanded])
  if (!content) return null
  return (
    <section className="source-card">
      <span className="step-label">
        {content.kind === 'text' ? 'Your secret prompt' : 'Describe this drawing'}
      </span>
      {content.kind === 'text' ? (
        <blockquote>{content.text || <em>An empty description</em>}</blockquote>
      ) : (
        <>
          <button
            className="source-drawing-preview"
            type="button"
            aria-label="Enlarge drawing"
            onClick={() => setExpanded(true)}
          >
            <DrawingCanvas
              strokes={content.strokes}
              readOnly
              label="Drawing to describe"
            />
            <span>Click to enlarge</span>
          </button>
          {expanded
            ? createPortal(
                <div
                  className="drawing-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Enlarged drawing"
                  aria-describedby="enlarged-drawing-help"
                >
                  <div
                    className="drawing-modal__content"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      className="drawing-modal__close"
                      type="button"
                      aria-label="Close enlarged drawing"
                      autoFocus
                      onClick={() => setExpanded(false)}
                    >
                      ×
                    </button>
                    <DrawingCanvas
                      strokes={content.strokes}
                      readOnly
                      label="Enlarged drawing canvas"
                    />
                    <p id="enlarged-drawing-help" className="sr-only">
                      Enlarged view of the drawing. Press Escape or use the
                      close button to return to your description.
                    </p>
                  </div>
                </div>,
                document.body,
              )
            : null}
        </>
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
  creatorConnected,
}: {
  state: RoomState
  config: RoomSessionConfig
  sendDraft: ReturnType<typeof useGameRoom>['sendDraft']
  submit: ReturnType<typeof useGameRoom>['submit']
  sendControl: ReturnType<typeof useGameRoom>['sendControl']
  clockOffsetMs: number
  creatorConnected: boolean
}) {
  const round = state.round!
  const remaining = useCountdown(round.deadline, clockOffsetMs)
  const assignment = getAssignment(state, config.player.id)
  const source = getAssignmentSource(state, config.player.id)
  const submittedCount = getSubmissionCount(state)
  const canAdmin = isCreatorAuthority(state, config)
  const isCreator = canAdmin

  if (!assignment || isPendingPlayer(state, config.player.id)) {
    return (
      <main className="room-main spectator-page">
        <section className="spectator-card">
          <span className="step-label">Next round</span>
          <h1>You’re in the room</h1>
          <p>
            This round’s order is already frozen. Watch the progress here; the
            creator can include you when the next round begins.
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
          <span>
            {!creatorConnected && !isCreator
              ? 'Waiting for creator'
              : deadlinePassed
                ? 'Closing stage'
                : 'Time remaining'}
          </span>
          <strong>{formatCountdown(remaining)}</strong>
        </div>
      </header>

      <div className="stage-progress">
        <div>
          <strong>{submittedCount}</strong> of {round.order.length} submitted
          <small>
            You can resubmit until time expires or everyone is ready.
          </small>
        </div>
        <div className="progress-track">
          <span
            style={{
              width: `${(submittedCount / round.order.length) * 100}%`,
            }}
          />
        </div>
        {canAdmin ? (
          <div className="admin-stage-actions">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                if (window.confirm('Close this stage for everyone now?')) {
                  sendControl({type: 'force-advance'})
                }
              }}
            >
              Next stage
            </button>
            <button
              className="button button--danger-quiet"
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'End this round now? Current work will be finalized and revealed.',
                  )
                ) {
                  sendControl({type: 'end-round'})
                }
              }}
            >
              End round
            </button>
            <button
              className="button button--danger-quiet"
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'Close this room for everyone? The current game will be deleted.',
                  )
                ) {
                  sendControl({type: 'close-room'})
                }
              }}
            >
              Close room
            </button>
          </div>
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
  const canAdmin = isCreatorAuthority(state, config)
  const canPresent = canAdmin || config.player.id === book.ownerId
  const connected = state.joinOrder.filter(
    (id) => state.players[id]?.connected,
  ).length
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

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
          {canAdmin ? (
            <button
              className="button button--danger-quiet reveal-close"
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'Close this room for everyone? The current game will be deleted.',
                  )
                ) {
                  sendControl({type: 'close-room'})
                }
              }}
            >
              Close room
            </button>
          ) : null}
        </div>
        <div className="reveal-heading__actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              setSaved(false)
              setSaveError('')
              try {
                await downloadPlaybookImage(book, state.players)
                setSaved(true)
                window.setTimeout(() => setSaved(false), 2_000)
              } catch (error) {
                setSaveError(
                  error instanceof Error
                    ? error.message
                    : 'Unable to save this playbook.',
                )
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? 'Preparing image…' : saved ? 'Saved!' : 'Save playbook'}
          </button>
          <div className="presenter-badge">
            <span>{owner.name.slice(0, 1).toUpperCase()}</span>
            <div>
              Presenting
              <strong>{owner.name}</strong>
            </div>
          </div>
        </div>
      </header>
      {saveError ? <p className="form-error reveal-save-error">{saveError}</p> : null}

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
              <div className="round-roster-manager">
                <div className="section-heading">
                  <div>
                    <span className="step-label">Next round</span>
                    <h3>Manage players</h3>
                  </div>
                  <span>{connected}</span>
                </div>
                <PlayerList
                  state={state}
                  compact
                  showJoinOrder
                  onKick={(playerId) => {
                    const name =
                      state.players[playerId]?.name ?? 'this player'
                    if (
                      window.confirm(
                        `Kick ${name}? They cannot rejoin with the same name.`,
                      )
                    ) {
                      sendControl({type: 'kick-player', playerId})
                    }
                  }}
                />
              </div>
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
                <button
                  className="button button--danger-quiet"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Close this room for everyone? The current game will be deleted.',
                      )
                    ) {
                      sendControl({type: 'close-room'})
                    }
                  }}
                >
                  Close room
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
  const wasKicked = state.blockedPlayerIds.includes(config.player.id)

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
      {!room.creatorConnected && !isCreatorAuthority(state, config) ? (
        <div className="network-warning network-warning--authority" role="status">
          Creator connection interrupted. Your work is queued while this client
          retries the creator and polls for current state.
        </div>
      ) : null}
      {isCreatorAuthority(state, config) ? (
        <CreatorSyncStatus state={state} reports={room.syncReports} />
      ) : null}
      {state.phase === 'closed' ? (
        <main className="connection-page connection-page--in-room">
          <div className="connection-card room-ended-card">
            <span className="room-ended-card__icon" aria-hidden="true">
              ×
            </span>
            <span className="step-label">Room closed</span>
            <h1>This room has been shut down</h1>
            <p>
              The creator deleted the active game. Create a fresh room to play
              again.
            </p>
            <button className="button button--primary" type="button" onClick={exit}>
              Back to home
            </button>
          </div>
        </main>
      ) : wasKicked ? (
        <main className="connection-page connection-page--in-room">
          <div className="connection-card room-ended-card">
            <span className="room-ended-card__icon" aria-hidden="true">
              →
            </span>
            <span className="step-label">Removed from room</span>
            <h1>You’ve been removed from this room</h1>
            <p>The creator removed this name from the next-round roster.</p>
            <button className="button button--primary" type="button" onClick={exit}>
              Back to home
            </button>
          </div>
        </main>
      ) : !recognized ? (
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
          creatorConnected={room.creatorConnected}
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

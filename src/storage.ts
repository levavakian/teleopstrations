import type {TurnServerConfig} from '@trystero-p2p/nostr'

import {hydrateRoomState, normalizeRoomCode, playerIdForName} from './game'
import type {RoomState} from './types'

/**
 * Host persistence: the room creator's tab saves canonical state to
 * `localStorage` on every change. If the tab closes, rejoining the same room
 * code with the same name from the same browser restores the room exactly
 * where it left off.
 */

function hostKey(roomCode: string): string {
  return `teleopstrations:v3:host:${normalizeRoomCode(roomCode)}`
}

export function saveHostState(state: RoomState): void {
  try {
    if (state.phase === 'closed') {
      localStorage.removeItem(hostKey(state.roomCode))
      return
    }
    localStorage.setItem(hostKey(state.roomCode), JSON.stringify(state))
  } catch {
    // Storage quota failures must never interrupt hosting; peers still hold
    // the live state, and the next smaller state will persist again.
  }
}

export function loadHostState(roomCode: string): RoomState | null {
  try {
    const serialized = localStorage.getItem(hostKey(roomCode))
    if (!serialized) return null
    const parsed = JSON.parse(serialized) as RoomState
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      normalizeRoomCode(parsed.roomCode ?? '') !== normalizeRoomCode(roomCode)
    ) {
      return null
    }
    return hydrateRoomState(parsed)
  } catch {
    return null
  }
}

export function clearHostState(roomCode: string): void {
  try {
    localStorage.removeItem(hostKey(roomCode))
  } catch {
    // Ignore storage failures.
  }
}

/** True when this browser previously hosted the room under this player name. */
export function canResumeAsHost(roomCode: string, name: string): boolean {
  const stored = loadHostState(roomCode)
  return stored !== null && stored.creatorId === playerIdForName(name)
}

const TURN_SERVERS_KEY = 'teleopstrations:v3:turn-servers'

/**
 * Optional TURN relay escape hatch. No provider offers open, credential-free
 * TURN (relaying full traffic is too costly), so groups on restrictive
 * networks can obtain their own credentials — for example the free tier of a
 * provider like Metered — and paste them once per browser:
 *
 * localStorage.setItem('teleopstrations:v3:turn-servers', JSON.stringify([
 *   {urls: 'turn:example.relay:443', username: '...', credential: '...'},
 * ]))
 */
export function loadTurnServers(): TurnServerConfig[] | null {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TURN_SERVERS_KEY) ?? 'null',
    ) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const servers = parsed.filter(
      (entry): entry is TurnServerConfig =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        (typeof (entry as TurnServerConfig).urls === 'string' ||
          Array.isArray((entry as TurnServerConfig).urls)),
    )
    return servers.length > 0 ? servers : null
  } catch {
    return null
  }
}

const LAST_SESSION_KEY = 'teleopstrations:v3:last-session'

export interface RememberedSession {
  roomCode: string
  name: string
  transportKind: 'webrtc' | 'broadcast'
}

export function rememberLastSession(session: RememberedSession): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(session))
  } catch {
    // Ignore storage failures.
  }
}

export function loadLastSession(): RememberedSession | null {
  try {
    const remembered = JSON.parse(
      localStorage.getItem(LAST_SESSION_KEY) ?? 'null',
    ) as RememberedSession | null
    return remembered?.roomCode && remembered.name ? remembered : null
  } catch {
    return null
  }
}

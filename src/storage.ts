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
const SHARED_TURN_SERVERS_KEY = 'teleopstrations:v3:turn-servers:shared'

/**
 * Optional TURN relay escape hatch. No provider offers open, credential-free
 * TURN (relaying full traffic is too costly), so one player obtains free
 * credentials — for example Metered's or ExpressTURN's free tier — and
 * pastes them under “Connection help”. Invite links copied from that device
 * then carry the settings to every player who opens them, so the rest of
 * the group never has to configure anything.
 */
export function loadTurnServers(): TurnServerConfig[] | null {
  try {
    const manual = parseTurnServers(
      localStorage.getItem(TURN_SERVERS_KEY) ?? '',
    )
    const shared = parseTurnServers(
      localStorage.getItem(SHARED_TURN_SERVERS_KEY) ?? '',
    )
    if (!manual && !shared) return null
    const merged: TurnServerConfig[] = []
    const seen = new Set<string>()
    for (const server of [...(manual ?? []), ...(shared ?? [])]) {
      const key = JSON.stringify(server)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(server)
    }
    return merged
  } catch {
    return null
  }
}

function isServerEntry(entry: unknown): entry is TurnServerConfig {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    (typeof (entry as TurnServerConfig).urls === 'string' ||
      Array.isArray((entry as TurnServerConfig).urls))
  )
}

/**
 * Accepts the shapes providers actually hand out: a bare `iceServers` array,
 * a single server object, or a `{iceServers: ...}` wrapper around either
 * (Cloudflare's credentials API returns the latter with a single object).
 */
export function parseTurnServers(text: string): TurnServerConfig[] | null {
  try {
    let parsed = JSON.parse(text) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'iceServers' in parsed
    ) {
      parsed = (parsed as {iceServers: unknown}).iceServers
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    const servers = entries.filter(isServerEntry)
    return servers.length > 0 ? servers : null
  } catch {
    return null
  }
}

export function loadTurnServersText(): string {
  try {
    return localStorage.getItem(TURN_SERVERS_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Saves pasted TURN JSON; returns how the input was handled. Touching the
 * manual settings makes them the single source of truth, so any config
 * previously adopted from an invite link is dropped alongside.
 */
export function saveTurnServersText(
  text: string,
): 'saved' | 'cleared' | 'invalid' {
  const trimmed = text.trim()
  try {
    if (!trimmed) {
      localStorage.removeItem(TURN_SERVERS_KEY)
      localStorage.removeItem(SHARED_TURN_SERVERS_KEY)
      return 'cleared'
    }
    const servers = parseTurnServers(trimmed)
    if (!servers) return 'invalid'
    localStorage.setItem(TURN_SERVERS_KEY, JSON.stringify(servers))
    localStorage.removeItem(SHARED_TURN_SERVERS_KEY)
    return 'saved'
  } catch {
    return 'invalid'
  }
}

/** True when this device is using TURN settings adopted from an invite link. */
export function hasSharedTurnServers(): boolean {
  try {
    return (
      parseTurnServers(
        localStorage.getItem(SHARED_TURN_SERVERS_KEY) ?? '',
      ) !== null
    )
  } catch {
    return false
  }
}

/**
 * Invite links can carry the sender's TURN settings so one player's setup
 * reaches the whole group. The payload is base64url-encoded JSON — compact
 * in a URL and free of percent-escaping noise.
 */
export function encodeTurnParam(servers: TurnServerConfig[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(servers))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeTurnParam(param: string): TurnServerConfig[] | null {
  try {
    const base64 = param.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return parseTurnServers(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/**
 * Adopts TURN settings arriving via an invite link. They persist for future
 * sessions on this device but never override manually saved settings (both
 * are offered to ICE, which simply tries every relay it is given).
 */
export function adoptSharedTurnServers(param: string): boolean {
  const servers = decodeTurnParam(param)
  if (!servers) return false
  try {
    localStorage.setItem(SHARED_TURN_SERVERS_KEY, JSON.stringify(servers))
    return true
  } catch {
    return false
  }
}

const FORCE_RELAY_KEY = 'teleopstrations:v3:force-relay'

/**
 * Per-device opt-in to skip direct connections entirely and always use the
 * TURN relay. For devices whose direct links keep dying (carrier NAT
 * rebinding, flaky WiFi), determinism beats the latency win of a direct
 * path.
 */
export function loadForceRelay(): boolean {
  try {
    return localStorage.getItem(FORCE_RELAY_KEY) === '1'
  } catch {
    return false
  }
}

export function saveForceRelay(value: boolean): void {
  try {
    if (value) localStorage.setItem(FORCE_RELAY_KEY, '1')
    else localStorage.removeItem(FORCE_RELAY_KEY)
  } catch {
    // Ignore storage failures.
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

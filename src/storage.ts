/**
 * Local remembering of the last session so a player can rejoin a room in
 * one tap. Game state itself lives on the server; nothing else persists on
 * the device.
 */

const LAST_SESSION_KEY = 'teleopstrations:v3:last-session'

export interface RememberedSession {
  roomCode: string
  name: string
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

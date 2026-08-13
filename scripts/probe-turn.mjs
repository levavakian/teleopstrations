// Probes candidate public TURN servers by running real ICE gathering in
// headless Chromium with iceTransportPolicy: 'relay'. A server passes only if
// it hands out a relay candidate, i.e. a TURN allocation actually succeeded.
import {chromium} from '@playwright/test'

const candidates = [
  {
    label: 'openrelay.metered.ca:80 (openrelayproject)',
    server: {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  },
  {
    label: 'openrelay.metered.ca:443 (openrelayproject)',
    server: {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  },
  {
    label: 'openrelay.metered.ca:443?transport=tcp (openrelayproject)',
    server: {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  },
  {
    label: 'staticauth.openrelay.metered.ca:443 (openrelayproject)',
    server: {
      urls: 'turn:staticauth.openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayprojectsecret',
    },
  },
  {
    label: 'turn.freestun.net:3478 (free/free)',
    server: {
      urls: 'turn:turn.freestun.net:3478',
      username: 'free',
      credential: 'free',
    },
  },
  {
    label: 'turns:turn.freestun.net:5350 (free/free)',
    server: {
      urls: 'turns:turn.freestun.net:5350',
      username: 'free',
      credential: 'free',
    },
  },
  {
    label: 'freeturn.net:3478 (free/free)',
    server: {
      urls: 'turn:freeturn.net:3478',
      username: 'free',
      credential: 'free',
    },
  },
  {
    label: 'freeturn.tel:3478 (free/free)',
    server: {
      urls: 'turn:freeturn.tel:3478',
      username: 'free',
      credential: 'free',
    },
  },
]

const browser = await chromium.launch()
const page = await browser.newPage()

for (const {label, server} of candidates) {
  const result = await page.evaluate(async (iceServer) => {
    const pc = new RTCPeerConnection({
      iceServers: [iceServer],
      iceTransportPolicy: 'relay',
    })
    pc.createDataChannel('probe')
    const relayCandidates = []
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000)
      pc.onicecandidate = (event) => {
        if (event.candidate === null) {
          clearTimeout(timer)
          resolve('complete')
        } else if (event.candidate.candidate.includes(' typ relay ')) {
          relayCandidates.push(event.candidate.candidate)
        }
      }
    })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const status = await done
    pc.close()
    return {status, relayCount: relayCandidates.length, sample: relayCandidates[0] ?? null}
  }, server)
  const verdict = result.relayCount > 0 ? 'WORKS' : 'FAILED'
  console.log(`${verdict}  ${label}  (gathering: ${result.status}, relays: ${result.relayCount})`)
  if (result.sample) console.log(`        ${result.sample}`)
}

await browser.close()

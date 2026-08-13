import {expect, test, type BrowserContext, type Page} from '@playwright/test'

/**
 * Flaky-network end-to-end tests. Every page's BroadcastChannel is wrapped
 * with a fault injector that randomly drops and delays outgoing messages and
 * can fully block a page, simulating packet loss, jitter, and partitions on
 * top of the real host/client protocol.
 */

interface NetworkFaults {
  dropRate?: number
  minDelayMs?: number
  maxDelayMs?: number
  blockAll?: boolean
}

declare global {
  interface Window {
    networkFaults?: NetworkFaults
  }
}

async function installFaultInjector(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativeBroadcastChannel = window.BroadcastChannel
    class FaultyBroadcastChannel {
      readonly name: string
      onmessage: ((event: MessageEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      private readonly channel: BroadcastChannel

      constructor(name: string) {
        this.name = name
        this.channel = new NativeBroadcastChannel(name)
        this.channel.onmessage = (event) => {
          if (window.networkFaults?.blockAll) return
          this.onmessage?.(event)
        }
        this.channel.onmessageerror = (event) => this.onmessageerror?.(event)
      }

      postMessage(message: unknown): void {
        const faults = window.networkFaults ?? {}
        if (faults.blockAll) return
        if (Math.random() < (faults.dropRate ?? 0)) return
        const min = faults.minDelayMs ?? 0
        const max = faults.maxDelayMs ?? min
        const delay = min + Math.random() * Math.max(0, max - min)
        if (delay <= 0) {
          this.channel.postMessage(message)
          return
        }
        window.setTimeout(() => {
          try {
            this.channel.postMessage(message)
          } catch {
            // The channel closed while the message was in flight.
          }
        }, delay)
      }

      close(): void {
        this.channel.close()
      }
    }

    window.BroadcastChannel =
      FaultyBroadcastChannel as unknown as typeof BroadcastChannel
  })
}

async function setFaults(page: Page, faults: NetworkFaults): Promise<void> {
  await page.evaluate((value) => {
    window.networkFaults = value
  }, faults)
}

const FLAKY: NetworkFaults = {dropRate: 0.25, minDelayMs: 20, maxDelayMs: 600}

async function createRoom(
  context: BrowserContext,
  promptSeconds = 90,
  drawingSeconds = 90,
): Promise<{host: Page; roomCode: string}> {
  const host = await context.newPage()
  await host.goto('/?transport=broadcast')
  await host.getByLabel('Your name').fill('Host')
  await host.getByLabel(/^Prompt timer/).fill(String(promptSeconds))
  await host.getByLabel(/^Drawing timer/).fill(String(drawingSeconds))
  await host.getByRole('button', {name: /create room/i}).click()
  await expect(
    host.getByRole('heading', {name: 'Gather the storytellers'}),
  ).toBeVisible()
  const roomCode = (await host.locator('.room-code strong').innerText()).replace(
    '-',
    '',
  )
  return {host, roomCode}
}

async function joinRoom(
  context: BrowserContext,
  roomCode: string,
  name: string,
  expectedHeading = 'Gather the storytellers',
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(
    `/?transport=broadcast#${new URLSearchParams({room: roomCode})}`,
  )
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: /join room/i}).click()
  await expect(page.getByRole('heading', {name: expectedHeading})).toBeVisible()
  return page
}

/** Completes the current stage on a page: types or draws, then submits. */
async function submitCurrentStage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea#stage-text')
  if (await textarea.isVisible()) {
    await textarea.fill(text)
    await page.getByRole('button', {name: /Submit prompt|Update submission/}).click()
    return
  }
  const canvas = page.getByLabel('Drawing canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('No drawing canvas found')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, {
    steps: 5,
  })
  await page.mouse.up()
  await page.getByRole('button', {name: /Submit drawing|Update submission/}).click()
}

async function countdownSeconds(page: Page): Promise<number> {
  const text = await page.locator('.countdown strong').innerText()
  const [minutes, seconds] = text.split(':').map(Number)
  return minutes * 60 + seconds
}

test.beforeEach(async ({context}) => {
  await installFaultInjector(context)
})

test('a full round stays in sync for everyone on a lossy, laggy network', async ({
  context,
}) => {
  const {host, roomCode} = await createRoom(context)
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')
  const pages = [host, bee, cee]
  for (const page of pages) await setFaults(page, FLAKY)

  await expect(host.locator('.connection-pill')).toContainText('3 online', {
    timeout: 15_000,
  })
  await host.getByRole('button', {name: /shuffle & start round/i}).click()

  const stageHeadings = [
    'Write a secret prompt',
    'Draw what you read',
    'Describe what you see',
  ]
  for (const [stage, heading] of stageHeadings.entries()) {
    for (const page of pages) {
      await expect(
        page.getByRole('heading', {name: heading}),
      ).toBeVisible({timeout: 20_000})
    }
    for (const [index, page] of pages.entries()) {
      await submitCurrentStage(page, `stage ${stage} entry ${index}`)
    }
  }

  for (const page of pages) {
    await expect(page.getByText('The grand reveal', {exact: false})).toBeVisible(
      {timeout: 20_000},
    )
  }

  // The host monitor confirms both guests reached the exact host state.
  await expect(host.locator('.sync-status')).toContainText(
    '2/2 on this page',
    {timeout: 15_000},
  )
  await expect(host.locator('.sync-status li.is-synced')).toHaveCount(2, {
    timeout: 15_000,
  })
})

test('countdown timers agree across every client under jitter', async ({
  context,
}) => {
  const {host, roomCode} = await createRoom(context, 240, 240)
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')
  const pages = [host, bee, cee]
  for (const page of pages) {
    await setFaults(page, {dropRate: 0.2, minDelayMs: 100, maxDelayMs: 900})
  }

  await expect(host.locator('.connection-pill')).toContainText('3 online', {
    timeout: 15_000,
  })
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  for (const page of pages) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible({timeout: 20_000})
  }

  // Give the ping/pong clock estimator a few rounds to settle, then compare
  // all three countdowns at the same moment, twice.
  await host.waitForTimeout(5_000)
  for (let round = 0; round < 2; round += 1) {
    const values = await Promise.all(pages.map(countdownSeconds))
    const spread = Math.max(...values) - Math.min(...values)
    expect(spread).toBeLessThanOrEqual(2)
    await host.waitForTimeout(2_000)
  }
})

test('a fully blocked client is flagged by the host and catches up in seconds', async ({
  context,
}, testInfo) => {
  const demo = process.env.RECORD_DEMO === '1'
  const demoPause = async (page: Page, ms = 1_500) => {
    if (demo) await page.waitForTimeout(ms)
  }
  const {host, roomCode} = await createRoom(context)
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')

  await expect(host.locator('.connection-pill')).toContainText('3 online', {
    timeout: 15_000,
  })
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible()
  }
  await demoPause(host)

  // Guest C loses connectivity entirely; the host advances without them.
  await setFaults(cee, {blockAll: true})
  await expect(
    cee.getByText('Host connection interrupted', {exact: false}),
  ).toBeVisible({timeout: 10_000})
  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'Next stage'}).click()
  await expect(
    host.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible()
  await expect(
    bee.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible({timeout: 10_000})
  await expect(
    cee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  // The host's monitor stops counting the blocked player as on this page.
  await expect(host.locator('.sync-status')).toContainText(
    '1/2 on this page',
    {timeout: 30_000},
  )
  if (demo) {
    await host.evaluate(() => window.scrollTo(0, 0))
    await demoPause(host, 2_500)
    await host.screenshot({
      path: testInfo.outputPath('host-monitor-lagging.png'),
      fullPage: true,
    })
  }

  // Stay blocked long enough that the client performs at least one hard
  // transport reconnect (as after a network change), proving recovery works
  // across a rebuilt connection, not just a healed one.
  await cee.waitForTimeout(14_000)

  // Connectivity returns: the client fast-forwards within a few seconds.
  await setFaults(cee, {})
  await expect(
    cee.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible({timeout: 5_000})
  await expect(
    cee.getByText('Host connection interrupted', {exact: false}),
  ).toHaveCount(0, {timeout: 10_000})
  await expect(host.locator('.sync-status')).toContainText(
    '2/2 on this page',
    {timeout: 15_000},
  )
  if (demo) {
    await host.evaluate(() => window.scrollTo(0, 0))
    await demoPause(host, 2_500)
    await host.screenshot({
      path: testInfo.outputPath('host-monitor-recovered.png'),
      fullPage: true,
    })
  }
})

test('the host closes mid-round and resumes seamlessly on a flaky network', async ({
  context,
}) => {
  const {host, roomCode} = await createRoom(context)
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')
  for (const page of [bee, cee]) await setFaults(page, FLAKY)

  await expect(host.locator('.connection-pill')).toContainText('3 online', {
    timeout: 15_000,
  })
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible({timeout: 20_000})
  }
  await submitCurrentStage(bee, 'submitted before the host vanished')
  await expect(host.getByText(/1 of 3 submitted/)).toBeVisible({
    timeout: 15_000,
  })

  await host.close()
  await expect(
    bee.getByText('Host connection interrupted', {exact: false}),
  ).toBeVisible({timeout: 10_000})

  const resumedHost = await joinRoom(
    context,
    roomCode,
    'Host',
    'Write a secret prompt',
  )
  // The resumed host still has the earlier submission and serves everyone.
  await expect(resumedHost.getByText(/1 of 3 submitted/)).toBeVisible({
    timeout: 15_000,
  })
  await expect(
    bee.getByText('Host connection interrupted', {exact: false}),
  ).toHaveCount(0, {timeout: 15_000})

  await submitCurrentStage(cee, 'submitted after the host resumed')
  await expect(resumedHost.getByText(/2 of 3 submitted/)).toBeVisible({
    timeout: 15_000,
  })
})

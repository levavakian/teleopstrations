import {expect, test, type BrowserContext, type Page} from '@playwright/test'

interface TestEnvelope {
  senderPeer?: string
  message?: {type?: string; reason?: string}
}

interface NetworkTestControls {
  blockedPeers?: string[]
  blockedSnapshotPeers?: string[]
  sentSyncReasons?: string[]
}

async function installFaultInjectingTransport(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    const NativeBroadcastChannel = window.BroadcastChannel
    class FaultInjectingBroadcastChannel {
      readonly name: string
      onmessage: ((event: MessageEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      private readonly channel: BroadcastChannel

      constructor(name: string) {
        this.name = name
        this.channel = new NativeBroadcastChannel(name)
        this.channel.onmessage = (event) => {
          const envelope = event.data as TestEnvelope
          const controls = globalThis as typeof globalThis & {
            networkTestControls?: NetworkTestControls
          }
          const senderPeer = envelope?.senderPeer ?? 'unknown'
          const messageType = envelope?.message?.type ?? 'unknown'
          const dropAll =
            controls.networkTestControls?.blockedPeers?.includes(senderPeer)
          const dropSnapshot =
            messageType === 'snapshot' &&
            controls.networkTestControls?.blockedSnapshotPeers?.includes(
              senderPeer,
            )
          if (dropAll || dropSnapshot) {
            return
          }
          this.onmessage?.(event)
        }
        this.channel.onmessageerror = (event) => this.onmessageerror?.(event)
      }

      postMessage(message: unknown): void {
        const senderPeer =
          new URLSearchParams(location.search).get('peer') ?? 'unknown'
        const envelope = message as TestEnvelope
        const controls = globalThis as typeof globalThis & {
          networkTestControls?: NetworkTestControls
        }
        if (envelope?.message?.type === 'sync-request') {
          controls.networkTestControls ??= {}
          controls.networkTestControls.sentSyncReasons ??= []
          controls.networkTestControls.sentSyncReasons.push(
            envelope.message.reason ?? 'unknown',
          )
        }
        this.channel.postMessage({
          ...(message as Record<string, unknown>),
          senderPeer,
        })
      }

      close(): void {
        this.channel.close()
      }
    }

    window.BroadcastChannel =
      FaultInjectingBroadcastChannel as unknown as typeof BroadcastChannel
  })
}

async function createRoom(
  context: BrowserContext,
): Promise<{host: Page; roomCode: string}> {
  const host = await context.newPage()
  await host.goto('/?transport=broadcast&peer=host')
  await host.getByLabel('Your name').fill('Host')
  await host.getByLabel(/^Prompt timer/).fill('30')
  await host.getByLabel(/^Drawing timer/).fill('30')
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
  role: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(
    `/?transport=broadcast&peer=${role}#${new URLSearchParams({room: roomCode})}`,
  )
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: /join room/i}).click()
  await expect(
    page.getByRole('heading', {name: 'Gather the storytellers'}),
  ).toBeVisible()
  return page
}

async function createTrio(
  context: BrowserContext,
): Promise<{host: Page; bee: Page; cee: Page}> {
  const {host, roomCode} = await createRoom(context)
  const bee = await joinRoom(context, roomCode, 'Guest B', 'bee')
  const cee = await joinRoom(context, roomCode, 'Guest C', 'cee')
  await expect(host.locator('.connection-pill')).toContainText('3 online')
  return {host, bee, cee}
}

test.beforeEach(async ({context}) => {
  await installFaultInjectingTransport(context)
})

test('creator monitor distinguishes same page from exact revision', async ({
  context,
}) => {
  const {host} = await createTrio(context)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(host.locator('.sync-status')).toContainText('2/2 on this page')

  await host
    .getByLabel(/Start this playbook/)
    .fill('Creator draft changes canonical revision')
  await expect(host.locator('.sync-status')).toContainText('2/2 on this page')
  await expect(host.locator('.sync-status')).toContainText(
    'Same page · state update pending',
  )

  await expect(host.locator('.sync-status li.is-synced')).toHaveCount(2, {
    timeout: 7_000,
  })
})

test('creator monitor shows a stale client recover to the current page', async ({
  context,
}, testInfo) => {
  const {host, bee, cee} = await createTrio(context)
  await cee.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        networkTestControls?: NetworkTestControls
      }
    ).networkTestControls = {
      blockedSnapshotPeers: ['host', 'bee'],
    }
  })

  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    bee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()
  await expect(
    cee.getByRole('heading', {name: 'Gather the storytellers'}),
  ).toBeVisible()
  await expect(host.locator('.sync-status')).toContainText('1/2 on this page')
  await expect(
    host.locator('.sync-status li').filter({hasText: 'Guest C'}),
  ).not.toHaveClass(/is-synced/)
  if (process.env.RECORD_DEMO === '1') {
    await host.locator('.sync-status').scrollIntoViewIfNeeded()
    await host.waitForTimeout(2_000)
  }

  await cee.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        networkTestControls?: NetworkTestControls
      }
    ).networkTestControls = {}
  })

  await expect(
    cee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible({timeout: 10_000})
  await expect(host.locator('.sync-status')).toContainText('2/2 on this page')
  await expect(host.locator('.sync-status li.is-synced')).toHaveCount(2)
  if (process.env.RECORD_DEMO === '1') {
    await host.locator('.sync-status').scrollIntoViewIfNeeded()
    await host.waitForTimeout(2_000)
    await host.screenshot({
      path: testInfo.outputPath('sync-recovered.png'),
      fullPage: true,
    })
  }
})

test('recovers from dropped direct creator snapshots and reports sync', async ({
  context,
}, testInfo) => {
  const {host, bee, cee} = await createTrio(context)
  await cee.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        networkTestControls?: NetworkTestControls
      }
    ).networkTestControls = {blockedSnapshotPeers: ['host']}
  })

  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    bee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()
  await expect(
    cee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'Next stage'}).click()
  await expect(
    cee.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible()

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'End round'}).click()
  await expect(cee.getByText('The grand reveal', {exact: false})).toBeVisible()
  await host.getByRole('button', {name: 'Next page'}).click()
  await expect(cee.locator('.paper-number')).toContainText('2of 2')

  await expect(host.locator('.sync-status')).toContainText('2/2 on this page')
  await expect(host.locator('.sync-status')).toContainText(
    'Last update: Playbook 1, page 2',
  )
  await expect(host.locator('.sync-status li.is-synced')).toHaveCount(2)
  if (process.env.RECORD_DEMO === '1') {
    await host.locator('.sync-status').scrollIntoViewIfNeeded()
    await host.waitForTimeout(2_000)
    await host.screenshot({
      path: testInfo.outputPath('sync-monitor.png'),
      fullPage: true,
    })
  }

  await cee.waitForFunction(
    () =>
      ((
        globalThis as typeof globalThis & {
          networkTestControls?: NetworkTestControls
        }
      ).networkTestControls?.sentSyncReasons?.includes('poll') ?? false),
    undefined,
    {timeout: 17_000},
  )
  await expect(
    cee.getByText('The grand reveal', {exact: false}),
  ).toBeVisible()
})

test('gossips authoritative state across a line topology without a creator edge', async ({
  context,
}) => {
  const {host, bee, cee} = await createTrio(context)
  await host.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        networkTestControls?: NetworkTestControls
      }
    ).networkTestControls = {blockedPeers: ['cee']}
  })
  await cee.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        networkTestControls?: NetworkTestControls
      }
    ).networkTestControls = {blockedPeers: ['host']}
  })

  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    bee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()
  await expect(
    cee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'Next stage'}).click()
  await expect(
    cee.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible()

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'End round'}).click()
  await expect(cee.getByText('The grand reveal', {exact: false})).toBeVisible()

  await cee.waitForTimeout(7_000)
  await expect(host.locator('.connection-pill')).toContainText('2 online')
  await expect(cee.locator('.connection-pill')).toContainText('2 online')
  await expect(cee.getByText('The grand reveal', {exact: false})).toBeVisible()
})

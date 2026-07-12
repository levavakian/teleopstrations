import {expect, test, type BrowserContext, type Page} from '@playwright/test'

test.describe.configure({
  retries: process.env.LIVE_WEBRTC === '1' ? 1 : 0,
})

test.skip(
  process.env.LIVE_WEBRTC !== '1',
  'Set LIVE_WEBRTC=1 to exercise public Nostr signaling and real WebRTC.',
)

async function join(
  context: BrowserContext,
  roomCode: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`#${new URLSearchParams({room: roomCode})}`)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: /join room/i}).click()
  await expect(
    page.getByRole('heading', {name: 'Gather the storytellers'}),
  ).toBeVisible({timeout: 45_000})
  return page
}

test('three browsers form a WebRTC mesh and synchronize game state', async ({
  context,
  page: host,
}) => {
  await host.goto('/')
  await host.getByLabel('Your name').fill('WebRTC Host')
  await host.getByLabel(/^Prompt timer/).fill('30')
  await host.getByLabel(/^Drawing timer/).fill('30')
  await host.getByRole('button', {name: /create room/i}).click()
  const roomCode = (await host.locator('.room-code strong').innerText()).replace(
    '-',
    '',
  )

  const second = await join(context, roomCode, 'WebRTC Two')
  const third = await join(context, roomCode, 'WebRTC Three')

  for (const peer of [host, second, third]) {
    await expect(peer.locator('.connection-pill')).toContainText(
      'WebRTC · 2 direct links',
      {timeout: 60_000},
    )
  }

  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    second.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  await second.getByLabel(/Start this playbook/).fill('Sent over WebRTC')
  await second.getByRole('button', {name: 'Submit prompt'}).click()
  await expect(host.getByText(/1 of 3 submitted/)).toBeVisible()
})

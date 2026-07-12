import {expect, test, type BrowserContext, type Page} from '@playwright/test'

interface Trio {
  host: Page
  bee: Page
  cee: Page
  roomCode: string
}

async function createRoom(
  context: BrowserContext,
  promptSeconds = 30,
  drawingSeconds = 30,
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
  await expect(
    page.getByRole('heading', {name: expectedHeading}),
  ).toBeVisible()
  return page
}

async function createTrio(context: BrowserContext): Promise<Trio> {
  const {host, roomCode} = await createRoom(context)
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')
  await expect(host.locator('.connection-pill')).toContainText('3 online')
  return {host, bee, cee, roomCode}
}

async function forceAdvance(page: Page): Promise<void> {
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', {name: 'Force next stage'}).click()
}

async function drawStroke(
  page: Page,
  start: [number, number],
  end: [number, number],
): Promise<void> {
  const canvas = page.getByLabel('Drawing canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Drawing canvas has no bounds')
  await page.mouse.move(
    box.x + box.width * start[0],
    box.y + box.height * start[1],
  )
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width * end[0],
    box.y + box.height * end[1],
    {steps: 8},
  )
  await page.mouse.up()
}

test('three players complete, reveal, and begin another round', async ({
  context,
}) => {
  const {host, bee, cee, roomCode} = await createTrio(context)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()

  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible()
  }

  await host.getByLabel(/Start this playbook/).fill('A small moon bakery')
  await host.getByRole('button', {name: 'Submit prompt'}).click()
  await host
    .getByLabel(/Start this playbook/)
    .fill('A tiny wizard running a bakery on the moon')
  await host.getByRole('button', {name: 'Update submission'}).click()

  await bee
    .getByLabel(/Start this playbook/)
    .fill('A penguin conducting an orchestra')
  await bee.getByRole('button', {name: 'Submit prompt'}).click()

  await expect(host.getByText(/2 of 3 submitted/)).toBeVisible()
  await expect(
    host.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  const pending = await joinRoom(
    context,
    roomCode,
    'Late Player',
    'You’re in the room',
  )
  await expect(
    pending.getByRole('heading', {name: 'You’re in the room'}),
  ).toBeVisible()

  await forceAdvance(host)
  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Draw what you read'}),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {name: /^Color \d+$/}),
    ).toHaveCount(16)
    await expect(
      page.getByRole('button', {name: /^Pen size \d+$/}),
    ).toHaveCount(8)
  }

  await drawStroke(host, [0.2, 0.25], [0.8, 0.7])
  await host.getByRole('button', {name: 'Submit drawing'}).click()
  await drawStroke(host, [0.2, 0.7], [0.8, 0.25])
  await host.getByRole('button', {name: 'Update submission'}).click()

  await drawStroke(bee, [0.15, 0.5], [0.85, 0.5])
  await bee.getByRole('button', {name: 'Submit drawing'}).click()
  await drawStroke(cee, [0.5, 0.15], [0.5, 0.85])
  await cee.getByRole('button', {name: 'Submit drawing'}).click()
  await forceAdvance(host)

  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Describe what you see'}),
    ).toBeVisible()
  }
  await host.getByLabel(/What do you think/).fill('Two crossed shooting stars')
  await bee.getByLabel(/What do you think/).fill('A very straight horizon')
  await cee.getByLabel(/What do you think/).fill('A tall and mysterious line')
  for (const page of [host, bee, cee]) {
    await page.getByRole('button', {name: 'Submit prompt'}).click()
  }
  await forceAdvance(host)

  await expect(host.getByText('The grand reveal', {exact: false})).toBeVisible()
  const openingPrompts: string[] = []
  const revealedOwners: string[] = []
  for (let bookIndex = 0; bookIndex < 3; bookIndex += 1) {
    const heading = host.locator('.reveal-heading h1')
    revealedOwners.push(await heading.innerText())
    openingPrompts.push(
      await host.locator('.reveal-paper blockquote').innerText(),
    )
    await host.getByRole('button', {name: 'Next page'}).click()
    await host.getByRole('button', {name: 'Next page'}).click()
    await host
      .getByRole('button', {
        name: bookIndex === 2 ? 'Finish the reveal →' : 'Next playbook →',
      })
      .click()
  }

  expect(new Set(revealedOwners).size).toBe(3)
  expect(openingPrompts).toContain(
    'A tiny wizard running a bakery on the moon',
  )
  expect(openingPrompts).toContain('A penguin conducting an orchestra')
  expect(openingPrompts).toContain(
    'Guest C did not submit a prompt in time, draw what you think of them',
  )
  await expect(
    host.getByRole('heading', {
      name: 'Every masterpiece has had its moment.',
    }),
  ).toBeVisible()

  await host
    .getByRole('button', {name: 'Shuffle & start next round'})
    .click()
  for (const page of [host, bee, cee, pending]) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible()
    await expect(page.getByText(/0 of 4 submitted/)).toBeVisible()
  }
})

test('the next connected round player takes over when admin disappears', async ({
  context,
}) => {
  const {host, bee, cee} = await createTrio(context)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    bee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  const order = await bee
    .locator('.stage-roster .player-name')
    .evaluateAll((players) =>
      players.map((player) => player.firstChild?.textContent?.trim()),
    )
  const hostIndex = order.indexOf('Host')
  const successor = order[(hostIndex + 1) % order.length]
  const successorPage = successor === 'Guest B' ? bee : cee
  const observerPage = successor === 'Guest B' ? cee : bee

  await host.close()
  await expect(
    successorPage.getByRole('button', {name: 'Force next stage'}),
  ).toBeVisible({timeout: 12_000})

  await forceAdvance(successorPage)
  await expect(
    observerPage.getByRole('heading', {name: 'Draw what you read'}),
  ).toBeVisible()
})

test('a frozen player reclaims their assignment by name', async ({context}) => {
  const {host, bee, cee, roomCode} = await createTrio(context)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    cee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  await cee.close()
  const returned = await joinRoom(
    context,
    roomCode,
    'Guest C',
    'Write a secret prompt',
  )
  await expect(
    returned.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()
  await returned
    .getByLabel(/Start this playbook/)
    .fill('I reclaimed this prompt')
  await returned.getByRole('button', {name: 'Submit prompt'}).click()

  await expect(host.getByText(/1 of 3 submitted/)).toBeVisible()
  await expect(
    bee.locator('.stage-roster .player-name').filter({hasText: 'Guest C'}),
  ).toHaveCount(1)
})

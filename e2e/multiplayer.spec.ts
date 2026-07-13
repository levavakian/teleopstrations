import {readFile} from 'node:fs/promises'

import {expect, test, type BrowserContext, type Page} from '@playwright/test'

interface Trio {
  host: Page
  bee: Page
  cee: Page
  roomCode: string
}

async function demoPause(page: Page, milliseconds = 1_000): Promise<void> {
  if (process.env.RECORD_DEMO === '1') {
    await page.waitForTimeout(milliseconds)
  }
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

async function createTrio(
  context: BrowserContext,
  promptSeconds = 30,
  drawingSeconds = 30,
): Promise<Trio> {
  const {host, roomCode} = await createRoom(
    context,
    promptSeconds,
    drawingSeconds,
  )
  const bee = await joinRoom(context, roomCode, 'Guest B')
  const cee = await joinRoom(context, roomCode, 'Guest C')
  await expect(host.locator('.connection-pill')).toContainText('3 online')
  return {host, bee, cee, roomCode}
}

async function forceAdvance(page: Page): Promise<void> {
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', {name: 'Next stage'}).click()
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
}, testInfo) => {
  const {host, bee, cee, roomCode} = await createTrio(context)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()

  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Write a secret prompt'}),
    ).toBeVisible()
  }
  const hostPrompt = host.getByLabel(/Start this playbook/)
  await hostPrompt.click()
  expect(
    await hostPrompt.evaluate(
      (textarea) => getComputedStyle(textarea).outlineStyle,
    ),
  ).toBe('none')

  await hostPrompt.fill('A small moon bakery')
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

  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Describe what you see'}),
    ).toBeVisible()
  }
  await host.getByRole('button', {name: 'Enlarge drawing'}).click()
  await expect(
    host.getByRole('dialog', {name: 'Enlarged drawing'}),
  ).toBeVisible()
  if (process.env.RECORD_DEMO === '1') {
    await host.waitForTimeout(1_500)
    await host.screenshot({
      path: testInfo.outputPath('enlarged-drawing.png'),
      fullPage: true,
    })
  }
  await host.keyboard.press('Escape')
  await expect(
    host.getByRole('dialog', {name: 'Enlarged drawing'}),
  ).toHaveCount(0)
  await host.getByRole('button', {name: 'Enlarge drawing'}).click()
  await host
    .getByRole('button', {name: 'Close enlarged drawing'})
    .click()
  await host.getByLabel(/What do you think/).fill('Two crossed shooting stars')
  await bee.getByLabel(/What do you think/).fill('A very straight horizon')
  await cee.getByLabel(/What do you think/).fill('A tall and mysterious line')
  for (const page of [host, bee, cee]) {
    await page.getByRole('button', {name: 'Submit prompt'}).click()
  }

  await expect(host.getByText('The grand reveal', {exact: false})).toBeVisible()
  const downloadPromise = host.waitForEvent('download')
  await host.getByRole('button', {name: 'Save playbook'}).click()
  const download = await downloadPromise
  await expect(host.getByRole('button', {name: 'Saved!'})).toBeVisible()
  expect(download.suggestedFilename()).toMatch(/-playbook\.png$/)
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Playbook download did not produce a file')
  const png = await readFile(downloadPath)
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  expect(png.readUInt32BE(16)).toBeGreaterThan(500)
  expect(png.readUInt32BE(20)).toBeGreaterThan(1_000)
  if (process.env.RECORD_DEMO === '1') {
    await download.saveAs(testInfo.outputPath('saved-playbook.png'))
    await host.screenshot({
      path: testInfo.outputPath('save-playbook.png'),
      fullPage: true,
    })
    await host.waitForTimeout(1_500)
  }
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

test('clients queue work until the creator reconnects as authority', async ({
  context,
}) => {
  const {host, bee, roomCode} = await createTrio(context, 3, 3)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await expect(
    bee.getByRole('heading', {name: 'Write a secret prompt'}),
  ).toBeVisible()

  await host.close()
  await bee
    .getByLabel(/Start this playbook/)
    .fill('Queued while the creator was offline')
  await bee.getByRole('button', {name: 'Submit prompt'}).click()
  await expect(
    bee.getByText('Creator connection interrupted', {exact: false}),
  ).toBeVisible({timeout: 10_000})
  await expect(
    bee.getByRole('button', {name: 'Next stage'}),
  ).toHaveCount(0)

  const returnedCreator = await joinRoom(
    context,
    roomCode,
    'Host',
    'Write a secret prompt',
  )
  await expect(
    returnedCreator.getByRole('button', {name: 'Next stage'}),
  ).toBeVisible()
  await expect(returnedCreator.getByText(/1 of 3 submitted/)).toBeVisible({
    timeout: 10_000,
  })
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

test('an older same-name tab cannot steal a reclaimed session back', async ({
  context,
}) => {
  const {host, cee, roomCode} = await createTrio(context)
  const replacement = await joinRoom(context, roomCode, 'Guest C')

  await expect(
    cee.getByRole('heading', {name: 'Welcome back, Guest C'}),
  ).toBeVisible()
  await replacement.waitForTimeout(3_000)
  await expect(
    replacement.getByRole('heading', {name: 'Gather the storytellers'}),
  ).toBeVisible()
  await expect(
    host.locator('.player-name').filter({hasText: 'Guest C'}),
  ).toHaveCount(1)
})

test('a same-name tab cannot replace an active creator session', async ({
  context,
}) => {
  const {host, roomCode} = await createTrio(context)
  const contender = await context.newPage()
  await contender.goto(
    `/?transport=broadcast#${new URLSearchParams({room: roomCode})}`,
  )
  await contender.getByLabel('Your name').fill('Host')
  await contender.getByRole('button', {name: /join room/i}).click()

  await expect(
    contender.getByRole('heading', {name: 'Welcome back, Host'}),
  ).toBeVisible()
  await contender.waitForTimeout(6_000)
  await expect(
    contender.getByRole('heading', {name: 'Welcome back, Host'}),
  ).toBeVisible()
  await expect(
    host.getByRole('button', {name: /shuffle & start round/i}),
  ).toBeVisible()
  await expect(
    host.locator('.player-name').filter({hasText: /^Host/}),
  ).toHaveCount(1)
})

test('deadlines capture drafts, preserve submissions, and keep drawing strokes', async ({
  context,
}) => {
  const {host, bee, cee} = await createTrio(context, 3, 3)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()

  await host
    .getByLabel(/Start this playbook/)
    .fill('Captured host draft at the deadline')
  await bee
    .getByLabel(/Start this playbook/)
    .fill('Bee explicit submission')
  await bee.getByRole('button', {name: 'Submit prompt'}).click()
  await bee
    .getByLabel(/Start this playbook/)
    .fill('Bee unsubmitted edit must not win')

  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Draw what you read'}),
    ).toBeVisible({timeout: 8_000})
  }

  const receivedPrompts = await Promise.all(
    [host, bee, cee].map((page) =>
      page.locator('.source-card blockquote').innerText(),
    ),
  )
  expect(receivedPrompts).toContain('Captured host draft at the deadline')
  expect(receivedPrompts).toContain('Bee explicit submission')
  expect(receivedPrompts).not.toContain('Bee unsubmitted edit must not win')
  expect(receivedPrompts).toContain(
    'Guest C did not submit a prompt in time, draw what you think of them',
  )

  await drawStroke(host, [0.1, 0.1], [0.9, 0.9])
  for (const page of [host, bee, cee]) {
    await expect(
      page.getByRole('heading', {name: 'Describe what you see'}),
    ).toBeVisible({timeout: 8_000})
  }

  const nonWhiteCanvases = await Promise.all(
    [host, bee, cee].map((page) =>
      page.getByLabel('Drawing to describe').evaluate((canvas) => {
        const context = (canvas as HTMLCanvasElement).getContext('2d')!
        const pixels = context.getImageData(0, 0, 1000, 700).data
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index] < 245 ||
            pixels[index + 1] < 245 ||
            pixels[index + 2] < 245
          ) {
            return true
          }
        }
        return false
      }),
    ),
  )
  expect(nonWhiteCanvases).toContain(true)
})

test('creator can kick between rounds, end early, and close the room', async ({
  context,
}, testInfo) => {
  const {host, bee, cee, roomCode} = await createTrio(context)
  await demoPause(host)

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'Kick Guest C'}).click()
  await expect(
    cee.getByRole('heading', {
      name: 'You’ve been removed from this room',
    }),
  ).toBeVisible()
  await expect(
    host.locator('.player-name').filter({hasText: 'Guest C'}),
  ).toHaveCount(0)
  await demoPause(host)

  const replacement = await joinRoom(context, roomCode, 'Replacement')
  await expect(
    host.locator('.player-name').filter({hasText: 'Replacement'}),
  ).toHaveCount(1)
  await demoPause(host)
  await host.getByRole('button', {name: /shuffle & start round/i}).click()
  await demoPause(host)

  await host
    .getByLabel(/Start this playbook/)
    .fill('A deliberately short round')
  await demoPause(host, 1_500)
  if (process.env.RECORD_DEMO === '1') {
    await host.screenshot({
      path: testInfo.outputPath('admin-controls.png'),
      fullPage: true,
    })
  }
  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'End round'}).click()

  for (const page of [host, bee, replacement]) {
    await expect(page.getByText('The grand reveal', {exact: false})).toBeVisible()
    await expect(page.locator('.paper-number')).toContainText('1of 1')
  }
  await demoPause(host, 1_500)

  host.once('dialog', (dialog) => dialog.accept())
  await host.getByRole('button', {name: 'Close room'}).click()
  for (const page of [host, bee, replacement]) {
    await expect(
      page.getByRole('heading', {name: 'This room has been shut down'}),
    ).toBeVisible()
  }
  await demoPause(host, 1_500)
})

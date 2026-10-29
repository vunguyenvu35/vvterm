// Screenshots of the update features against the real backend. Started by update-shots.sh.
import {chromium} from 'playwright'
import path from 'node:path'

const OUT = process.env.SHOT_DIR
const URL = process.env.VVTERM_URL
const MASTER = 'correct horse battery staple'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch()
const page = await (await browser.newContext({viewport: {width: 1360, height: 860}})).newPage()
const shot = async name => { await sleep(300); await page.screenshot({path: path.join(OUT, name + '.png')}); console.log('  screenshot', name) }
const L = label => page.getByLabel(label, {exact: true})

try {
  await page.goto(URL)
  await page.getByRole('form', {name: 'Create vault'}).waitFor()
  await L('Master password').fill(MASTER)
  await L('Confirm password').fill(MASTER)
  await page.getByRole('button', {name: 'Create vault'}).click()
  await page.getByPlaceholder(/Find a host or ssh user@hostname/).waitFor()

  // the corner chip, once the check against the stand-in for GitHub has answered
  await page.getByRole('button', {name: /Update available: version 9\.9\.9/}).waitFor({timeout: 20000})
  await shot('update-chip')

  // the chip opens About with the news
  await page.getByRole('button', {name: /Update available/}).click()
  const about = page.getByRole('dialog', {name: 'About VVTerm'})
  await about.waitFor()
  await about.getByText(/is available/).waitFor()
  await shot('about-update-available')
  await about.getByRole('button', {name: 'Close'}).first().click()

  // Settings: the switch, and the Donate card
  await page.getByRole('button', {name: 'Open settings'}).click()
  const win = page.getByRole('dialog', {name: 'Settings'})
  await win.getByRole('switch', {name: 'Check for updates automatically'}).waitFor()
  await shot('settings-auto-update')
  await win.getByRole('tab', {name: 'Account'}).click()
  await win.getByText('Donate').first().waitFor()
  await shot('settings-donate')
} finally {
  await browser.close()
}

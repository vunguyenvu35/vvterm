// End-to-end walkthrough of VVTerm against the real Go backend (wails dev -browser) and two
// demo SSH servers. Every step asserts behaviour, and screenshots are written to docs/screenshots.
//
//   VVTERM_URL=http://localhost:34115 DEMOSERVER=/path/to/demoserver SSH_CONFIG_DIR=/path node walkthrough.mjs
import {chromium} from 'playwright'
import {spawn} from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// Screenshots go to SHOT_DIR, outside the repo while the app runs: `wails dev` watches the project
// and would reload on every new file. run.sh copies them into docs/screenshots afterwards.
const OUT = process.env.SHOT_DIR ?? path.resolve(here, '..', 'docs', 'screenshots')
const URL = process.env.VVTERM_URL ?? 'http://localhost:34115'
const DEMO = process.env.DEMOSERVER
const SSH_CONFIG = path.join(process.env.SSH_CONFIG_DIR ?? '', 'config')
const MASTER = 'correct horse battery staple'
assert(DEMO, 'set DEMOSERVER to the demoserver binary')

const procs = []
function startDemo(port, name) {
  const p = spawn(DEMO, ['-addr', `127.0.0.1:${port}`, '-name', name], {stdio: 'ignore'})
  procs.push(p)
  return p
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function stopDemo(p) {
  p.kill('SIGINT')
  await new Promise(r => p.once('exit', r))
}

let n = 0
const shots = []
async function shot(page, name) {
  const file = `${String(++n).padStart(2, '0')}-${name}.png`
  await page.screenshot({path: path.join(OUT, file)})
  shots.push(file)
  console.log('  screenshot', file)
}
const step = t => console.log('\n▶', t)

const bastion = startDemo(2201, 'bastion')
let appServer = startDemo(2202, 'app-server')
await sleep(600)

const browser = await chromium.launch()
const page = await (await browser.newContext({viewport: {width: 1360, height: 860}})).newPage()
page.setDefaultTimeout(15000)
const consoleErrors = []
page.on('pageerror', e => consoleErrors.push(String(e)))

try {
  await page.goto(URL)

  step('Create the vault')
  await page.getByRole('form', {name: 'Create vault'}).waitFor()
  await page.getByLabel('Master password', {exact: true}).fill('short')
  await page.getByLabel('Confirm password', {exact: true}).fill('short')
  await page.getByRole('button', {name: 'Create vault'}).click()
  await page.getByRole('alert').filter({hasText: 'at least 12'}).waitFor()
  await page.getByLabel('Master password', {exact: true}).fill(MASTER)
  await page.getByLabel('Confirm password', {exact: true}).fill(MASTER)
  await shot(page, 'create-vault')
  await page.getByRole('button', {name: 'Create vault'}).click()
  await page.getByText('No open terminals').waitFor()
  await shot(page, 'empty-workspace')

  step('Vault: add a password identity and generate a key')
  await page.getByRole('button', {name: /Vault/}).click()
  await page.getByRole('tab', {name: 'Add password'}).click()
  await page.getByLabel('Identity name', {exact: true}).fill('demo-login')
  await page.getByLabel('Username', {exact: true}).fill('demo')
  await page.getByLabel('Password', {exact: true}).fill('demo-password')
  await page.getByRole('button', {name: 'Save'}).click()
  await page.getByRole('tab', {name: 'Generate key'}).click()
  await page.getByLabel('Key name', {exact: true}).fill('deploy-key')
  await page.getByRole('button', {name: 'Generate'}).click()
  const pub = await page.getByTestId('pubkey').textContent()
  assert.match(pub, /^ssh-ed25519 AAAA/)
  assert.ok(!(await page.content()).includes('PRIVATE KEY'), 'private key must never reach the UI')
  await shot(page, 'vault-generated-key')
  await page.getByRole('button', {name: 'Done'}).click()
  await page.getByRole('cell', {name: 'demo-login', exact: true}).waitFor()
  await shot(page, 'vault-identities')
  await page.keyboard.press('Escape')

  step('Create a group and two hosts (one behind a jump host)')
  await page.getByLabel('New group', {exact: true}).click()
  await page.getByLabel('Group name', {exact: true}).fill('vl24h-prod')
  await page.getByRole('button', {name: 'Save'}).click()
  await page.getByRole('dialog').waitFor({state: 'hidden'})

  await page.getByLabel('New host', {exact: true}).click()
  await page.getByLabel('Label', {exact: true}).fill('bastion')
  await page.getByLabel('Hostname', {exact: true}).fill('127.0.0.1')
  await page.getByLabel('Port', {exact: true}).fill('2201')
  await page.getByLabel('Username', {exact: true}).fill('demo')
  await page.getByLabel('Identity', {exact: true}).selectOption({label: 'demo-login (password)'})
  await page.getByLabel('Group', {exact: true}).selectOption({label: 'vl24h-prod'})
  await page.getByLabel('Environment', {exact: true}).selectOption('prod')
  await page.getByLabel('Tags', {exact: true}).fill('edge, ssh')
  await shot(page, 'host-form')
  await page.getByRole('button', {name: 'Save'}).click()
  await page.getByRole('dialog').waitFor({state: 'hidden'})

  await page.getByLabel('New host', {exact: true}).click()
  await page.getByLabel('Label', {exact: true}).fill('app-server')
  await page.getByLabel('Hostname', {exact: true}).fill('127.0.0.1')
  await page.getByLabel('Port', {exact: true}).fill('2202')
  await page.getByLabel('Username', {exact: true}).fill('demo')
  await page.getByLabel('Identity', {exact: true}).selectOption({label: 'demo-login (password)'})
  await page.getByLabel('Group', {exact: true}).selectOption({label: 'vl24h-prod'})
  await page.getByLabel('Environment', {exact: true}).selectOption('staging')
  await page.getByLabel('Jump host', {exact: true}).selectOption({label: 'bastion'})
  await page.getByRole('button', {name: 'Save'}).click()
  await page.getByRole('dialog').waitFor({state: 'hidden'})
  await page.locator('.host', {hasText: 'app-server'}).waitFor()
  await shot(page, 'host-list')

  step('Connect through the jump host; confirm both host keys')
  await page.locator('.host', {hasText: 'app-server'}).dblclick()
  const dlg = page.getByRole('alertdialog', {name: 'Host key confirmation'})
  await dlg.waitFor()
  const fp1 = await dlg.getByTestId('fingerprint').textContent()
  assert.match(fp1, /^SHA256:/)
  await shot(page, 'host-key-prompt')
  await dlg.getByRole('button', {name: 'Trust and connect'}).click()
  await dlg.waitFor() // second prompt: the target behind the bastion
  const fp2 = await dlg.getByTestId('fingerprint').textContent()
  assert.notEqual(fp1, fp2, 'bastion and target have different host keys')
  await dlg.getByRole('button', {name: 'Trust and connect'}).click()
  await page.locator('.xterm-rows').getByText('Welcome to app-server').waitFor()
  await page.locator('.pane').click()
  await page.keyboard.type('hello vvterm')
  await page.keyboard.press('Enter')
  await page.locator('.xterm-rows').getByText('ECHO:hello vvterm').waitFor()
  await shot(page, 'terminal-via-jump-host')

  step('Split pane (second session; keys are already trusted)')
  await page.getByLabel('Split right', {exact: true}).click()
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows').length === 2)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.xterm-rows')).every(e => e.textContent.includes('Welcome to app-server')))
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'no second host key prompt for known hosts')
  await shot(page, 'split-panes')

  step('Port forwarding: local forward through the bastion, verified with a real TCP connection')
  await page.locator('.host', {hasText: 'bastion'}).hover()
  await page.getByLabel('Forwards bastion', {exact: true}).click()
  await page.getByLabel('Bind port', {exact: true}).fill('15022')
  await page.getByLabel('Destination host', {exact: true}).fill('127.0.0.1')
  await page.getByLabel('Destination port', {exact: true}).fill('2202')
  await page.getByRole('button', {name: 'Add forward'}).click()
  await page.getByRole('button', {name: 'Start'}).click()
  await page.getByText(/listening on 127\.0\.0\.1:15022/).waitFor()
  const banner = await new Promise((resolve, reject) => {
    const s = net.connect(15022, '127.0.0.1')
    s.once('data', d => { s.destroy(); resolve(d.toString()) })
    s.once('error', reject)
    setTimeout(() => reject(new Error('no SSH banner through the tunnel')), 5000)
  })
  assert.match(banner, /^SSH-2\.0/, 'tunnel must reach the app-server SSH port')
  await shot(page, 'port-forwards')
  await page.getByRole('button', {name: 'Stop'}).click()
  await page.getByRole('button', {name: 'Start'}).waitFor()
  await page.keyboard.press('Escape')

  step('Import an ~/.ssh/config tree (Include, groups from file names, ProxyJump)')
  await page.getByRole('button', {name: /Data/}).click()
  await page.getByLabel('Config path', {exact: true}).fill(SSH_CONFIG)
  await shot(page, 'import-export')
  await page.getByRole('button', {name: 'Import', exact: true}).click()
  const report = page.getByTestId('import-report')
  await report.waitFor()
  assert.match(await report.textContent(), /Added 2 hosts, 1 groups, 1 forwards/)
  await shot(page, 'import-report')
  await page.keyboard.press('Escape')
  await page.locator('.host', {hasText: 'db-staging'}).waitFor()

  step('Search and filter')
  await page.getByLabel('Search hosts', {exact: true}).fill('maria')
  await page.locator('.host', {hasText: 'db-staging'}).waitFor()
  assert.equal(await page.locator('.host', {hasText: 'app-server'}).count(), 0)
  await shot(page, 'search-filter')
  await page.getByLabel('Search hosts', {exact: true}).fill('')

  step('Sync and settings panels')
  await page.getByRole('button', {name: /Sync/}).click()
  await page.getByRole('dialog', {name: 'Sync via Git'}).waitFor()
  await shot(page, 'sync')
  await page.keyboard.press('Escape')
  await page.getByRole('button', {name: /Settings/}).click()
  await page.getByLabel('Theme', {exact: true}).selectOption('light')
  await page.getByRole('button', {name: 'Save appearance'}).click()
  await shot(page, 'settings')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await shot(page, 'light-theme')
  await page.getByRole('button', {name: /Settings/}).click()
  await page.getByLabel('Theme', {exact: true}).selectOption('dark')
  await page.getByRole('button', {name: 'Save appearance'}).click()
  await page.keyboard.press('Escape')

  step('Connection loss: banner, no automatic reconnect')
  await stopDemo(appServer)
  await page.getByRole('alert').filter({hasText: 'Press Enter to reconnect'}).first().waitFor()
  await shot(page, 'connection-lost')

  step('Host key changed: the connection is blocked with no override')
  appServer = startDemo(2202, 'app-server') // new process = new host key
  await sleep(600)
  await page.locator('.pane').first().click()
  await page.keyboard.press('Enter')
  await page.getByRole('alert').filter({hasText: 'HOST KEY CHANGED'}).first().waitFor()
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'no trust prompt may be offered for a changed key')
  await shot(page, 'host-key-changed')

  step('Lock and unlock')
  await page.getByRole('button', {name: /Lock/}).click()
  await page.getByRole('form', {name: 'Unlock vault'}).waitFor()
  await page.getByLabel('Master password', {exact: true}).fill('wrong password here')
  await page.getByRole('button', {name: 'Unlock'}).click()
  await page.getByRole('alert').filter({hasText: 'wrong master password'}).waitFor()
  await shot(page, 'unlock-wrong-password')
  await page.getByLabel('Master password', {exact: true}).fill(MASTER)
  await page.getByRole('button', {name: 'Unlock'}).click()
  await page.locator('.host', {hasText: 'app-server'}).waitFor()

  assert.deepEqual(consoleErrors, [], 'no uncaught page errors')
  console.log(`\n✔ walkthrough passed (${shots.length} screenshots in docs/screenshots)`)
} catch (e) {
  await page.screenshot({path: path.join(OUT, 'FAILURE.png')}).catch(() => {})
  console.error('\n✘ walkthrough failed:', e)
  process.exitCode = 1
} finally {
  await browser.close()
  procs.forEach(p => p.kill('SIGINT'))
}

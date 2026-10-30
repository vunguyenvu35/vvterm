// End-to-end walkthrough of VVTerm against the real Go backend (wails dev -browser) and two
// demo SSH servers. Every step asserts behaviour, and screenshots are written to docs/screenshots.
//
//   VVTERM_URL=http://localhost:34115 DEMOSERVER=/path/to/demoserver SSH_CONFIG_DIR=/path node walkthrough.mjs
import {chromium} from 'playwright'
import {spawn} from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
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
  const p = spawn(DEMO, ['-addr', `127.0.0.1:${port}`, '-name', name, '-sftp'], {stdio: 'ignore'})
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
  await sleep(250) // let animations settle
  const file = `${String(++n).padStart(2, '0')}-${name}.png`
  await page.screenshot({path: path.join(OUT, file)})
  shots.push(file)
  console.log('  screenshot', file)
}
const step = t => console.log('\n▶', t)

startDemo(2201, 'bastion')
let appServer = startDemo(2202, 'app-server')
await sleep(600)

const browser = await chromium.launch()
const page = await (await browser.newContext({viewport: {width: 1360, height: 860}})).newPage()
page.setDefaultTimeout(15000)
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))
// Browser mode has no native file dialogs, so the app falls back to prompt(); confirm() is the
// "replace?" / "delete?" / "close tab?" question. The walkthrough answers both.
let promptAnswer = ''
let confirmAnswer = true
const seenDialogs = []
page.on('dialog', d => {
  seenDialogs.push(d.type() + ': ' + d.message().split('\n')[0])
  if (d.type() === 'prompt') void d.accept(promptAnswer)
  else if (d.type() === 'confirm' && !confirmAnswer) void d.dismiss()
  else void d.accept()
})

// The app runs in a browser here, so macOS draws no window buttons. The real app has them at the top
// left (hidden-inset title bar); paint the same three dots so the documentation shows what users see.
await page.addInitScript(() => {
  const draw = () => {
    if (document.getElementById('shot-traffic-lights')) return
    const box = document.createElement('div')
    box.id = 'shot-traffic-lights'
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText = 'position:fixed;left:14px;top:16px;display:flex;gap:8px;z-index:2147483647;pointer-events:none'
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
      const d = document.createElement('i')
      d.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + c
      box.appendChild(d)
    }
    document.body.appendChild(box)
  }
  if (document.body) draw()
  else document.addEventListener('DOMContentLoaded', draw)
})

const L = (label) => page.getByLabel(label, {exact: true})
const nav = name => page.getByRole('navigation', {name: 'Main'}).getByRole('button', {name, exact: true})
// every host opens on "Choose protocol" first (SSH is the default)
const continueProtocol = async () => {
  await page.getByRole('radiogroup', {name: 'Protocol'}).waitFor({timeout: 10000})
  await page.getByRole('button', {name: 'Continue'}).click()
}
const goHome = () => page.getByRole('tab', {name: 'Vaults'}).click()
const termText = () => page.locator('.xterm-rows').evaluateAll(els => els.map(e => e.textContent).join('\n'))
const waitTerm = async (text) => page.waitForFunction(t => Array.from(document.querySelectorAll('.xterm-rows')).some(e => e.textContent.includes(t)), text)
const panelClosed = () => page.getByRole('dialog').waitFor({state: 'hidden'})

try {
  await page.goto(URL)

  step('Create the vault')
  await page.getByRole('form', {name: 'Create vault'}).waitFor()
  await L('Master password').fill('short')
  await L('Confirm password').fill('short')
  await page.getByRole('button', {name: 'Create vault'}).click()
  await page.getByRole('alert').filter({hasText: 'at least 12'}).waitFor()
  await L('Master password').fill(MASTER)
  await L('Confirm password').fill(MASTER)
  await shot(page, 'create-vault')
  await page.getByRole('button', {name: 'Create vault'}).click()
  await page.getByPlaceholder(/Find a host or ssh user@hostname/).waitFor()
  await shot(page, 'home-empty')

  step('Keychain: add a password, generate a key, and import one by dragging its file')
  await nav('Keychain').click()
  await page.getByRole('heading', {name: 'Keys'}).waitFor()
  await page.getByRole('button', {name: 'New password'}).click()
  const pwPanel = page.getByRole('dialog', {name: 'New Password'})
  await pwPanel.getByLabel('Label', {exact: true}).fill('demo-login')
  await pwPanel.getByLabel('Username', {exact: true}).fill('demo')
  await pwPanel.getByLabel('Password', {exact: true}).fill('demo-password')
  await pwPanel.getByRole('button', {name: 'Save password'}).click()
  await page.getByRole('status').filter({hasText: 'Password saved'}).waitFor()
  await page.getByRole('button', {name: 'Generate key'}).click()
  const genPanel = page.getByRole('dialog', {name: 'Generate Key'})
  await genPanel.getByLabel('Label', {exact: true}).fill('deploy-key')
  await genPanel.getByRole('button', {name: 'Generate'}).click()
  const pub = await page.getByTestId('pubkey').textContent()
  assert.match(pub, /^ssh-ed25519 AAAA/)
  assert.ok(!(await page.content()).includes('PRIVATE KEY'), 'private key must never reach the UI')
  await shot(page, 'keychain-generated-key')
  await genPanel.getByRole('button', {name: 'Done'}).click()

  // a private key file dropped on the New Key panel fills it in
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({type: 'pkcs8', format: 'pem'})
  await page.getByRole('button', {name: 'New key', exact: true}).click()
  const keyPanel = page.getByRole('dialog', {name: 'New Key'})
  await keyPanel.getByTestId('key-drop').waitFor()
  await page.getByTestId('key-drop').evaluate((zone, text) => {
    const dt = new DataTransfer()
    dt.items.add(new File([text], 'e2e_key.pem', {type: 'text/plain'}))
    zone.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}))
  }, pem)
  await page.waitForFunction(() => document.querySelector('[aria-label="Private key"]')?.value.includes('PRIVATE KEY'))
  assert.equal(await keyPanel.getByLabel('Label', {exact: true}).inputValue(), 'e2e_key', 'the label comes from the file name')
  await page.getByTestId('draft-card').getByText('e2e_key').waitFor()
  await shot(page, 'keychain-new-key')
  await keyPanel.getByRole('button', {name: 'Save key'}).click()
  const cards = page.getByRole('list', {name: 'Identities'})
  await cards.getByText('e2e_key', {exact: true}).waitFor()
  await cards.getByText('demo-login', {exact: true}).waitFor()
  await shot(page, 'keychain-identities')

  step('Create a group, then a host with Test connection (wrong password first)')
  await nav('Hosts').click()
  await L('More ways to add hosts').click()
  await page.getByRole('menu', {name: 'Add'}).waitFor()
  await shot(page, 'new-host-menu')
  await page.getByRole('menuitem', {name: 'New group'}).click()
  await L('Group name').fill('acme-prod')
  await page.getByRole('button', {name: 'Save'}).click()
  await panelClosed()

  await L('New host').click()
  const panel = page.getByRole('dialog', {name: 'New host'})
  await panel.waitFor()
  assert.equal(await panel.evaluate(el => el.tagName), 'ASIDE', 'the form is docked, not a popup')
  assert.equal(await page.locator('.modal-back').count(), 0, 'no modal backdrop')
  await page.getByRole('list', {name: 'Hosts'}).waitFor() // the list stays on screen next to the form
  await L('Hostname').fill('127.0.0.1')
  await page.getByTestId('draft-card').getByText('127.0.0.1').waitFor() // live draft card in the grid
  await L('Label').fill('bastion')
  await panel.getByRole('combobox', {name: /^Group,/}).click() // the custom dropdown, not the native popup
  await page.getByRole('listbox', {name: 'Group'}).waitFor()
  await shot(page, 'custom-select')
  await page.getByRole('option', {name: 'acme-prod'}).click()
  await panel.getByRole('combobox', {name: /^Environment,/}).click()
  await page.getByRole('option', {name: /^prod/}).click()
  await L('Tags').fill('edge, ssh')
  await L('Port').fill('2201')
  await L('Username').fill('demo')
  await L('Password').fill('wrong-password')
  await shot(page, 'new-host-panel')

  await panel.getByRole('button', {name: 'Test connection'}).click()
  const hk = panel.getByRole('alertdialog', {name: 'Host key confirmation'})
  await hk.waitFor()
  const fp1 = await hk.getByTestId('fingerprint').textContent()
  assert.match(fp1, /^SHA256:/)
  await shot(page, 'test-connection-host-key')
  await hk.getByRole('button', {name: 'Trust and continue'}).click()
  const result = panel.getByTestId('test-result')
  await result.filter({hasText: 'Connection failed'}).waitFor()
  assert.match(await result.textContent(), /Authentication failed/)
  assert.ok(!(await result.textContent()).includes('wrong-password'), 'the password is never echoed')
  await shot(page, 'test-connection-failed')

  await L('Password').fill('demo-password')
  await panel.getByRole('button', {name: 'Test connection'}).click()
  await result.filter({hasText: 'Connection successful'}).waitFor()
  assert.match(await result.textContent(), /SSH-2\.0/)
  await shot(page, 'test-connection-ok')
  assert.equal(await page.locator('.host', {hasText: 'bastion'}).count(), 0, 'testing saves nothing (only the draft card exists)')
  await panel.getByRole('button', {name: 'Save'}).click()
  await panelClosed()

  step('Second host behind the jump host: Connect saves and opens the terminal')
  await L('New host').click()
  await L('Hostname').fill('127.0.0.1')
  await L('Label').fill('app-server')
  await L('Group').selectOption({label: 'acme-prod'})
  await L('Environment').selectOption('staging')
  await L('Port').fill('2202')
  await L('Jump host').selectOption({label: 'Via bastion'})
  await L('Username').fill('demo')
  await L('Identity').selectOption({label: 'demo-login'})
  await page.getByRole('dialog', {name: 'New host'}).getByRole('button', {name: 'Connect', exact: true}).click()
  await shot(page, 'choose-protocol')
  await continueProtocol()

  // the terminal tab opens; the bastion is already trusted, the target is new: one prompt
  const dlg = page.getByRole('alertdialog', {name: 'Host key confirmation'})
  await dlg.waitFor()
  const fp2 = await dlg.getByTestId('fingerprint').textContent()
  assert.notEqual(fp1, fp2, 'bastion and target have different host keys')
  await shot(page, 'host-key-prompt')
  await dlg.getByRole('button', {name: 'Trust and connect'}).click()
  await waitTerm('Welcome to app-server')
  // the connecting screen's line runs to its end first, then the terminal shows
  await page.getByRole('status', {name: 'Connecting'}).waitFor({state: 'detached'})
  await page.locator('.pane').click()
  await page.keyboard.type('hello vvterm')
  await page.keyboard.press('Enter')
  await waitTerm('ECHO:hello vvterm')
  await shot(page, 'terminal-via-jump-host')

  await goHome()
  const groupCard = page.getByRole('button', {name: 'Open group acme-prod'})
  await groupCard.waitFor()
  assert.match(await groupCard.textContent(), /2 Hosts/)
  await shot(page, 'hosts-groups')
  await groupCard.click()
  await page.locator('.host', {hasText: 'app-server'}).waitFor()
  await shot(page, 'hosts-in-group')

  step('A side panel closes when you move to another screen')
  await L('New host').click()
  await page.getByRole('dialog', {name: 'New host'}).waitFor()
  await L('Hostname').fill('typed-but-abandoned')
  await nav('Keychain').click()
  await page.getByRole('dialog', {name: 'New host'}).waitFor({state: 'hidden'})
  await nav('Hosts').click()
  assert.equal(await page.getByRole('dialog', {name: 'New host'}).count(), 0, 'the panel must not come back')
  assert.equal(await page.getByTestId('draft-card').count(), 0, 'and neither does its draft card')

  step('Snippets: create, run, paste and pick from the terminal')
  await goHome()
  await nav('Snippets').click()
  await L('New snippet').click()
  await L('Snippet label').fill('Say hello')
  await L('Snippet description').fill('prints a greeting')
  await L('Script').fill('echo from-snippet')
  await shot(page, 'new-snippet-panel')
  await page.getByRole('button', {name: 'Save'}).click()
  await panelClosed()
  await L('New snippet').click()
  await L('Snippet label').fill('Two steps')
  await L('Script').fill('step-one\nstep-two')
  await page.getByRole('button', {name: 'Save'}).click()
  await panelClosed()
  await page.getByRole('list', {name: 'Snippets'}).getByText('Say hello').waitFor()
  await shot(page, 'snippets-page')

  await L('Run Say hello').click() // switches to the open terminal and types the script plus Enter
  await waitTerm('ECHO:echo from-snippet')
  await L('Run Two steps').isHidden() // the home page is hidden behind the terminal now
  await page.getByRole('button', {name: 'Run snippet'}).click()
  await page.getByRole('menu', {name: 'Snippets'}).waitFor()
  await shot(page, 'snippet-picker')
  await page.getByRole('menuitem', {name: /Two steps/}).getByRole('button').first().click()
  await waitTerm('ECHO:step-one')
  await waitTerm('ECHO:step-two')
  const typedText = await termText()
  assert.ok(typedText.indexOf('ECHO:step-one') < typedText.indexOf('ECHO:step-two'), 'lines are typed in order')

  step('Split pane (second session; keys are already trusted)')
  await L('Split right').click()
  await page.waitForFunction(() => document.querySelectorAll('.xterm-rows').length === 2)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.xterm-rows')).every(e => e.textContent.includes('Welcome to app-server')))
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'no second host key prompt for known hosts')
  await shot(page, 'split-panes')

  step('Port forwarding: the wizard, then a local forward through the bastion, verified with a real TCP connection')
  await goHome()
  await nav('Port Forwarding').click()
  await page.getByRole('button', {name: 'New forwarding'}).click()
  await page.getByRole('dialog', {name: 'New Port Forwarding'}).getByText('Select the port forwarding type:').waitFor()
  await shot(page, 'forwarding-wizard-type')
  await page.getByRole('button', {name: 'Continue'}).click()
  const wiz = () => page.getByRole('dialog', {name: 'Local Port Forwarding'})
  await wiz().getByLabel('Local port number').fill('15022')
  await shot(page, 'forwarding-wizard-port')
  await wiz().getByRole('button', {name: 'Continue'}).click()
  const hostStep = page.getByRole('dialog', {name: 'Select Host'})
  await hostStep.waitFor()
  await shot(page, 'forwarding-wizard-host')
  await hostStep.getByRole('button', {name: 'Use host bastion'}).click()
  await wiz().getByLabel('Destination host').fill('127.0.0.1')
  await wiz().getByLabel('Destination port').fill('2202')
  await wiz().getByRole('button', {name: 'Continue'}).click()
  await wiz().getByLabel('Label').fill('App SSH via bastion')
  await wiz().getByRole('button', {name: 'Save'}).click()
  await panelClosed()
  const rules = page.getByRole('list', {name: 'Port forwards'})
  await rules.getByText('App SSH via bastion', {exact: true}).waitFor()
  await page.getByRole('button', {name: 'Start App SSH via bastion'}).click()
  await page.getByText(/listening on 127\.0\.0\.1:15022/).waitFor()
  const banner = await new Promise((resolve, reject) => {
    const s = net.connect(15022, '127.0.0.1')
    s.once('data', d => { s.destroy(); resolve(d.toString()) })
    s.once('error', reject)
    setTimeout(() => reject(new Error('no SSH banner through the tunnel')), 5000)
  })
  assert.match(banner, /^SSH-2\.0/, 'tunnel must reach the app-server SSH port')
  await rules.getByText(/running/).waitFor()
  await shot(page, 'port-forwards-page')
  await page.getByRole('button', {name: 'Stop App SSH via bastion'}).click()
  await rules.getByText(/stopped/).waitFor()

  step('Import an ~/.ssh/config tree (Include, groups from file names, ProxyJump)')
  await nav('Hosts').click()
  await nav('Import / Export').click()
  await L('Config path').fill(SSH_CONFIG)
  await shot(page, 'import-export')
  await page.getByRole('button', {name: 'Import', exact: true}).click()
  const report = page.getByTestId('import-report')
  await report.waitFor()
  assert.match(await report.textContent(), /Added 2 hosts, 1 groups, 1 forwards/)
  await shot(page, 'import-report')
  await page.keyboard.press('Escape')
  await page.getByRole('button', {name: 'Open group legacy-staging'}).waitFor()

  step('SFTP: two panes, several files and folders, drag and drop, replace, rename and delete on the real SFTP subsystem')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vvterm-e2e-'))
  const write = (rel, body) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, body) }
  write('upload-me.txt', 'hello from vvterm\n')
  write('extra.txt', 'extra v1\n')
  write('bundle/one.txt', '1')
  write('bundle/two.txt', '22')
  write('bundle/nested/three.txt', '333')
  fs.mkdirSync(path.join(tmp, 'downloads'))
  const mod = ['ControlOrMeta']

  await page.getByRole('tab', {name: 'SFTP'}).click()
  const sftp = page.getByTestId('sftp')
  await sftp.waitFor()
  assert.equal(await page.getByRole('button', {name: /^SFTP /}).count(), 0, 'a host card has no SFTP button: the tab is the way in')
  await sftp.getByRole('region', {name: 'Remote'}).getByText('Connect to host').waitFor()
  await shot(page, 'sftp-connect-to-host')
  await sftp.getByRole('button', {name: 'Select host'}).click()
  await shot(page, 'sftp-select-host')
  await sftp.getByRole('button', {name: 'Connect to app-server'}).click()
  const tabNames = (await page.getByRole('tab').allTextContents()).map(t => t.trim())
  assert.deepEqual(tabNames.slice(0, 2), ['Vaults', 'SFTP'], 'the SFTP tab sits right after Vaults')
  assert.equal(await page.getByRole('button', {name: /^Close SFTP/}).count(), 0, 'the SFTP tab has no close button')
  const localPane = sftp.getByRole('region', {name: 'Local'})
  const remotePane = sftp.getByRole('region', {name: 'Remote'})
  const lrow = name => localPane.getByRole('row', {name: new RegExp('^' + name.replace('.', '\\.'))})
  const rrow = name => remotePane.getByRole('row', {name: new RegExp('^' + name.replace('.', '\\.'))})
  // every file action lives in the pane's Actions menu (the same one as the right-click menu)
  const act = async (pane, item) => {
    await pane.getByRole('button', {name: 'Actions'}).click()
    await page.getByRole('menu', {name: 'Actions'}).getByRole('menuitem', {name: item}).click()
  }
  await rrow('notes.txt').waitFor()
  assert.equal(await remotePane.getByLabel('Remote path').inputValue(), '/', 'opens in the remote home folder')
  await localPane.getByLabel('Local path').fill(tmp)
  await localPane.getByLabel('Local path').press('Enter')
  await lrow('upload-me.txt').waitFor()
  await shot(page, 'sftp-browser')

  // one file with the button
  await lrow('upload-me.txt').click()
  await act(localPane, 'Upload')
  await rrow('upload-me.txt').waitFor()
  const queue = sftp.getByRole('region', {name: 'Transfers'}) // transfers run in a queue now
  await queue.waitFor()
  await queue.getByRole('listitem', {name: 'upload-me.txt'}).filter({hasText: 'Done'}).waitFor()
  await shot(page, 'sftp-transfer')
  await queue.getByRole('button', {name: 'Clear finished'}).click()
  await queue.waitFor({state: 'detached'}) // nothing left to show

  // a folder and a file together: Cmd/Ctrl-click, then one Upload
  await lrow('bundle').click()
  await lrow('extra.txt').click({modifiers: mod})
  await localPane.getByRole('status').filter({hasText: '2 selected'}).waitFor()
  await shot(page, 'sftp-multi-select')
  await act(localPane, 'Upload')
  await rrow('bundle').waitFor()
  await rrow('extra.txt').waitFor()
  await rrow('bundle').dblclick()
  await rrow('nested').waitFor()
  await rrow('one.txt').waitFor()
  await rrow('nested').dblclick()
  await rrow('three.txt').waitFor()
  await remotePane.getByRole('button', {name: 'Home folder'}).click()
  await rrow('bundle').waitFor()

  // uploading again asks once before replacing, in the app (a desktop webview has no confirm())
  write('extra.txt', 'extra v2\n')
  await lrow('extra.txt').click()
  await act(localPane, 'Upload')
  const replace = page.getByRole('alertdialog', {name: 'Confirm'})
  await replace.waitFor()
  assert.match(await replace.textContent(), /extra\.txt already exists/)
  await shot(page, 'sftp-replace')
  await replace.getByRole('button', {name: 'Replace'}).click()
  await replace.waitFor({state: 'detached'})

  // drag a remote file onto the local pane
  await rrow('notes.txt').dragTo(localPane.getByRole('table', {name: 'Local files'}))
  for (let i = 0; i < 50 && !fs.existsSync(path.join(tmp, 'notes.txt')); i++) await sleep(100)
  assert.equal(fs.readFileSync(path.join(tmp, 'notes.txt'), 'utf8'), 'VVTerm demo notes\n', 'a dragged file arrives with its content')

  // download a remote folder into the downloads folder, with its subfolders
  await lrow('downloads').dblclick()
  await localPane.getByRole('navigation', {name: 'Local folder path'}).getByText('downloads').waitFor()
  await rrow('bundle').click()
  await sftp.getByRole('button', {name: 'Download selected'}).click()
  for (let i = 0; i < 50 && !fs.existsSync(path.join(tmp, 'downloads', 'bundle', 'nested', 'three.txt')); i++) await sleep(100)
  assert.equal(fs.readFileSync(path.join(tmp, 'downloads', 'bundle', 'nested', 'three.txt'), 'utf8'), '333', 'folders come down with everything in them')
  assert.equal(fs.readFileSync(path.join(tmp, 'downloads', 'bundle', 'two.txt'), 'utf8'), '22')
  await shot(page, 'sftp-folder-download')

  // rename, then delete two items after one confirmation
  await rrow('extra.txt').click()
  await act(remotePane, 'Rename')
  await remotePane.getByLabel('Name').fill('extra-renamed.txt')
  await remotePane.getByLabel('Name').press('Enter')
  await rrow('extra-renamed.txt').waitFor()
  // right-click: the same actions as the buttons, plus Open with, Copy to target directory and Edit Permissions
  await rrow('extra-renamed.txt').click({button: 'right'})
  const ctx = page.getByRole('menu', {name: 'File menu'})
  await ctx.waitFor()
  assert.deepEqual(await ctx.getByRole('menuitem').allTextContents(), ['Open', 'Open with…', 'Edit and save back', 'Download', 'Rename', 'Delete', 'Refresh', 'New Folder', 'Hide Hidden Files', 'Edit Permissions', 'Select All', 'Close'])
  await shot(page, 'sftp-context-menu')
  await ctx.getByRole('menuitem', {name: 'Edit Permissions'}).click()
  await L('Octal permissions').fill('600')
  await shot(page, 'sftp-permissions')
  await page.getByRole('button', {name: 'Save', exact: true}).click()
  await page.getByRole('dialog').waitFor({state: 'detached'})
  await rrow('bundle').click()
  await rrow('extra-renamed.txt').click({modifiers: mod})
  await act(remotePane, 'Delete')
  const del = page.getByRole('alertdialog', {name: 'Confirm'})
  assert.match(await del.textContent(), /these 2 items/)
  await del.getByRole('button', {name: 'Delete'}).click()
  await rrow('bundle').waitFor({state: 'detached'})
  await rrow('extra-renamed.txt').waitFor({state: 'detached'})
  await goHome()
  await nav('Hosts').click()

  step('Terminal on this computer: a real shell, highlighting, numbered and renamed tabs')
  await goHome()
  await nav('Hosts').click()
  await page.getByRole('button', {name: 'Terminal', exact: true}).click()
  await page.getByRole('tab', {name: 'Local', selected: true}).waitFor()
  // wait for the shell's prompt: what is typed before the shell is ready has nowhere to go
  await page.waitForFunction(() => (Array.from(document.querySelectorAll('.xterm-rows')).at(-1)?.textContent ?? '').trim().length > 0, null, {timeout: 30000})
  await page.locator('.pane').last().click()
  await page.keyboard.type('echo vvterm-local-$((6*7))')
  await page.keyboard.press('Enter')
  await waitTerm('vvterm-local-42')
  // finished lines get Termius-style colours: the word ERROR is red, an IP address yellow, a path blue
  await page.keyboard.type('echo ERROR 10.0.0.1 /tmp/vvterm')
  await page.keyboard.press('Enter')
  await page.keyboard.type('echo done-line')
  await page.keyboard.press('Enter')
  await waitTerm('done-line')
  const colourOf = word => page.waitForFunction(w => {
    const spans = Array.from(document.querySelectorAll('.xterm-rows span'))
    const hit = spans.find(s => s.textContent === w)
    return hit ? getComputedStyle(hit).color : false
  }, word).then(h => h.jsonValue())
  const red = await colourOf('ERROR').catch(() => '')
  console.log('  ERROR is drawn in', red || '(not found as its own span)')
  await shot(page, 'local-terminal')

  // the sidebar beside the terminal: what was typed is in History, and the themes are pictures
  await page.getByRole('button', {name: 'History'}).click()
  const history = page.getByRole('list', {name: 'History'})
  await history.getByRole('button', {name: 'echo done-line'}).waitFor()
  assert.equal(await history.getByText('vvterm-local-$((6*7))').count() > 0, true, 'a typed command is in the history')
  await shot(page, 'sidebar-history')
  await page.getByRole('button', {name: 'Themes and font'}).click()
  await page.getByRole('listbox', {name: 'Themes'}).getByRole('option', {name: /Dracula/}).click()
  await page.getByLabel('Font family').waitFor()
  await shot(page, 'sidebar-themes')
  await page.getByRole('listbox', {name: 'Themes'}).getByRole('option', {name: /Match app theme/}).click()
  await page.getByRole('button', {name: 'Snippets', exact: true}).first().waitFor()

  await goHome()
  await page.getByRole('button', {name: 'Terminal', exact: true}).click()
  await page.getByRole('tab', {name: 'Local (2)', selected: true}).waitFor()
  // double-click a tab to rename it
  await page.getByText('Local (2)', {exact: true}).dblclick()
  await page.getByLabel('Tab name').fill('build shell')
  await page.getByLabel('Tab name').press('Enter')
  await page.getByRole('tab', {name: 'build shell'}).waitFor()
  await shot(page, 'tabs-numbered-renamed')
  for (const name of ['build shell', 'Local']) {
    await page.getByRole('button', {name: 'Close ' + name, exact: true}).click()
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'closing a tab does not ask')
    await page.getByRole('tab', {name, exact: true}).waitFor({state: 'detached'})
  }
  // the + tab: a blank tab with a search box and the recent connections
  await page.getByLabel('New connection').click()
  await page.getByRole('tab', {name: 'New Tab', selected: true}).waitFor()
  await page.getByRole('listbox', {name: 'Recent connections'}).getByRole('option').first().waitFor()
  await shot(page, 'new-tab')
  await page.getByLabel('Search hosts or tabs').fill('no-such-host-anywhere')
  await page.getByText('Nothing matches.').waitFor()
  await page.getByRole('button', {name: 'Close New Tab', exact: true}).click()
  await goHome()

  step('Find, filter and quick connect')
  await L('Search hosts').fill('maria')
  await page.locator('.host', {hasText: 'db-staging'}).waitFor()
  assert.equal(await page.locator('.host', {hasText: 'app-server'}).count(), 0)
  await shot(page, 'search-filter')
  await L('Search hosts').fill('ssh newuser@new.example.org:2200')
  await page.getByRole('button', {name: 'Connect', exact: true}).click()
  await page.getByRole('dialog', {name: 'New host'}).waitFor()
  assert.equal(await L('Hostname').inputValue(), 'new.example.org')
  assert.equal(await L('Port').inputValue(), '2200')
  assert.equal(await L('Username').inputValue(), 'newuser')
  await shot(page, 'quick-connect')
  await page.getByRole('button', {name: 'Add Telnet'}).click()
  await L('Telnet username').fill('operator')
  await page.getByRole('button', {name: /^Terminal theme/}).click()
  await page.getByRole('option', {name: /Hacker Green/}).click()
  await shot(page, 'new-host-telnet')
  await page.keyboard.press('Escape')
  await L('Search hosts').fill('')

  step('Known Hosts: every key you trusted is listed')
  await nav('Known Hosts').click()
  const known = page.getByRole('list', {name: 'Known hosts'})
  await known.getByText('[127.0.0.1]:2201').waitFor()
  await known.getByText('[127.0.0.1]:2202').waitFor()
  assert.match(await known.textContent(), /ssh-ed25519 · SHA256:/)
  await shot(page, 'known-hosts')

  step('Settings opens as its own window: theme, terminal theme, security, sync')
  await nav('Settings').click()
  const win = page.getByRole('dialog', {name: 'Settings'})
  await win.waitFor()
  assert.equal(await win.evaluate(el => !!el.closest('.win-back')), true, 'a floating window above the page')
  await win.getByTestId('app-version').waitFor()

  // it can be dragged by its title bar
  const before = await win.boundingBox()
  await page.mouse.move(before.x + 400, before.y + 22)
  await page.mouse.down()
  await page.mouse.move(before.x + 480, before.y + 62, {steps: 5})
  await page.mouse.up()
  const after = await win.boundingBox()
  assert.ok(Math.abs(after.x - before.x - 80) <= 2 && Math.abs(after.y - before.y - 40) <= 2, 'window dragged: ' + JSON.stringify({before, after}))
  await shot(page, 'settings-general')

  // General: zoom the whole interface, and the other switches are there
  await win.getByRole('tab', {name: 'General', selected: true}).waitFor()
  await win.getByRole('button', {name: 'Zoom in'}).click()
  await page.waitForFunction(() => document.documentElement.style.zoom === '1.1')
  await win.getByRole('button', {name: 'Reset zoom'}).waitFor({state: 'attached'})
  await win.getByRole('button', {name: 'Reset zoom'}).click()
  await page.waitForFunction(() => ['', '1'].includes(document.documentElement.style.zoom))
  await win.getByRole('switch', {name: 'Confirm before closing a tab'}).waitFor()
  await win.getByRole('switch', {name: 'Reduce motion'}).waitFor()

  // Account: a local profile today, ready for sign-in later
  await win.getByRole('tab', {name: 'Account'}).click()
  await win.getByLabel('Display name').fill('Vu Nguyen')
  await win.getByLabel('Email').fill('vu@example.com')
  await win.getByRole('button', {name: 'Save profile'}).click()
  await win.locator('.avatar', {hasText: 'V'}).waitFor()
  assert.equal(await win.getByRole('button', {name: 'Sign in'}).isDisabled(), true)

  // the update check asks GitHub for the latest release (a dev build is never told to update)
  await win.getByRole('button', {name: 'Check for updates'}).click()
  await page.getByText('You are on the latest version').waitFor()
  await shot(page, 'settings-account')

  // the window can be maximised, restored, and rolled up
  await win.getByRole('button', {name: 'Maximize settings'}).click()
  await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label=Settings]')?.classList.contains('max'))
  const big = await win.boundingBox()
  assert.ok(big.width > 1200 && big.height > 700, 'maximised: ' + JSON.stringify(big))
  await shot(page, 'settings-maximized')
  await win.getByRole('button', {name: 'Restore settings'}).click()
  await page.waitForFunction(() => !document.querySelector('[role=dialog][aria-label=Settings]')?.classList.contains('max'))
  await win.getByRole('button', {name: 'Minimize settings'}).click()
  await win.getByRole('tablist').waitFor({state: 'hidden'})
  await win.getByRole('button', {name: 'Unroll settings'}).click()
  await win.getByRole('tablist').waitFor()

  await win.getByRole('tab', {name: 'Terminal'}).click()
  await win.getByRole('radio', {name: 'Dracula'}).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=term-preview]')?.style.background.includes('rgb(40, 42, 54)'))
  await shot(page, 'settings-terminal-theme')
  await win.getByRole('radio', {name: 'bar'}).click()
  await win.getByRole('tab', {name: 'Security'}).click()
  await shot(page, 'settings-security')
  await win.getByRole('tab', {name: 'Sync'}).click()
  await page.getByRole('region', {name: 'Sync via Git'}).waitFor()
  await shot(page, 'sync')
  // Shortcuts: record a new combination, see it work, then reset
  await win.getByRole('tab', {name: 'Shortcuts'}).click()
  await win.getByRole('button', {name: /^Change shortcut for Zoom in/}).click()
  await page.keyboard.press('ControlOrMeta+Comma') // already used by "Open settings"
  await win.getByRole('alert').filter({hasText: 'Already used by'}).waitFor()
  await page.keyboard.press('Alt+KeyZ')
  await win.getByRole('button', {name: /^Change shortcut for Zoom in/}).filter({hasText: /⌥Z|Alt\+Z/}).waitFor()
  await shot(page, 'settings-shortcuts')
  await page.keyboard.press('Alt+KeyZ')
  await page.waitForFunction(() => document.documentElement.style.zoom === '1.1')
  await page.keyboard.press('ControlOrMeta+Digit0')
  await page.waitForFunction(() => ['', '1'].includes(document.documentElement.style.zoom))
  await win.getByRole('button', {name: 'Reset all'}).click()
  await win.getByRole('button', {name: /^Change shortcut for Zoom in/}).filter({hasText: '=', hasNotText: 'Z'}).waitFor()
  await win.getByRole('tab', {name: 'Terminal'}).click()

  // theme dropdown in the sidebar (custom menu): Light, then back to Dark
  await win.getByRole('combobox', {name: /^Theme,/}).click()
  await shot(page, 'theme-dropdown')
  await page.getByRole('option', {name: 'Light'}).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await shot(page, 'light-theme')
  await win.getByRole('combobox', {name: /^Theme,/}).click()
  await page.getByRole('option', {name: 'Dark'}).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await win.getByRole('radio', {name: /Match app theme/}).click()

  // Esc closes an open dropdown first, then the window
  await win.getByRole('combobox', {name: /^Font family,/}).click()
  await page.keyboard.press('Escape')
  assert.equal(await win.count(), 1, 'Esc closed only the dropdown')
  await page.keyboard.press('Escape')
  await win.waitFor({state: 'hidden'})
  await page.keyboard.press('ControlOrMeta+Comma') // the shortcut opens it again
  await win.waitFor()
  await win.getByRole('button', {name: 'Close settings'}).click()
  await win.waitFor({state: 'hidden'})

  step('Connection loss: banner, no automatic reconnect')
  await page.getByRole('tab', {name: /app-server/}).click()
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
  await goHome()
  await nav('Lock vault').click()
  await page.getByRole('form', {name: 'Unlock vault'}).waitFor()
  await L('Master password').fill('wrong password here')
  await page.getByRole('button', {name: 'Unlock'}).click()
  await page.getByRole('alert').filter({hasText: 'wrong master password'}).waitFor()
  await shot(page, 'unlock-wrong-password')
  await L('Master password').fill(MASTER)
  await page.getByRole('button', {name: 'Unlock'}).click()
  await nav('Hosts').click() // the app comes back to the page that was open when it locked
  await page.getByPlaceholder(/Find a host or ssh user@hostname/).waitFor()

  step('Logs: what happened, newest first, filterable')
  await nav('Logs').click()
  const table = page.getByRole('table', {name: 'Activity'})
  await table.getByText(/Connected to 127\.0\.0\.1:2202/).first().waitFor()
  await table.getByText(/Trusted the host key SHA256:/).first().waitFor()
  await table.getByText(/Uploaded .* to \//).first().waitFor()
  await table.getByText(/Connection lost/).first().waitFor()
  await table.getByText(/HOST KEY CHANGED/).first().waitFor()
  await table.getByText('Unlock failed').first().waitFor()
  assert.ok(!(await table.textContent()).includes(MASTER), 'the master password is never logged')
  assert.ok(!(await table.textContent()).includes('demo-password'), 'no password is ever logged')
  await shot(page, 'logs')
  await page.getByRole('button', {name: 'Security', exact: true}).click()
  await table.getByText('Unlock failed').first().waitFor()
  // the list is reloaded by the backend: wait until the connection lines are gone
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('[aria-label=Activity] [role=row]')).some(r => /Connected to/.test(r.textContent)))
  await page.getByRole('button', {name: 'All', exact: true}).click()
  await page.getByLabel('Search logs').fill('lost')
  await table.getByText(/Connection lost/).first().waitFor()
  await page.getByLabel('Search logs').fill('')
  await goHome()

  step('Forgot the master password: reset the vault, keep the hosts')
  await nav('Lock vault').click()
  await page.getByRole('button', {name: 'Forgot password?'}).click()
  const forgot = page.getByRole('group', {name: 'Forgot master password'})
  await forgot.waitFor()
  assert.match(await forgot.textContent(), /cannot be recovered/)
  const erase = page.getByRole('button', {name: 'Erase vault and start over'})
  assert.equal(await erase.isDisabled(), true, 'cannot erase before typing RESET')
  await L('Type RESET to confirm').fill('RESET')
  await shot(page, 'forgot-password')
  await erase.click()
  await page.getByRole('form', {name: 'Create vault'}).waitFor()
  await page.getByRole('status').filter({hasText: 'old vault was erased'}).waitFor()
  await shot(page, 'vault-reset')
  const NEW_MASTER = 'a brand new master password'
  await L('Master password').fill(NEW_MASTER)
  await L('Confirm password').fill(NEW_MASTER)
  await page.getByRole('button', {name: 'Create vault'}).click()
  await nav('Hosts').click() // the app returns to the page it was on (Logs)
  await page.getByPlaceholder(/Find a host or ssh user@hostname/).waitFor()
  await page.getByRole('button', {name: 'Open group acme-prod'}).click()
  await page.locator('.host', {hasText: 'app-server'}).waitFor() // hosts survived the reset
  await nav('Keychain').click()
  await page.getByText(/No keys yet/).waitFor() // saved passwords and keys did not
  await page.getByRole('button', {name: 'New password'}).waitFor()

  step('Narrow window: nothing overflows and the search box stays usable')
  await page.setViewportSize({width: 960, height: 640})
  await nav('Hosts').click()
  await L('New host').click()
  await page.getByRole('dialog', {name: 'New host'}).waitFor()
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
    search: document.querySelector('.connect-bar')?.getBoundingClientRect().width ?? 0,
    panel: document.querySelector('.side-panel')?.getBoundingClientRect().width ?? 0,
  }))
  assert.ok(m.scroll <= m.inner, 'no horizontal scrollbar: ' + JSON.stringify(m))
  assert.ok(m.search >= 400, 'search bar not crushed by the panel: ' + JSON.stringify(m))
  await shot(page, 'narrow-window')
  await page.keyboard.press('Escape')
  await page.setViewportSize({width: 1360, height: 860})

  fs.rmSync(tmp, {recursive: true, force: true})
  assert.deepEqual(pageErrors, [], 'no uncaught page errors')
  console.log(`\n✔ walkthrough passed (${shots.length} screenshots)`)
} catch (e) {
  await page.screenshot({path: path.join(OUT, 'FAILURE.png')}).catch(() => {})
  console.error('\n✘ walkthrough failed:', e)
  process.exitCode = 1
} finally {
  await browser.close()
  procs.forEach(p => p.kill('SIGINT'))
}

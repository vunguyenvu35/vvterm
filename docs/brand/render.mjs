// Renders the SVG logos to PNG with Chromium (Playwright from ../../e2e).
// usage: node render.mjs '[{"svg":"x.svg","png":"x.png","w":512,"h":512,"pad":0,"bg":"#fff"}]'
import {chromium} from '../../e2e/node_modules/playwright/index.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const jobs = JSON.parse(process.argv[2])
const browser = await chromium.launch()
for (const {svg, png, w, h, pad = 0, bg, out} of jobs) {
  const src = fs.readFileSync(path.join(here, svg), 'utf8')
  const iw = w - 2 * pad
  const ih = h - 2 * pad
  const page = await browser.newPage({viewport: {width: w, height: h}, deviceScaleFactor: 1})
  const sized = src.replace('<svg ', `<svg style="position:absolute;left:${pad}px;top:${pad}px;width:${iw}px;height:${ih}px" `)
  await page.setContent(`<html><body style="margin:0;background:${bg ?? 'transparent'}">${sized}</body></html>`)
  await page.screenshot({path: path.resolve(here, out ?? png), omitBackground: !bg})
  await page.close()
}
await browser.close()

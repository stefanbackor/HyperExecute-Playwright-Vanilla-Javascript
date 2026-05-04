const { test } = require('../lambdatest-setup')
const { expect } = require('@playwright/test')
const { collectWebVitals } = require('../utils/web-vitals-helper')
const fs = require('fs')
const path = require('path')

const RUNS = 10
const URL = 'https://zeffo-git-demo-load-test-page-firework.vercel.app/loadtest-storyblock.html'

// Distribute tests per-test across `--shard=N/M`; default (serial) shards by file.
test.describe.configure({ mode: 'parallel' })

for (let i = 1; i <= RUNS; i++) {
  const idx = String(i).padStart(2, '0')

  test.describe(`loadtest storyblock run ${idx}`, () => {
    test(`web-vitals run ${idx}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)

      const t0 = Date.now()
      await page.goto(URL, { waitUntil: 'load', timeout: 60_000 })
      const result = await collectWebVitals(page)

      const out = {
        runIndex: i,
        testName: testInfo.title,
        startedAt: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        ...result,
      }

      const dir = path.resolve(__dirname, '..', 'artifacts', 'loadtest')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `run-${idx}-${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(out, null, 2))
      await testInfo.attach('web-vitals', { path: file, contentType: 'application/json' })

      console.log(`[loadtest] run ${idx} vitals:`, JSON.stringify(out.vitals))
      expect(result.vitals).toBeDefined()
    })
  })
}

const { test } = require("../lambdatest-setup");
const { expect } = require("@playwright/test");
const { collectWebVitals } = require("../utils/web-vitals-helper");
const {
  installFwVideoStartListener,
  waitForFwVideoStart,
} = require("../utils/fw-video-start-helper");
const fs = require("fs");
const path = require("path");

const RUNS = 10;
const TARGET_URL =
  process.env.URL ||
  "https://zeffo-git-demo-load-test-page-firework.vercel.app/loadtest-storyblock.html";

// Each HyperExecute job runs all RUNS page loads sequentially in a single worker.
test.describe.configure({ mode: "serial" });

for (let i = 1; i <= RUNS; i++) {
  const idx = String(i).padStart(2, "0");

  test.describe(`loadtest storyblock run ${idx}`, () => {
    test(`web-vitals run ${idx}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);

      await installFwVideoStartListener(page);

      const t0 = Date.now();
      await page.goto(TARGET_URL, { waitUntil: "load", timeout: 60_000 });
      const result = await collectWebVitals(page);
      const fwVideoStart = await waitForFwVideoStart(page, { timeout: 30_000 });

      const out = {
        runIndex: i,
        testName: testInfo.title,
        startedAt: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        fwVideoStart: fwVideoStart
          ? {
              msSinceNavigationStart: Math.round(fwVideoStart.performanceNow),
              firedAt: new Date(fwVideoStart.timestamp).toISOString(),
              detail: fwVideoStart.detail,
            }
          : {
              msSinceNavigationStart: null,
              firedAt: null,
              detail: null,
              timedOut: true,
            },
        ...result,
      };

      const dir = path.resolve(__dirname, "..", "artifacts", "loadtest");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `run-${idx}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      await testInfo.attach("web-vitals", {
        path: file,
        contentType: "application/json",
      });

      console.log(`[loadtest] run ${idx} vitals:`, JSON.stringify(out.vitals));
      console.log(
        `[loadtest] run ${idx} fw:video:start:`,
        JSON.stringify(out.fwVideoStart),
      );
      expect(result.vitals).toBeDefined();
    });
  });
}

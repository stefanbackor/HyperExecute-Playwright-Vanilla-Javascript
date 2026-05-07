const { test } = require("../lambdatest-setup");
const { expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { collectWebVitals } = require("../utils/web-vitals-helper");
const {
  installFwVideoStartListener,
  waitForFwVideoStart,
} = require("../utils/fw-video-start-helper");
const {
  waitForNavigationToSettle,
  waitForCompletePageLoad,
  activateFireworkConsole,
  clickTapToWatch,
  waitForVideoElements,
} = require("../utils/fw-page-helper");
const {
  installVideoStallInit,
  attachBufferingConsoleListener,
} = require("../utils/buffering-helper");
const { attachHlsNetworkRecorder } = require("../utils/hls-network-helper");
const { applyNoThrottle } = require("../utils/throttle-helper");

// Mirrors the customer's bajaj-firework-perf-complete-load.js script:
// 4 parallel "threads" (Playwright workers), each running a 1-min warmup +
// 2-min active loop on top of the customer's setup flow (goto/commit ->
// settle -> wait-for-load -> activate _fwn.console() -> reload -> tap to
// watch -> wait for <video>). Per-worker JSON artifact captures the same
// buffering metric the customer uses to evaluate player performance.

const WORKERS = process.env.CONCURRENCY || 4;
const WARMUP_MS = 60_000;
const ACTIVE_MS = 120_000;
const TARGET_URL =
  process.env.LOADTEST_URL ||
  "https://zeffo-git-demo-load-test-page-firework.vercel.app/loadtest-storyblock.html";

test.describe.configure({ mode: "parallel" });

for (let w = 1; w <= WORKERS; w++) {
  const idx = String(w).padStart(2, "0");

  test(`storyblock worker ${idx}`, async ({ page }, testInfo) => {
    test.setTimeout(360_000);

    // Pre-navigation init scripts and listeners
    await installFwVideoStartListener(page);
    await installVideoStallInit(page);
    const buffering = attachBufferingConsoleListener(page);
    const hls = attachHlsNetworkRecorder(page);
    await applyNoThrottle(page);

    const t0 = Date.now();

    console.log(`[loadtest] worker ${idx} target URL:`, TARGET_URL);

    // Initial navigation: waitUntil 'commit' so client-side redirects
    // (e.g. ?next=live) and slow HLS bootstrap don't block the load event.
    await page.goto(TARGET_URL, { waitUntil: "commit", timeout: 90_000 });
    await waitForNavigationToSettle(page);
    await waitForCompletePageLoad(page);

    const consoleResult = await activateFireworkConsole(page);
    console.log(
      `[loadtest] worker ${idx} _fwn.console() activation:`,
      JSON.stringify(consoleResult),
    );

    // Single reload after full setup, then redo the setup. The customer
    // observed that activating the console + measuring on a freshly-reloaded
    // page gives more representative results than the first cold load.
    await page.reload({ waitUntil: "commit", timeout: 90_000 });
    await waitForCompletePageLoad(page);
    await activateFireworkConsole(page);
    await waitForNavigationToSettle(page);

    // Best-effort click. Demo storyblock auto-plays so all five strategies
    // typically miss; bajaj ?next=live page needs strategy 1 or 2 to hit.
    await clickTapToWatch(page);

    const videoFound = await waitForVideoElements(page, 30_000);
    if (!videoFound) {
      await page.evaluate(() => window.scrollBy(0, 200)).catch(() => {});
      await page.waitForTimeout(1_000).catch(() => {});
      await clickTapToWatch(page);
      await waitForVideoElements(page, 15_000);
    }

    // Web Vitals + fw:video:start collected during the post-tap settle window
    const [wv, fwVideoStart] = await Promise.all([
      collectWebVitals(page),
      waitForFwVideoStart(page, { timeout: 30_000 }),
    ]);

    // Warmup
    await page.waitForTimeout(WARMUP_MS).catch(() => {});

    // Active loop: re-apply throttle + mouse move + 12 s wait, repeating
    // until the active budget is exhausted. Customer pattern verbatim.
    const end = Date.now() + ACTIVE_MS;
    let iter = 0;
    while (Date.now() < end) {
      try {
        await applyNoThrottle(page);
        await page.mouse.move(140 + iter, 180);
        await page.waitForTimeout(12_000);
      } catch (e) {
        if (
          /Target page|browser has been closed|Execution context/i.test(
            e.message,
          )
        )
          break;
      }
      iter++;
    }

    const events = buffering.events();
    const stallMsValues = events.map((e) => e.stallMs);
    const out = {
      runIndex: w,
      testName: testInfo.title,
      startedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      url: TARGET_URL,
      ...wv,
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
      buffering: {
        totalStalls: events.length,
        worstStallMs: stallMsValues.reduce((m, v) => Math.max(m, v), 0),
        avgStallMs: stallMsValues.length
          ? stallMsValues.reduce((a, b) => a + b, 0) / stallMsValues.length
          : 0,
        events,
      },
      hls: hls.records(),
    };

    const dir = path.resolve(__dirname, "..", "artifacts", "loadtest");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `worker-${idx}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    await testInfo.attach("loadtest-run", {
      path: file,
      contentType: "application/json",
    });

    console.log(`[loadtest] worker ${idx} vitals:`, JSON.stringify(out.vitals));
    console.log(
      `[loadtest] worker ${idx} buffering:`,
      JSON.stringify({
        totalStalls: out.buffering.totalStalls,
        worstStallMs: out.buffering.worstStallMs,
        avgStallMs: out.buffering.avgStallMs,
      }),
    );
    console.log(
      `[loadtest] worker ${idx} fw:video:start:`,
      JSON.stringify(out.fwVideoStart),
    );
    console.log(`[loadtest] worker ${idx} hls segments:`, out.hls.length);

    expect(out.vitals).toBeDefined();
  });
}

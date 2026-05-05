// Captures the time at which the `fw:video:start` CustomEvent first fires.
// Listener is installed via addInitScript so it is in place before any page
// scripts run on the next navigation. performance.now() at fire time is
// measured against the page's timeOrigin (navigationStart), which is the
// metric we want: "time from page load until the video reports start".

async function installFwVideoStartListener(page) {
  await page.addInitScript(() => {
    window.__fwVideoStart = null;
    const handler = (e) => {
      if (window.__fwVideoStart != null) return;
      window.__fwVideoStart = {
        performanceNow: performance.now(),
        timeOrigin: performance.timeOrigin,
        timestamp: Date.now(),
        detail: (() => {
          try {
            return JSON.parse(JSON.stringify(e.detail ?? null));
          } catch {
            return null;
          }
        })(),
      };
    };
    window.addEventListener("fw:video:start", handler, true);
  });
}

async function waitForFwVideoStart(page, { timeout = 30_000 } = {}) {
  try {
    await page.waitForFunction(() => window.__fwVideoStart !== null, null, {
      timeout,
    });
  } catch {
    return null;
  }
  return await page.evaluate(() => window.__fwVideoStart);
}

module.exports = { installFwVideoStartListener, waitForFwVideoStart };

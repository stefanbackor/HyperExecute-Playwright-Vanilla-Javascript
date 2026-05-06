// Page-orchestration helpers ported from the customer's load-test script
// (bajaj-firework-perf-complete-load.js). These mirror the customer's
// _waitForNavigationToSettle / _waitForCompletePageLoad / _activateFireworkConsole
// / _clickTapToWatch / _waitForVideoElements methods so we exercise the same
// player code path as their reproduction.

function isPageAlive(page) {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

// Poll page.url() until it stops changing for two consecutive checks. Handles
// pages that perform client-side redirects (e.g. ?next=live) where the initial
// goto target is not the URL we end up measuring against.
async function waitForNavigationToSettle(page, maxWaitMs = 20_000) {
  if (!isPageAlive(page)) return;
  const start = Date.now();
  let lastUrl = "";
  let stable = 0;
  while (Date.now() - start < maxWaitMs) {
    if (!isPageAlive(page)) return;
    try {
      const cur = page.url();
      if (cur === lastUrl) {
        stable++;
        if (stable >= 2) return;
      } else {
        lastUrl = cur;
        stable = 0;
      }
      await page.waitForTimeout(2_000).catch(() => {});
    } catch (e) {
      if (/Target page|browser has been closed/i.test(e.message)) return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

// Race a handful of selectors that signal the Firework SDK has rendered.
// Soft-fail: returns whether at least one matched, never throws.
async function waitForFireworkElements(page, timeout = 10_000) {
  try {
    await Promise.race([
      page.waitForSelector('[id*="firework"]', { timeout }),
      page.waitForSelector('[class*="firework"]', { timeout }),
      page.waitForSelector("video", { timeout }),
      page.waitForFunction(() => window._fwn !== undefined, null, { timeout }),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Customer's _waitForCompletePageLoad. Skips networkidle (HLS keeps the
// network busy indefinitely), then gives 5 s of settle time before letting
// callers proceed.
async function waitForCompletePageLoad(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("load");
  await page.waitForTimeout(5_000).catch(() => {});
  await waitForFireworkElements(page);
}

// Calls window._fwn.console() and sets _fwn.debug = true if available.
// Activation is required to make the player emit the
// "Playing to Buffering" / "Buffering to Playing" console lines that
// attachBufferingConsoleListener listens for.
async function activateFireworkConsole(page) {
  // if (page.url().includes("fwdev_debug")) {
  //   return { success: true, skipped: "fwdev_debug in url" };
  // }
  const result = await page.evaluate(() => {
    if (typeof window._fwn === "undefined") {
      return { success: false, error: "_fwn not found" };
    }
    if (typeof window._fwn.console !== "function") {
      return { success: false, error: "_fwn.console not a function" };
    }
    try {
      const res = window._fwn.console();
      if (window._fwn.debug !== undefined) window._fwn.debug = true;
      return { success: res === true, result: res };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  await page.waitForTimeout(2_000).catch(() => {});
  return result;
}

// Five-strategy click ladder. Each strategy uses a short timeout so demo
// pages without a teaser (e.g. loadtest-storyblock.html, where the embed
// starts auto-playing) don't burn the test budget. Returns true on first
// successful click.
async function clickTapToWatch(page) {
  // 1. Text match
  try {
    const tap = page.getByText("Tap to watch", { exact: false });
    if ((await tap.count()) > 0) {
      await tap.first().click({ timeout: 5_000 });
      await page.waitForTimeout(3_000).catch(() => {});
      return true;
    }
  } catch {}

  // 2. fw-storyblock
  try {
    const sb = page.locator("fw-storyblock");
    if ((await sb.count()) > 0) {
      await sb.first().click({ timeout: 5_000, force: true });
      await page.waitForTimeout(3_000).catch(() => {});
      return true;
    }
  } catch {}

  // 3. fw-embed-feed
  try {
    const ef = page.locator("fw-embed-feed");
    if ((await ef.count()) > 0) {
      await ef.first().click({ timeout: 5_000, force: true });
      await page.waitForTimeout(3_000).catch(() => {});
      return true;
    }
  } catch {}

  // 4. Coordinate click on the largest visible Firework element
  try {
    const target = await page.evaluate(() => {
      const sels = [
        "fw-storyblock",
        "fw-embed-feed",
        "fw-player",
        "fw-video-feed",
        '[class*="firework"]',
        '[id*="firework"]',
        '[class*="fw-"]',
        "[data-fw]",
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width > 50 && r.height > 50 && r.top < window.innerHeight) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }
      return null;
    });
    if (target) {
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(3_000).catch(() => {});
      return true;
    }
  } catch {}

  // 5. Viewport-center fallback
  try {
    await page.mouse.click(683, 400);
    await page.waitForTimeout(3_000).catch(() => {});
  } catch {}
  return false;
}

// Poll for <video> elements (light + shadow DOM) until one appears.
async function waitForVideoElements(page, maxWaitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isPageAlive(page)) return false;
    try {
      const count = await page.evaluate(() => {
        let n = document.querySelectorAll("video").length;
        for (const el of document.querySelectorAll("*")) {
          if (el.shadowRoot)
            n += el.shadowRoot.querySelectorAll("video").length;
        }
        return n;
      });
      if (count > 0) return true;
    } catch (e) {
      if (
        /Target page|browser has been closed|Execution context/i.test(e.message)
      )
        return false;
    }
    await page.waitForTimeout(2_000).catch(() => {});
  }
  return false;
}

module.exports = {
  isPageAlive,
  waitForNavigationToSettle,
  waitForFireworkElements,
  waitForCompletePageLoad,
  activateFireworkConsole,
  clickTapToWatch,
  waitForVideoElements,
};

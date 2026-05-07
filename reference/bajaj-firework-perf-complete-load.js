/* bajaj-firework-perf-complete-load.js
   ----------------------------------------------------------------
   – Waits for complete page load before Firework console activation
   – Ensures all DOM elements and scripts are loaded
   – Only then activates _fwn.console() and does single refresh
   – Logs only the two Firework player-state messages with local timestamps
   ---------------------------------------------------------------- */

const { chromium } = require("playwright");
const fs = require("fs/promises");

/* ── helper: local timestamp with timezone ── */
function localTS(d = new Date()) {
  const pad = (n, z = 2) => String(n).padStart(z, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offMin);
  const offHH = pad(Math.floor(absMin / 60));
  const offMM = pad(absMin % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)} ${sign}${offHH}:${offMM}`
  );
}

class BajajFireworkTester {
  TEST_URL = "https://cont-sites.bajajfinserv.in/live?next=live";
  RUN_MIN = 2;
  WARM_MIN = 1;
  MAX_STALL = 5_000;

  // PROF = [
  //   { name:'Fast 3G',    down:1.5, up:0.75, lat:562.5 },
  //   { name:'Slow 3G',    down:0.5, up:0.5,  lat:2000  },
  //   { name:'Regular 4G', down:4,   up:3,    lat:170   },
  //   { name:'No Throttle',down:0,   up:0,    lat:0     }
  // ];

  PROF = [
    { name: "No Throttle", down: 0, up: 0, lat: 0 },
    { name: "No Throttle", down: 0, up: 0, lat: 0 },
    { name: "No Throttle", down: 0, up: 0, lat: 0 },
    { name: "No Throttle", down: 0, up: 0, lat: 0 },
  ];

  constructor() {
    this.events = [];
    this.net = [];
    this.metrics = [];
    this.t0 = null;
    this.refreshed = false;
    this.pageAlive = true;
  }

  _isPageAlive() {
    try {
      return this.pageAlive && !this.page.isClosed();
    } catch {
      return false;
    }
  }

  /** Wait for URL to stop changing (handles ?next=live client-side redirects) */
  async _waitForNavigationToSettle(maxWaitMs = 20000) {
    if (!this._isPageAlive()) return;
    const start = Date.now();
    let lastUrl = "",
      stableCount = 0;
    console.log(`[${localTS()}] ⏳ Waiting for navigation to settle...`);
    while (Date.now() - start < maxWaitMs) {
      if (!this._isPageAlive()) return;
      try {
        const cur = this.page.url();
        if (cur === lastUrl) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(
              `[${localTS()}] ✅ Navigation settled: ${cur.substring(0, 120)}`,
            );
            return;
          }
        } else {
          console.log(
            `[${localTS()}] 🔄 URL changed: ${cur.substring(0, 120)}`,
          );
          lastUrl = cur;
          stableCount = 0;
        }
        await this.page.waitForTimeout(2000).catch(() => {});
      } catch (e) {
        if (/Target page|browser has been closed/i.test(e.message)) {
          this.pageAlive = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.log(
      `[${localTS()}] ⚠️ Navigation did not settle within ${maxWaitMs / 1000}s — proceeding`,
    );
  }

  async launch() {
    console.log(`[${localTS()}] 🚀 Launching Chrome...`);
    this.browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    await this._newCtx();
  }

  async _newCtx() {
    this.ctx = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    this.page = await this.ctx.newPage();
    this._wire();
  }

  _wire() {
    /* console listener – ONLY the two Firework state lines */
    this.page.on("console", (m) => {
      const txt = m.text();
      // console.log({txt});
      if (/Playing to Buffering/i.test(txt)) {
        this.t0 = Date.now();
        console.log(`[${localTS()}] ⏸️ BUFFERING START`);
      }
      if (/Buffering to Playing/i.test(txt)) {
        const ms = this.t0 ? Date.now() - this.t0 : 0;
        console.log(
          `[${localTS()}] ▶️ BUFFERING END – ${(ms / 1000).toFixed(2)} s`,
        );
        this.events.push({ ts: localTS(), stallMs: ms });
        this.t0 = null;
      }
    });

    /* basic HLS timing */
    this.page.on("request", (r) => {
      if (/\.(ts|m3u8)(\?|$)/.test(r.url()))
        this.net.push({ url: r.url(), t0: Date.now() });
    });
    this.page.on("response", (r) => {
      const rec = this.net.find((x) => x.url === r.url());
      if (rec) {
        rec.t1 = Date.now();
        rec.ms = rec.t1 - rec.t0;
        rec.st = r.status();
      }
    });
  }

  /* ── COMPLETE PAGE LOAD WAITING ── */
  async _waitForCompletePageLoad() {
    console.log(`[${localTS()}] ⏳ Waiting for complete page load...`);

    // 1. Wait for network idle (no network requests for 500ms)
    // await this.page.waitForLoadState('networkidle');
    // console.log(`[${localTS()}] ✅ Network idle achieved`);

    // 2. Wait for DOM content to be loaded
    await this.page.waitForLoadState("domcontentloaded");
    console.log(`[${localTS()}] ✅ DOM content loaded`);

    // 3. Wait for all resources (images, stylesheets, scripts)
    await this.page.waitForLoadState("load");
    console.log(`[${localTS()}] ✅ All resources loaded`);

    // 4. Additional wait for dynamic content and scripts to initialize
    await this.page.waitForTimeout(5000);
    console.log(`[${localTS()}] ✅ Additional 5s wait completed`);

    // 5. Check if Firework elements are present
    await this._waitForFireworkElements();
  }

  /**
   * Click the "Tap to watch" overlay on the Firework teaser widget.
   * The ?next=live page renders in teaser mode; <video> elements only appear after click.
   */
  async _clickTapToWatch() {
    console.log(`[${localTS()}] 👆 Looking for "Tap to watch" element...`);

    // Strategy 1: Click by text "Tap to watch"
    try {
      const tapBtn = this.page.getByText("Tap to watch", { exact: false });
      if ((await tapBtn.count()) > 0) {
        console.log(`[${localTS()}] ✓ Found "Tap to watch" text, clicking...`);
        await tapBtn.first().click({ timeout: 5000 });
        console.log(`[${localTS()}] ✅ Clicked "Tap to watch"`);
        await this.page.waitForTimeout(3000).catch(() => {});
        return true;
      }
    } catch (e) {
      console.log(
        `[${localTS()}] ℹ️ "Tap to watch" click attempt: ${e.message.substring(0, 100)}`,
      );
    }

    // Strategy 2: Click fw-storyblock
    try {
      const sb = this.page.locator("fw-storyblock");
      if ((await sb.count()) > 0) {
        console.log(`[${localTS()}] ✓ Found fw-storyblock, clicking...`);
        await sb.first().click({ timeout: 5000, force: true });
        console.log(`[${localTS()}] ✅ Clicked fw-storyblock`);
        await this.page.waitForTimeout(3000).catch(() => {});
        return true;
      }
    } catch (e) {
      console.log(
        `[${localTS()}] ℹ️ fw-storyblock click attempt: ${e.message.substring(0, 100)}`,
      );
    }

    // Strategy 3: Click fw-embed-feed
    try {
      const ef = this.page.locator("fw-embed-feed");
      if ((await ef.count()) > 0) {
        console.log(`[${localTS()}] ✓ Found fw-embed-feed, clicking...`);
        await ef.first().click({ timeout: 5000, force: true });
        console.log(`[${localTS()}] ✅ Clicked fw-embed-feed`);
        await this.page.waitForTimeout(3000).catch(() => {});
        return true;
      }
    } catch (e) {
      console.log(
        `[${localTS()}] ℹ️ fw-embed-feed click attempt: ${e.message.substring(0, 100)}`,
      );
    }

    // Strategy 4: Find any visible Firework element by coordinates
    try {
      const target = await this.page.evaluate(() => {
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
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                sel,
                w: Math.round(r.width),
                h: Math.round(r.height),
              };
            }
          }
        }
        return null;
      });
      if (target) {
        console.log(
          `[${localTS()}] ✓ Found ${target.sel} (${target.w}x${target.h}), clicking at (${Math.round(target.x)}, ${Math.round(target.y)})...`,
        );
        await this.page.mouse.click(target.x, target.y);
        console.log(`[${localTS()}] ✅ Mouse-clicked Firework widget`);
        await this.page.waitForTimeout(3000).catch(() => {});
        return true;
      }
    } catch (e) {
      console.log(
        `[${localTS()}] ℹ️ Firework coordinate click attempt: ${e.message.substring(0, 100)}`,
      );
    }

    // Strategy 5: Fallback — click center of viewport
    console.log(
      `[${localTS()}] ⚠️ No Firework teaser found, clicking viewport center as fallback`,
    );
    try {
      await this.page.mouse.click(683, 400);
      await this.page.waitForTimeout(3000).catch(() => {});
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /**
   * Wait for <video> elements to appear in DOM (including shadow DOM).
   * After clicking "Tap to watch", the Firework SDK creates <video> elements.
   */
  async _waitForVideoElements(maxWaitMs = 30000) {
    console.log(`[${localTS()}] ⏳ Waiting for <video> elements to appear...`);
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (!this._isPageAlive()) return false;
      try {
        const info = await this.page.evaluate(() => {
          let count = document.querySelectorAll("video").length;
          for (const el of document.querySelectorAll("*")) {
            if (el.shadowRoot)
              count += el.shadowRoot.querySelectorAll("video").length;
          }
          return { count };
        });
        if (info.count > 0) {
          console.log(
            `[${localTS()}] ✅ Found ${info.count} <video> element(s) after ${((Date.now() - start) / 1000).toFixed(1)}s`,
          );
          return true;
        }
      } catch (e) {
        if (
          /Target page|browser has been closed|Execution context/i.test(
            e.message,
          )
        )
          return false;
      }
      await this.page.waitForTimeout(2000).catch(() => {});
    }
    console.log(
      `[${localTS()}] ⚠️ No <video> elements found after ${(maxWaitMs / 1000).toFixed(0)}s`,
    );
    return false;
  }

  async _waitForFireworkElements() {
    console.log(`[${localTS()}] 🔍 Waiting for Firework elements...`);
    try {
      // Wait for any Firework-related elements
      await Promise.race([
        this.page.waitForSelector('[id*="firework"]', { timeout: 10000 }),
        this.page.waitForSelector('[class*="firework"]', { timeout: 10000 }),
        this.page.waitForSelector("video", { timeout: 10000 }),
        this.page.waitForFunction(() => window._fwn !== undefined, {
          timeout: 10000,
        }),
      ]);
      console.log(`[${localTS()}] ✅ Firework elements detected`);
    } catch (error) {
      console.log(
        `[${localTS()}] ⚠️ Firework elements not found, proceeding anyway...`,
      );
    }
    // Additional wait for Firework SDK to fully initialize
    await this.page.waitForTimeout(2000);
  }

  async _activateFireworkConsole() {
    console.log(`[${localTS()}] 🔥 Activating Firework console...`);

    const result = await this.page.evaluate(() => {
      // Check if _fwn is available
      if (typeof window._fwn === "undefined") {
        return { success: false, error: "_fwn not found" };
      }

      // Check if console method exists
      if (typeof window._fwn.console !== "function") {
        return { success: false, error: "_fwn.console not a function" };
      }

      try {
        // Activate the console and return its value
        const res = window._fwn.console();
        // Optionally, set debug flag if available
        if (window._fwn.debug !== undefined) window._fwn.debug = true;
        console.log("✅ _fwn.console() activated successfully, returned:", res);
        return { success: res === true, result: res };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    if (result.success) {
      console.log(
        `[${localTS()}] ✅ Firework console activated successfully, returned:`,
        result.result,
      );
    } else {
      console.log(
        `[${localTS()}] ⚠️ Firework console activation failed: ${result.error}`,
      );
    }

    // Wait a bit more for console to be fully active
    await this.page.waitForTimeout(2000);
    return result.success;
  }

  async _throttle(i) {
    const p = this.PROF[i];
    await this.page
      .context()
      .newCDPSession(this.page)
      .then((s) =>
        s.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: p.lat,
          downloadThroughput: p.down ? (p.down * 1024 * 1024) / 8 : 0,
          uploadThroughput: p.up ? (p.up * 1024 * 1024) / 8 : 0,
        }),
      );
    // console.log(`[${localTS()}] 🌐 ${p.name}`);
  }

  async _injectVideoTimers() {
    await this.page.addInitScript(() => {
      function wire(v) {
        if (v.__wd) return;
        v.__wd = true;
        v.__st = [];
        let s = null,
          st = () => !s && (s = performance.now()),
          en = () => {
            if (s) {
              v.__st.push({ s, end: performance.now() });
              s = null;
            }
          };
        v.addEventListener("waiting", st);
        v.addEventListener("stalled", st);
        ["playing", "canplay", "canplaythrough"].forEach((e) =>
          v.addEventListener(e, en),
        );
        window._fwn?.player?.on?.("statechange", (x) => {
          if (x === "buffering") st();
          if (x === "playing") en();
        });
      }
      document.querySelectorAll("video").forEach(wire);
      new MutationObserver((m) =>
        m.forEach((r) =>
          r.addedNodes.forEach((n) => {
            if (n.tagName === "VIDEO") wire(n);
            n.querySelectorAll?.("video").forEach(wire);
          }),
        ),
      ).observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async _refreshOnce() {
    if (this.refreshed) return;
    this.refreshed = true;

    console.log(
      `[${localTS()}] 🔄 Reloading the same page after complete setup...`,
    );
    await this.page.reload({ waitUntil: "commit", timeout: 90000 });
    await this._waitForCompletePageLoad();

    // Activate console again after refresh
    await this._activateFireworkConsole();
    await this._injectVideoTimers();
    console.log(`[${localTS()}] ✅ Reload completed with full setup`);
  }

  async run() {
    this.start = Date.now();
    console.log(`[${localTS()}] 🎬 Starting Bajaj Firework Performance Test`);

    // Initial setup
    await this._injectVideoTimers();
    await this._throttle(3);

    // Load page with initial wait (longer timeout for ?next=live which takes 10-15s)
    console.log(`[${localTS()}] 🌐 Loading page: ${this.TEST_URL}`);
    await this.page.goto(this.TEST_URL, {
      waitUntil: "commit",
      timeout: 90000,
    });

    // Listen for page close (from ?next=live redirect)
    this.page.on("close", () => {
      this.pageAlive = false;
      console.log(`[${localTS()}] ⚠️ Page was closed by navigation`);
    });

    // Wait for any ?next=live client-side navigation to settle
    await this._waitForNavigationToSettle();
    if (!this._isPageAlive()) {
      console.log(`[${localTS()}] ❌ Page closed after navigation — aborting`);
      return;
    }

    // Wait for COMPLETE page load before proceeding
    await this._waitForCompletePageLoad();

    // NOW activate Firework console
    if (!this._isPageAlive()) return;
    await this._activateFireworkConsole();

    // NOW do the single refresh with complete setup
    if (!this._isPageAlive()) return;
    await this._refreshOnce();

    // After reload, wait for ?next=live navigation to settle again
    await this._waitForNavigationToSettle();
    if (!this._isPageAlive()) return;

    // Click "Tap to watch" to trigger video player (required for ?next=live pages)
    await this._clickTapToWatch();
    if (!this._isPageAlive()) return;

    // Wait for <video> elements to appear after clicking the teaser
    const videoFound = await this._waitForVideoElements(30000);
    if (!videoFound) {
      console.log(
        `[${localTS()}] ⚠️ No video after first click — retrying with scroll + click...`,
      );
      if (this._isPageAlive()) {
        await this.page.evaluate(() => window.scrollBy(0, 200)).catch(() => {});
        await this.page.waitForTimeout(1000).catch(() => {});
        await this._clickTapToWatch();
        await this._waitForVideoElements(15000);
      }
    }

    // Start warmup period
    console.log(
      `[${localTS()}] ⏳ Starting ${this.WARM_MIN}-minute warmup period...`,
    );
    await this.page.waitForTimeout(this.WARM_MIN * 60 * 1000).catch(() => {});
    console.log(
      `[${localTS()}] ✅ Warmup completed, starting active test phase`,
    );

    // Active test loop — with page-alive guard on every iteration
    const end = this.start + this.RUN_MIN * 60 * 1000;
    let i = 0;
    while (Date.now() < end) {
      if (!this._isPageAlive()) {
        console.log(
          `[${localTS()}] ⚠️ Page closed during test loop — ending early`,
        );
        break;
      }
      try {
        await this._throttle(i % this.PROF.length);
        await this.page.mouse.move(140 + i, 180);
        await this.page.waitForTimeout(12000);
      } catch (e) {
        if (
          /Target page|browser has been closed|Execution context/i.test(
            e.message,
          )
        ) {
          console.log(
            `[${localTS()}] ⚠️ Page navigated/closed during test loop: ${e.message}`,
          );
          this.pageAlive = false;
          break;
        }
      }
      i++;
    }
  }

  async summary() {
    const worst = this.events.reduce(
      (m, e) => (e.stallMs > m ? e.stallMs : m),
      0,
    );
    const totalStalls = this.events.length;
    const avgStall =
      totalStalls > 0
        ? this.events.reduce((sum, e) => sum + e.stallMs, 0) / totalStalls
        : 0;

    console.log(
      `\n[${localTS()}] 📊 =============== FINAL SUMMARY ===============`,
    );
    console.log(
      `[${localTS()}] ⏱️ Total runtime: ${((Date.now() - this.start) / 60000).toFixed(1)} minutes`,
    );
    console.log(`[${localTS()}] 🔄 Total buffering events: ${totalStalls}`);
    console.log(
      `[${localTS()}] ⚠️ Worst stall: ${(worst / 1000).toFixed(2)} seconds`,
    );
    console.log(
      `[${localTS()}] 📊 Average stall: ${(avgStall / 1000).toFixed(2)} seconds`,
    );
    console.log(`[${localTS()}] 🌐 Network requests: ${this.net.length}`);

    const filename = `fw-perf-${Date.now()}.json`;
    await fs.writeFile(
      filename,
      JSON.stringify(
        {
          started: localTS(new Date(this.start)),
          completed: localTS(),
          totalStalls,
          worstStallMs: worst,
          avgStallMs: avgStall,
          events: this.events,
          network: this.net,
        },
        null,
        2,
      ),
    );
    console.log(`[${localTS()}] 💾 Detailed report saved: ${filename}`);
    console.log(
      `[${localTS()}] 📊 =============== END SUMMARY ===============\n`,
    );
  }

  async close() {
    console.log(`[${localTS()}] 🧹 Cleaning up browser resources...`);
    await this.browser?.close();
  }
}

/* ── bootstrap: run 4 parallel testers ── */
(async () => {
  const THREADS = 4;
  const testers = Array.from(
    { length: THREADS },
    (_, i) => new BajajFireworkTester(),
  );
  const results = [];

  await Promise.all(
    testers.map(async (t, idx) => {
      try {
        console.log(`\n[Thread ${idx + 1}] Starting...`);
        await t.launch();
        await t.run();
        // Collect summary data for aggregation
        results.push({
          thread: idx + 1,
          started: localTS(new Date(t.start)),
          completed: localTS(),
          totalStalls: t.events.length,
          worstStallMs: t.events.reduce(
            (m, e) => (e.stallMs > m ? e.stallMs : m),
            0,
          ),
          avgStallMs:
            t.events.length > 0
              ? t.events.reduce((sum, e) => sum + e.stallMs, 0) /
                t.events.length
              : 0,
          events: t.events,
          network: t.net,
        });
      } catch (e) {
        console.error(`[Thread ${idx + 1}] ❌ Fatal error:`, e.message);
        console.error(e.stack);
      } finally {
        await t.close();
        console.log(`[Thread ${idx + 1}] Closed.`);
      }
    }),
  );

  // Write a single combined JSON report
  const filename = `fw-perf-combined-${Date.now()}.json`;
  await fs.writeFile(
    filename,
    JSON.stringify(
      {
        threads: THREADS,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n[${localTS()}] 💾 Combined report saved: ${filename}`);
})();

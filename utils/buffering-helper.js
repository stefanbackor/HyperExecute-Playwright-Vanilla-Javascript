// Captures Firework player buffering events the same way the customer's
// reproduction script does:
//   1. installVideoStallInit wires <video> elements (incl. ones added later)
//      with waiting/stalled -> playing/canplay listeners and stores stall
//      windows on each element.
//   2. attachBufferingConsoleListener listens for the
//      "Playing to Buffering" / "Buffering to Playing" console lines that
//      _fwn.console() activation emits, and computes stallMs per pair.
//
// The two pieces are independent — (1) gives raw <video> waiting events,
// (2) gives the SDK-level state-machine view that matches what the customer
// is reporting against. Both are persisted in the per-run JSON.

async function installVideoStallInit(page) {
  await page.addInitScript(() => {
    function wire(v) {
      if (v.__wd) return;
      v.__wd = true;
      v.__st = [];
      let s = null;
      const start = () => {
        if (!s) s = performance.now();
      };
      const end = () => {
        if (s) {
          v.__st.push({ s, end: performance.now() });
          s = null;
        }
      };
      v.addEventListener("waiting", start);
      v.addEventListener("stalled", start);
      ["playing", "canplay", "canplaythrough"].forEach((e) =>
        v.addEventListener(e, end),
      );
      try {
        window._fwn?.player?.on?.("statechange", (x) => {
          if (x === "buffering") start();
          if (x === "playing") end();
        });
      } catch {}
    }
    document.querySelectorAll("video").forEach(wire);
    new MutationObserver((records) =>
      records.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (n.tagName === "VIDEO") wire(n);
          n.querySelectorAll?.("video").forEach(wire);
        }),
      ),
    ).observe(document.documentElement, { childList: true, subtree: true });
  });
}

function attachBufferingConsoleListener(page) {
  const events = [];
  let t0 = null;
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Playing to Buffering/i.test(text)) {
      t0 = Date.now();
    } else if (/Buffering to Playing/i.test(text)) {
      const stallMs = t0 ? Date.now() - t0 : 0;
      events.push({ ts: new Date().toISOString(), stallMs });
      t0 = null;
    }
  });
  return {
    events: () => events.slice(),
  };
}

module.exports = { installVideoStallInit, attachBufferingConsoleListener };

// CDP-based network throttling. Mirrors the customer's PROF array shape so a
// future flip to Fast 3G / Slow 3G / Regular 4G is a one-line change.

const PROFILES = {
  "No Throttle": { down: 0, up: 0, lat: 0 },
  "Fast 3G": { down: 1.5, up: 0.75, lat: 562.5 },
  "Slow 3G": { down: 0.5, up: 0.5, lat: 2000 },
  "Regular 4G": { down: 4, up: 3, lat: 170 },
};

async function applyThrottle(page, profileName = "No Throttle") {
  const p = PROFILES[profileName] || PROFILES["No Throttle"];
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: p.lat,
      downloadThroughput: p.down ? (p.down * 1024 * 1024) / 8 : 0,
      uploadThroughput: p.up ? (p.up * 1024 * 1024) / 8 : 0,
    });
  } catch (e) {
    // CDP may be unavailable on some cloud configs — don't crash the test.
    console.warn(`[throttle] ${profileName} failed: ${e.message}`);
  }
}

const applyNoThrottle = (page) => applyThrottle(page, "No Throttle");

module.exports = { applyThrottle, applyNoThrottle, PROFILES };

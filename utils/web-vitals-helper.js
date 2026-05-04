// INP requires a real user interaction to fire. The synthetic mouse.click is
// best-effort — on some pages it won't qualify and INP will be absent.
async function collectWebVitals(page, { settleMs = 5000 } = {}) {
  await page.addScriptTag({ url: 'https://unpkg.com/web-vitals@4/dist/web-vitals.iife.js' })

  await page.evaluate(() => {
    window.__vitals = {}
    const store = (m) => {
      window.__vitals[m.name] = { value: m.value, rating: m.rating, id: m.id }
    }
    webVitals.onLCP(store, { reportAllChanges: true })
    webVitals.onCLS(store, { reportAllChanges: true })
    webVitals.onINP(store, { reportAllChanges: true })
    webVitals.onFCP(store)
    webVitals.onTTFB(store)
  })

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(settleMs)

  await page.mouse.move(200, 200)
  await page.mouse.click(200, 200, { delay: 60 }).catch(() => {})
  await page.waitForTimeout(500)

  // Flush LCP/CLS finalization without unloading the page.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)

  return await page.evaluate(() => ({
    vitals: window.__vitals,
    nav: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null,
    userAgent: navigator.userAgent,
    url: location.href,
  }))
}

module.exports = { collectWebVitals }

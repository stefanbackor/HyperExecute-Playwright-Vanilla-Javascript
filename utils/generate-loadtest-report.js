#!/usr/bin/env node
// Aggregates artifacts/loadtest/**/*.json (one file per run, written by
// tests/loadtest_storyblock.spec.js) into a self-contained HTML report.
//
// Usage:
//   node utils/generate-loadtest-report.js [--in <dir>] [--out <file>]
// Defaults:
//   --in  artifacts/loadtest
//   --out artifacts/loadtest-report.html

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const ROOT = path.resolve(__dirname, '..')
const IN_DIR = path.resolve(ROOT, arg('--in', 'artifacts/loadtest'))
const OUT_FILE = path.resolve(ROOT, arg('--out', 'artifacts/loadtest-report.html'))

const VITAL_THRESHOLDS = {
  LCP:  { good: 2500, poor: 4000, unit: 'ms', lowerIsBetter: true },
  FCP:  { good: 1800, poor: 3000, unit: 'ms', lowerIsBetter: true },
  TTFB: { good: 800,  poor: 1800, unit: 'ms', lowerIsBetter: true },
  CLS:  { good: 0.1,  poor: 0.25, unit: '',   lowerIsBetter: true },
  INP:  { good: 200,  poor: 500,  unit: 'ms', lowerIsBetter: true },
}

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (st.isFile() && p.endsWith('.json')) out.push(p)
  }
  return out
}

function loadRuns(dir) {
  const files = walk(dir).sort()
  const runs = []
  for (const file of files) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (json && json.vitals) runs.push({ ...json, __file: path.relative(ROOT, file) })
    } catch (e) {
      console.warn(`[report] skipping ${file}: ${e.message}`)
    }
  }
  return runs
}

function pct(arr, p) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}
function median(arr) { return pct(arr, 50) }
function avg(arr)    { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }
function min(arr)    { return arr.length ? Math.min(...arr) : null }
function max(arr)    { return arr.length ? Math.max(...arr) : null }

function rate(metric, value) {
  const t = VITAL_THRESHOLDS[metric]
  if (!t || value == null) return null
  if (value <= t.good) return 'good'
  if (value <= t.poor) return 'needs-improvement'
  return 'poor'
}

function fmt(value, metric) {
  if (value == null) return '—'
  if (metric === 'CLS') return value.toFixed(3)
  return Math.round(value).toString()
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function summarize(runs) {
  const metrics = Object.keys(VITAL_THRESHOLDS)
  const summary = {}
  for (const m of metrics) {
    const values = runs
      .map(r => r.vitals?.[m]?.value)
      .filter(v => typeof v === 'number' && !Number.isNaN(v))
    summary[m] = {
      count: values.length,
      min: min(values),
      avg: avg(values),
      median: median(values),
      p75: pct(values, 75),
      p95: pct(values, 95),
      max: max(values),
    }
  }
  const fwVideo = runs
    .map(r => r.fwVideoStart?.msSinceNavigationStart)
    .filter(v => typeof v === 'number')
  summary.fwVideoStart = fwVideo.length
    ? {
        count: fwVideo.length,
        min: min(fwVideo), avg: avg(fwVideo), median: median(fwVideo),
        p75: pct(fwVideo, 75), p95: pct(fwVideo, 95), max: max(fwVideo),
      }
    : { count: 0 }

  const durations = runs.map(r => r.durationMs).filter(v => typeof v === 'number')
  summary.durationMs = {
    count: durations.length,
    min: min(durations), avg: avg(durations), median: median(durations),
    p75: pct(durations, 75), p95: pct(durations, 95), max: max(durations),
  }
  return summary
}

function bar(value, scaleMax, color) {
  if (value == null || !scaleMax) return ''
  const pctW = Math.max(1, Math.min(100, Math.round((value / scaleMax) * 100)))
  return `<div class="bar"><span class="bar-fill" style="width:${pctW}%;background:${color}"></span></div>`
}

function colorForRating(r) {
  return r === 'good' ? '#16a34a'
    : r === 'needs-improvement' ? '#d97706'
    : r === 'poor' ? '#dc2626'
    : '#64748b'
}

function buildHtml(runs, summary) {
  const metrics = Object.keys(VITAL_THRESHOLDS)
  const generatedAt = new Date().toISOString()
  const urls = [...new Set(runs.map(r => r.url).filter(Boolean))]
  const userAgents = [...new Set(runs.map(r => r.userAgent).filter(Boolean))]

  const summaryRows = metrics.map(m => {
    const s = summary[m]
    const t = VITAL_THRESHOLDS[m]
    const r75 = rate(m, s.p75)
    return `
      <tr>
        <td><strong>${m}</strong> <span class="muted">(${t.unit || 'score'})</span></td>
        <td>${s.count}</td>
        <td>${fmt(s.min, m)}</td>
        <td>${fmt(s.avg, m)}</td>
        <td>${fmt(s.median, m)}</td>
        <td>${fmt(s.p75, m)} <span class="badge ${r75}">${r75 || '—'}</span></td>
        <td>${fmt(s.p95, m)}</td>
        <td>${fmt(s.max, m)}</td>
        <td class="muted">good ≤ ${t.good}${t.unit} · poor &gt; ${t.poor}${t.unit}</td>
      </tr>`
  }).join('\n')

  const fwS = summary.fwVideoStart
  const fwSummary = fwS.count
    ? `<tr>
        <td><strong>fw:video:start</strong> <span class="muted">(ms since nav)</span></td>
        <td>${fwS.count}</td>
        <td>${fmt(fwS.min)}</td>
        <td>${fmt(fwS.avg)}</td>
        <td>${fmt(fwS.median)}</td>
        <td>${fmt(fwS.p75)}</td>
        <td>${fmt(fwS.p95)}</td>
        <td>${fmt(fwS.max)}</td>
        <td class="muted">custom event</td>
      </tr>`
    : `<tr><td><strong>fw:video:start</strong></td><td colspan="8" class="muted">no data</td></tr>`

  const dS = summary.durationMs
  const durationSummary = `<tr>
        <td><strong>test duration</strong> <span class="muted">(ms)</span></td>
        <td>${dS.count}</td>
        <td>${fmt(dS.min)}</td>
        <td>${fmt(dS.avg)}</td>
        <td>${fmt(dS.median)}</td>
        <td>${fmt(dS.p75)}</td>
        <td>${fmt(dS.p95)}</td>
        <td>${fmt(dS.max)}</td>
        <td class="muted">wall clock per run</td>
      </tr>`

  // Per-metric bar charts across runs
  const charts = metrics.map(m => {
    const values = runs.map(r => r.vitals?.[m]?.value ?? null)
    const scaleMax = max(values.filter(v => v != null)) || 1
    const t = VITAL_THRESHOLDS[m]
    const rows = runs.map((r, i) => {
      const v = values[i]
      const rating = r.vitals?.[m]?.rating || rate(m, v)
      return `
        <div class="chart-row">
          <span class="chart-label">#${String(r.runIndex ?? i + 1).padStart(2, '0')}</span>
          ${bar(v, scaleMax, colorForRating(rating))}
          <span class="chart-value">${fmt(v, m)}${t.unit}</span>
        </div>`
    }).join('')
    return `
      <section class="chart-card">
        <h3>${m} <span class="muted">— good ≤ ${t.good}${t.unit}</span></h3>
        ${rows || '<div class="muted">no data</div>'}
      </section>`
  }).join('\n')

  // Per-run table
  const runRows = runs.map((r, i) => {
    const v = r.vitals || {}
    const cells = metrics.map(m => {
      const val = v[m]?.value
      const rt = v[m]?.rating || rate(m, val)
      return `<td><span class="badge ${rt}">${fmt(val, m)}</span></td>`
    }).join('')
    const fw = r.fwVideoStart?.msSinceNavigationStart
    const navDur = r.nav?.duration
    return `
      <tr>
        <td>#${String(r.runIndex ?? i + 1).padStart(2, '0')}</td>
        <td class="muted nowrap">${escapeHtml(r.startedAt || '')}</td>
        <td>${fmt(r.durationMs)}</td>
        <td>${fmt(navDur)}</td>
        <td>${fw == null ? '<span class="muted">—</span>' : fmt(fw)}</td>
        ${cells}
      </tr>`
  }).join('\n')

  const metricHeaders = metrics.map(m => `<th>${m}</th>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Load Test Performance Report</title>
<style>
  :root {
    --bg: #0b1020;
    --panel: #11162a;
    --border: #1f2746;
    --text: #e6e9f5;
    --muted: #8892b0;
    --accent: #6366f1;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { padding: 32px 40px 16px; border-bottom: 1px solid var(--border); }
  h1 { margin: 0 0 6px; font-size: 24px; }
  h2 { margin: 32px 0 12px; font-size: 18px; }
  h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .muted { color: var(--muted); }
  .nowrap { white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 16px 32px; margin-top: 12px; font-size: 13px; }
  .meta div span { color: var(--muted); margin-right: 6px; }
  main { padding: 24px 40px 64px; max-width: 1400px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; }
  th { background: #161c36; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #161c36; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 12px; font-weight: 600; }
  .badge.good { background: rgba(22,163,74,0.15); color: #4ade80; }
  .badge.needs-improvement { background: rgba(217,119,6,0.15); color: #fbbf24; }
  .badge.poor { background: rgba(220,38,38,0.15); color: #f87171; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    margin-top: 12px; }
  .chart-card { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; }
  .chart-row { display: grid; grid-template-columns: 40px 1fr 80px;
    align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
  .chart-label { color: var(--muted); font-variant-numeric: tabular-nums; }
  .chart-value { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { background: #1a2143; height: 14px; border-radius: 3px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; transition: width 0.3s; }
  .stat-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    margin: 16px 0; }
  .stat { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 16px; }
  .stat .label { font-size: 11px; text-transform: uppercase; color: var(--muted);
    letter-spacing: 0.5px; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 4px;
    font-variant-numeric: tabular-nums; }
  details { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 16px; margin-top: 8px; }
  details summary { cursor: pointer; font-weight: 600; color: var(--muted); }
  pre { overflow-x: auto; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Load Test Performance Report</h1>
  <div class="meta">
    <div><span>generated</span>${escapeHtml(generatedAt)}</div>
    <div><span>runs</span>${runs.length}</div>
    <div><span>source</span>${escapeHtml(path.relative(ROOT, IN_DIR))}</div>
  </div>
  ${urls.length ? `<div class="meta"><div><span>url</span>${urls.map(escapeHtml).join('<br>')}</div></div>` : ''}
</header>
<main>
  <div class="stat-grid">
    <div class="stat"><div class="label">Total runs</div><div class="value">${runs.length}</div></div>
    <div class="stat"><div class="label">LCP p75</div><div class="value">${fmt(summary.LCP.p75, 'LCP')} <span class="muted" style="font-size:14px">ms</span></div></div>
    <div class="stat"><div class="label">FCP p75</div><div class="value">${fmt(summary.FCP.p75, 'FCP')} <span class="muted" style="font-size:14px">ms</span></div></div>
    <div class="stat"><div class="label">TTFB p75</div><div class="value">${fmt(summary.TTFB.p75, 'TTFB')} <span class="muted" style="font-size:14px">ms</span></div></div>
    <div class="stat"><div class="label">CLS p75</div><div class="value">${fmt(summary.CLS.p75, 'CLS')}</div></div>
    <div class="stat"><div class="label">INP p75</div><div class="value">${fmt(summary.INP.p75, 'INP')} <span class="muted" style="font-size:14px">ms</span></div></div>
    ${fwS.count ? `<div class="stat"><div class="label">fw:video:start p75</div><div class="value">${fmt(fwS.p75)} <span class="muted" style="font-size:14px">ms</span></div></div>` : ''}
  </div>

  <h2>Summary statistics</h2>
  <table>
    <thead>
      <tr><th>Metric</th><th>n</th><th>min</th><th>avg</th><th>median</th><th>p75</th><th>p95</th><th>max</th><th>thresholds</th></tr>
    </thead>
    <tbody>
      ${summaryRows}
      ${fwSummary}
      ${durationSummary}
    </tbody>
  </table>

  <h2>Per-metric across runs</h2>
  <div class="grid">
    ${charts}
  </div>

  <h2>Per-run detail</h2>
  <table>
    <thead>
      <tr>
        <th>Run</th><th>Started</th><th>Duration (ms)</th><th>Nav (ms)</th><th>fw:video:start</th>
        ${metricHeaders}
      </tr>
    </thead>
    <tbody>
      ${runRows}
    </tbody>
  </table>

  ${userAgents.length ? `<details><summary>User agents (${userAgents.length})</summary><pre>${userAgents.map(escapeHtml).join('\n')}</pre></details>` : ''}
  <details>
    <summary>Source files (${runs.length})</summary>
    <pre>${runs.map(r => escapeHtml(r.__file)).join('\n')}</pre>
  </details>
</main>
</body>
</html>`
}

function main() {
  const runs = loadRuns(IN_DIR)
  if (!runs.length) {
    console.error(`[report] no run JSONs found in ${IN_DIR}`)
    process.exit(1)
  }
  runs.sort((a, b) => {
    const ai = a.runIndex ?? 0, bi = b.runIndex ?? 0
    if (ai !== bi) return ai - bi
    return String(a.startedAt || '').localeCompare(String(b.startedAt || ''))
  })
  const summary = summarize(runs)
  const html = buildHtml(runs, summary)
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, html)
  console.log(`[report] ${runs.length} runs -> ${path.relative(ROOT, OUT_FILE)}`)
}

main()

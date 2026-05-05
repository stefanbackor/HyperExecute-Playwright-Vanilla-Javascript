#!/usr/bin/env node
// Aggregates artifacts/loadtest/**/*.json (one file per run, written by
// tests/loadtest_storyblock.spec.js) into a self-contained HTML report.
// The output is offline-viewable: all charts are inline SVG, no external deps.
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
// Default to loadtest-html-report/index.html so HyperExecute's `partialReports`
// can expose this directory as a standalone report in the LambdaTest dashboard.
const OUT_FILE = path.resolve(ROOT, arg('--out', 'loadtest-html-report/index.html'))

const VITAL_THRESHOLDS = {
  LCP:  { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  FCP:  { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  TTFB: { good: 800,  poor: 1800, unit: 'ms', label: 'Time To First Byte' },
  CLS:  { good: 0.1,  poor: 0.25, unit: '',   label: 'Cumulative Layout Shift' },
  INP:  { good: 200,  poor: 500,  unit: 'ms', label: 'Interaction to Next Paint' },
}

const COLORS = {
  good: '#22c55e',
  ni:   '#f59e0b',
  poor: '#ef4444',
  axis: '#475569',
  grid: '#1e2742',
  line: '#818cf8',
  fill: 'rgba(129,140,248,0.15)',
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
const median = a => pct(a, 50)
const avg    = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
const minOf  = a => a.length ? Math.min(...a) : null
const maxOf  = a => a.length ? Math.max(...a) : null

function rate(metric, value) {
  const t = VITAL_THRESHOLDS[metric]
  if (!t || value == null) return null
  if (value <= t.good) return 'good'
  if (value <= t.poor) return 'needs-improvement'
  return 'poor'
}

function fmt(value, metric) {
  if (value == null || Number.isNaN(value)) return '—'
  if (metric === 'CLS') return value.toFixed(3)
  return Math.round(value).toString()
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function summarize(runs) {
  const metrics = Object.keys(VITAL_THRESHOLDS)
  const summary = {}
  for (const m of metrics) {
    const values = runs.map(r => r.vitals?.[m]?.value)
      .filter(v => typeof v === 'number' && !Number.isNaN(v))
    summary[m] = {
      count: values.length, min: minOf(values), avg: avg(values),
      median: median(values), p75: pct(values, 75), p95: pct(values, 95),
      max: maxOf(values), values,
    }
  }
  const fw = runs.map(r => r.fwVideoStart?.msSinceNavigationStart)
    .filter(v => typeof v === 'number')
  summary.fwVideoStart = {
    count: fw.length, min: minOf(fw), avg: avg(fw), median: median(fw),
    p75: pct(fw, 75), p95: pct(fw, 95), max: maxOf(fw), values: fw,
  }
  const durations = runs.map(r => r.durationMs).filter(v => typeof v === 'number')
  summary.durationMs = {
    count: durations.length, min: minOf(durations), avg: avg(durations),
    median: median(durations), p75: pct(durations, 75), p95: pct(durations, 95),
    max: maxOf(durations), values: durations,
  }
  return summary
}

// ---------- SVG charts (no external deps) ----------

function lineChart(metric, runs) {
  const t = VITAL_THRESHOLDS[metric]
  const W = 520, H = 220
  const PAD = { l: 50, r: 16, t: 16, b: 32 }
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const points = runs.map((r, i) => ({
    x: i,
    v: r.vitals?.[metric]?.value ?? null,
    label: `Run ${String(r.runIndex ?? i + 1).padStart(2, '0')}`,
  }))
  const valid = points.filter(p => p.v != null)
  if (!valid.length) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#64748b" font-size="12">no data</text></svg>`
  }

  const dataMax = Math.max(...valid.map(p => p.v), t.poor * 1.05)
  const yMax = metric === 'CLS' ? Math.max(dataMax, t.poor * 1.2) : dataMax
  const xCount = Math.max(2, points.length)
  const xAt = i => PAD.l + (xCount === 1 ? innerW / 2 : (i / (xCount - 1)) * innerW)
  const yAt = v => PAD.t + innerH - (v / yMax) * innerH

  const goodY = yAt(t.good)
  const poorY = yAt(t.poor)

  // Threshold band rectangles
  const bandPoor = `<rect x="${PAD.l}" y="${PAD.t}" width="${innerW}" height="${Math.max(0, poorY - PAD.t)}" fill="${COLORS.poor}" opacity="0.06"/>`
  const bandNi   = `<rect x="${PAD.l}" y="${poorY}" width="${innerW}" height="${Math.max(0, goodY - poorY)}" fill="${COLORS.ni}" opacity="0.07"/>`
  const bandGood = `<rect x="${PAD.l}" y="${goodY}" width="${innerW}" height="${Math.max(0, (PAD.t + innerH) - goodY)}" fill="${COLORS.good}" opacity="0.08"/>`

  const goodLine = `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${goodY}" y2="${goodY}" stroke="${COLORS.good}" stroke-dasharray="3,3" stroke-width="1" opacity="0.6"/>`
  const poorLine = `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${poorY}" y2="${poorY}" stroke="${COLORS.poor}" stroke-dasharray="3,3" stroke-width="1" opacity="0.6"/>`

  // Y axis ticks
  const yTickCount = 4
  const yTicks = []
  for (let i = 0; i <= yTickCount; i++) {
    const v = (yMax * i) / yTickCount
    const y = yAt(v)
    yTicks.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`)
    yTicks.push(`<text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${fmt(v, metric)}</text>`)
  }

  // Path + area
  const path = valid.map((p, i) => `${i ? 'L' : 'M'}${xAt(p.x).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(' ')
  const area = valid.length >= 2
    ? `M${xAt(valid[0].x).toFixed(1)},${(PAD.t + innerH).toFixed(1)} ` +
      valid.map(p => `L${xAt(p.x).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(' ') +
      ` L${xAt(valid[valid.length - 1].x).toFixed(1)},${(PAD.t + innerH).toFixed(1)} Z`
    : ''

  // Points
  const dots = valid.map(p => {
    const r = rate(metric, p.v)
    const c = r === 'good' ? COLORS.good : r === 'needs-improvement' ? COLORS.ni : COLORS.poor
    return `<circle cx="${xAt(p.x).toFixed(1)}" cy="${yAt(p.v).toFixed(1)}" r="3.5" fill="${c}" stroke="#0b1020" stroke-width="1.5">
      <title>${p.label}: ${fmt(p.v, metric)}${t.unit} (${r || 'n/a'})</title>
    </circle>`
  }).join('')

  // X axis labels (sample every Nth so they stay legible)
  const stride = Math.max(1, Math.ceil(points.length / 10))
  const xLabels = points
    .filter((_, i) => i % stride === 0 || i === points.length - 1)
    .map(p => `<text x="${xAt(p.x).toFixed(1)}" y="${H - PAD.b + 16}" text-anchor="middle" fill="#94a3b8" font-size="10">${p.label.replace('Run ', '')}</text>`)
    .join('')

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
    ${bandPoor}${bandNi}${bandGood}
    ${yTicks.join('')}
    ${goodLine}${poorLine}
    ${area ? `<path d="${area}" fill="${COLORS.fill}"/>` : ''}
    <path d="${path}" fill="none" stroke="${COLORS.line}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    ${xLabels}
    <text x="${PAD.l}" y="${H - 6}" fill="#64748b" font-size="10">run</text>
  </svg>`
}

function histogram(metric, runs, bucketCount = 10) {
  const t = VITAL_THRESHOLDS[metric]
  const values = runs.map(r => r.vitals?.[metric]?.value).filter(v => typeof v === 'number')
  const W = 520, H = 140
  const PAD = { l: 30, r: 12, t: 8, b: 22 }
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  if (values.length < 2) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#64748b" font-size="12">need ≥ 2 runs for histogram</text></svg>`
  }

  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const range = hi - lo || 1
  const buckets = Array.from({ length: bucketCount }, () => 0)
  const bucketLo = []
  for (let i = 0; i < bucketCount; i++) bucketLo.push(lo + (range * i) / bucketCount)
  for (const v of values) {
    let idx = Math.floor(((v - lo) / range) * bucketCount)
    if (idx >= bucketCount) idx = bucketCount - 1
    buckets[idx]++
  }
  const bMax = Math.max(...buckets)
  const barW = innerW / bucketCount

  const bars = buckets.map((c, i) => {
    const x = PAD.l + i * barW
    const h = bMax ? (c / bMax) * innerH : 0
    const y = PAD.t + innerH - h
    const center = bucketLo[i] + range / bucketCount / 2
    const r = rate(metric, center)
    const fill = r === 'good' ? COLORS.good : r === 'needs-improvement' ? COLORS.ni : COLORS.poor
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" opacity="0.75">
      <title>${fmt(bucketLo[i], metric)}–${fmt(bucketLo[i] + range / bucketCount, metric)}${t.unit}: ${c} run${c === 1 ? '' : 's'}</title>
    </rect>`
  }).join('')

  const xLabels = `
    <text x="${PAD.l}" y="${H - 6}" fill="#94a3b8" font-size="10">${fmt(lo, metric)}${t.unit}</text>
    <text x="${W - PAD.r}" y="${H - 6}" text-anchor="end" fill="#94a3b8" font-size="10">${fmt(hi, metric)}${t.unit}</text>`

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
    <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + innerH}" y2="${PAD.t + innerH}" stroke="${COLORS.grid}"/>
    ${bars}
    ${xLabels}
  </svg>`
}

function durationChart(runs) {
  const W = 520, H = 220
  const PAD = { l: 50, r: 16, t: 16, b: 32 }
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const points = runs.map((r, i) => ({
    x: i, v: typeof r.durationMs === 'number' ? r.durationMs : null,
    label: `Run ${String(r.runIndex ?? i + 1).padStart(2, '0')}`,
  }))
  const valid = points.filter(p => p.v != null)
  if (!valid.length) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#64748b" font-size="12">no data</text></svg>`
  }
  const yMax = Math.max(...valid.map(p => p.v))
  const xCount = Math.max(2, points.length)
  const xAt = i => PAD.l + (xCount === 1 ? innerW / 2 : (i / (xCount - 1)) * innerW)
  const yAt = v => PAD.t + innerH - (v / yMax) * innerH

  const yTicks = []
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4
    const y = yAt(v)
    yTicks.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="${COLORS.grid}"/>`)
    yTicks.push(`<text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${Math.round(v)}</text>`)
  }
  const bars = valid.map(p => {
    const x = xAt(p.x), barW = Math.max(8, innerW / Math.max(points.length, 1) - 4)
    const y = yAt(p.v), h = (PAD.t + innerH) - y
    return `<rect x="${(x - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${COLORS.line}" opacity="0.85">
      <title>${p.label}: ${Math.round(p.v)} ms</title>
    </rect>`
  }).join('')
  const stride = Math.max(1, Math.ceil(points.length / 10))
  const xLabels = points
    .filter((_, i) => i % stride === 0 || i === points.length - 1)
    .map(p => `<text x="${xAt(p.x).toFixed(1)}" y="${H - PAD.b + 16}" text-anchor="middle" fill="#94a3b8" font-size="10">${p.label.replace('Run ', '')}</text>`)
    .join('')
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
    ${yTicks.join('')}${bars}${xLabels}
    <text x="${PAD.l}" y="${H - 6}" fill="#64748b" font-size="10">run · duration (ms)</text>
  </svg>`
}

// ---------- HTML ----------

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
        <td><strong>${m}</strong> <span class="muted">${t.label}</span></td>
        <td>${s.count}</td>
        <td>${fmt(s.min, m)}</td>
        <td>${fmt(s.avg, m)}</td>
        <td>${fmt(s.median, m)}</td>
        <td>${fmt(s.p75, m)} <span class="badge ${r75 || ''}">${r75 || '—'}</span></td>
        <td>${fmt(s.p95, m)}</td>
        <td>${fmt(s.max, m)}</td>
        <td class="muted">good ≤ ${t.good}${t.unit} · poor &gt; ${t.poor}${t.unit}</td>
      </tr>`
  }).join('\n')

  const fwS = summary.fwVideoStart
  const fwSummary = fwS.count
    ? `<tr>
        <td><strong>fw:video:start</strong> <span class="muted">ms since nav</span></td>
        <td>${fwS.count}</td>
        <td>${fmt(fwS.min)}</td><td>${fmt(fwS.avg)}</td><td>${fmt(fwS.median)}</td>
        <td>${fmt(fwS.p75)}</td><td>${fmt(fwS.p95)}</td><td>${fmt(fwS.max)}</td>
        <td class="muted">custom event</td>
      </tr>`
    : `<tr><td><strong>fw:video:start</strong></td><td colspan="8" class="muted">no data</td></tr>`

  const dS = summary.durationMs
  const durationSummary = `<tr>
        <td><strong>test duration</strong> <span class="muted">ms wall clock</span></td>
        <td>${dS.count}</td>
        <td>${fmt(dS.min)}</td><td>${fmt(dS.avg)}</td><td>${fmt(dS.median)}</td>
        <td>${fmt(dS.p75)}</td><td>${fmt(dS.p95)}</td><td>${fmt(dS.max)}</td>
        <td class="muted">per Playwright test</td>
      </tr>`

  const charts = metrics.map(m => {
    const t = VITAL_THRESHOLDS[m]
    return `
      <section class="chart-card">
        <header class="chart-header">
          <h3>${m} <span class="muted">— ${t.label}</span></h3>
          <span class="legend">
            <span class="dot good"></span>≤ ${t.good}${t.unit}
            <span class="dot ni"></span>≤ ${t.poor}${t.unit}
            <span class="dot poor"></span>&gt; ${t.poor}${t.unit}
          </span>
        </header>
        ${lineChart(m, runs)}
        <div class="hist-label muted">distribution</div>
        ${histogram(m, runs)}
      </section>`
  }).join('\n')

  const runRows = runs.map((r, i) => {
    const v = r.vitals || {}
    const cells = metrics.map(m => {
      const val = v[m]?.value
      const rt = v[m]?.rating || rate(m, val)
      return `<td><span class="badge ${rt || ''}">${fmt(val, m)}</span></td>`
    }).join('')
    const fw = r.fwVideoStart?.msSinceNavigationStart
    return `
      <tr>
        <td>#${String(r.runIndex ?? i + 1).padStart(2, '0')}</td>
        <td class="muted nowrap">${escapeHtml(r.startedAt || '')}</td>
        <td>${fmt(r.durationMs)}</td>
        <td>${fmt(r.nav?.duration)}</td>
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
    --bg: #0b1020; --panel: #11162a; --panel-2: #161c36;
    --border: #1f2746; --text: #e6e9f5; --muted: #8892b0;
    --accent: #818cf8; --good: #22c55e; --ni: #f59e0b; --poor: #ef4444;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header.page { padding: 28px 40px 18px; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #11162a 0%, #0b1020 100%); }
  h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.2px; }
  h2 { margin: 32px 0 12px; font-size: 16px; letter-spacing: -0.1px; }
  h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .muted { color: var(--muted); font-weight: normal; }
  .nowrap { white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 10px 28px; margin-top: 10px; font-size: 12px; }
  .meta div span { color: var(--muted); margin-right: 6px; text-transform: uppercase;
    font-size: 10px; letter-spacing: 0.5px; }
  main { padding: 24px 40px 64px; max-width: 1500px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; }
  th { background: var(--panel-2); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--panel-2); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 12px; font-weight: 600; }
  .badge.good { background: rgba(34,197,94,0.15); color: #4ade80; }
  .badge.needs-improvement { background: rgba(245,158,11,0.15); color: #fbbf24; }
  .badge.poor { background: rgba(239,68,68,0.15); color: #f87171; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    margin-top: 12px; }
  .chart-card { background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; }
  .chart-header { display: flex; justify-content: space-between; align-items: center;
    gap: 12px; margin-bottom: 6px; }
  .chart { width: 100%; height: auto; display: block; }
  .legend { font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .dot.good { background: var(--good); }
  .dot.ni   { background: var(--ni); }
  .dot.poor { background: var(--poor); }
  .hist-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    margin: 8px 0 2px; }
  .stat-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    margin: 16px 0 8px; }
  .stat { background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; }
  .stat .label { font-size: 10px; text-transform: uppercase; color: var(--muted);
    letter-spacing: 0.5px; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 4px;
    font-variant-numeric: tabular-nums; }
  .stat .value .u { color: var(--muted); font-size: 13px; font-weight: normal; margin-left: 2px; }
  .stat.good  .value { color: #4ade80; }
  .stat.ni    .value { color: #fbbf24; }
  .stat.poor  .value { color: #f87171; }
  details { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 14px; margin-top: 8px; }
  details summary { cursor: pointer; font-weight: 600; color: var(--muted); }
  pre { overflow-x: auto; font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  .table-wrap { overflow-x: auto; }
  @media (max-width: 720px) {
    header.page, main { padding-left: 16px; padding-right: 16px; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header class="page">
  <h1>Load Test Performance Report</h1>
  <div class="muted" style="font-size:12px">Aggregated from ${runs.length} run${runs.length === 1 ? '' : 's'} · Web Vitals + custom events</div>
  <div class="meta">
    <div><span>generated</span>${escapeHtml(generatedAt)}</div>
    <div><span>source</span>${escapeHtml(path.relative(ROOT, IN_DIR))}</div>
    ${urls.length ? `<div><span>url</span>${urls.map(escapeHtml).join(', ')}</div>` : ''}
  </div>
</header>
<main>
  <div class="stat-grid">
    <div class="stat"><div class="label">Total runs</div><div class="value">${runs.length}</div></div>
    ${metrics.map(m => {
      const r = rate(m, summary[m].p75)
      const cls = r === 'good' ? 'good' : r === 'needs-improvement' ? 'ni' : r === 'poor' ? 'poor' : ''
      const t = VITAL_THRESHOLDS[m]
      return `<div class="stat ${cls}"><div class="label">${m} p75</div><div class="value">${fmt(summary[m].p75, m)}<span class="u">${t.unit}</span></div></div>`
    }).join('')}
    ${fwS.count ? `<div class="stat"><div class="label">fw:video:start p75</div><div class="value">${fmt(fwS.p75)}<span class="u">ms</span></div></div>` : ''}
  </div>

  <h2>Summary statistics</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Metric</th><th>n</th><th>min</th><th>avg</th><th>median</th><th>p75</th><th>p95</th><th>max</th><th>thresholds</th>
      </tr></thead>
      <tbody>
        ${summaryRows}
        ${fwSummary}
        ${durationSummary}
      </tbody>
    </table>
  </div>

  <h2>Per-metric trends across runs</h2>
  <div class="grid">${charts}</div>

  <h2>Test duration per run</h2>
  <section class="chart-card">${durationChart(runs)}</section>

  <h2>Per-run detail</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Run</th><th>Started</th><th>Duration (ms)</th><th>Nav (ms)</th><th>fw:video:start</th>
        ${metricHeaders}
      </tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  </div>

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

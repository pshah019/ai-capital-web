// Price performance for the AI Macro Web "color by performance" mode.
//
// GET /api/quotes?s=NVDA,MSFT,9984.T
//   -> { ok, asof, q: { NVDA: { p, d1, w1, m1, ytd, t, cur }, ... }, missing: [...] }
//   d1 / w1 / m1 / ytd are % changes: vs the previous close, ~5 and ~21 trading days ago,
//   and the last close of the prior calendar year.
//
// Same source as the Stock Research Data tab: Yahoo Finance's public chart endpoint
// (daily bars + live regular-market price), Stooq's free daily CSV as the fallback for
// US symbols. Results are cached in memory for 4 minutes and at the edge for 5 minutes,
// so page traffic never turns into more than ~20 Yahoo calls per 5 minutes.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HDRS = { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' };
const TTL = 4 * 60_000;
const MAX = 40;
const CACHE = new Map(); // sym -> { t, v }

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a, b) => (a == null || b == null || !b ? null : r2((a / b - 1) * 100));

function parse(raw) {
  const seen = new Set(), out = [];
  for (let t of String(raw || '').split(/[\s,;]+/)) {
    t = t.trim().toUpperCase();
    if (!t || !/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out.slice(0, MAX);
}

async function getJSON(url) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(url.replace('https://query1.', `https://${host}.`), { headers: HDRS });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

function yahooRows(j) {
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) return { meta: null, rows: [] };
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = (res.meta && res.meta.gmtoffset) || 0;
  const rows = res.timestamp
    .map((t, i) => ({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), c: q.close && q.close[i] }))
    .filter((b) => b.c != null);
  return { meta: res.meta || {}, rows };
}

async function stooqRows(sym) {
  if (!/^[A-Z][A-Z.\-]*$/.test(sym)) return [];
  try {
    const s = sym.toLowerCase().replace(/\./g, '-') + '.us';
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const rows = (await r.text()).trim().split('\n').slice(1)
      .map((l) => { const p = l.split(','); return { d: p[0], c: +p[4] }; })
      .filter((b) => /^\d{4}-\d\d-\d\d$/.test(b.d) && isFinite(b.c));
    return rows.slice(-300);
  } catch { return []; }
}

function perf(rows, live, liveTime) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const p = live != null ? live : last.c;
  // The latest bar is today's (live) bar while the market is open; compare against the bar before it.
  const n = rows.length - 1;
  const back = (k) => (n - k >= 0 ? rows[n - k].c : null);
  const yr = last.d.slice(0, 4);
  let prevYear = null;
  for (let i = n; i >= 0; i--) if (rows[i].d.slice(0, 4) < yr) { prevYear = rows[i].c; break; }
  return {
    p: r2(p),
    d1: pct(p, back(1)),
    w1: pct(p, back(5)),
    m1: pct(p, back(21)),
    ytd: pct(p, prevYear),
    t: liveTime || last.d,
  };
}

async function one(sym) {
  const hit = CACHE.get(sym);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null;
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&includePrePost=false`);
  const y = yahooRows(j);
  if (y.rows.length) {
    const m = y.meta;
    v = perf(y.rows, m.regularMarketPrice, m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null);
    if (v) { v.cur = m.currency || 'USD'; v.src = 'Yahoo Finance'; }
  } else {
    const rows = await stooqRows(sym);
    v = perf(rows, null, null);
    if (v) { v.cur = 'USD'; v.src = 'Stooq'; }
  }
  if (v) CACHE.set(sym, { t: Date.now(), v });
  else if (hit) v = hit.v; // serve the last good value rather than a gap
  return v;
}

export default async function handler(req, res) {
  const syms = parse((req.query || {}).s);
  if (!syms.length) return res.status(400).json({ ok: false, error: 'Pass symbols as ?s=NVDA,MSFT' });
  const q = {}, missing = [];
  // Small batches keep Yahoo happy.
  for (let i = 0; i < syms.length; i += 6) {
    const part = syms.slice(i, i + 6);
    const vals = await Promise.all(part.map((s) => one(s).catch(() => null)));
    part.forEach((s, k) => { if (vals[k]) q[s] = vals[k]; else missing.push(s); });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ ok: Object.keys(q).length > 0, asof: new Date().toISOString(), q, missing });
}

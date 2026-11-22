// Stock Research Data scan.
//
// GET /api/stocks?symbols=AAPL,MSFT&list=Crash%20watch&save=1
//
// One source for every number: Yahoo Finance's public chart endpoint (split-adjusted
// daily bars + the live regular-market price). Stooq's free daily CSV is the fallback if
// Yahoo refuses a symbol, and the row says which source it used. Sector/category comes
// from Yahoo's search endpoint (ETFs/funds are labelled as such).
//
// Columns returned per symbol:
//   price            latest regular-market price
//   prevWeekHigh     highest high of the most recent COMPLETED Mon–Fri trading week
//   prevMonthHigh    highest high of the most recent COMPLETED calendar month
//   ytdStart         close on the first trading day of this calendar year (+ ytdPct)
//   ipoPrice         first traded price on record (split-adjusted), + firstTradeDate
//   category         sector (e.g. Technology) / industry, or ETF / Fund
// If save=1 and Supabase is configured, the run is stored in stock_research_runs and the
// response carries the previous run's prices for the same list so the page can show the change.

import { storageReady, sb, parseSymbols, SETUP_HINT } from './_sb.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HDRS = { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' };
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const MAX_SYMBOLS = 60;

async function getJSON(url) {
  for (const host of ['query1', 'query2']) {
    const u = url.replace('https://query1.', `https://${host}.`);
    try {
      const r = await fetch(u, { headers: HDRS });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

function bars(chart) {
  const res = chart && chart.chart && chart.chart.result && chart.chart.result[0];
  if (!res || !res.timestamp) return { meta: res ? res.meta : null, rows: [] };
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = (res.meta && res.meta.gmtoffset) || 0;
  const rows = res.timestamp.map((t, i) => ({
    d: new Date((t + off) * 1000).toISOString().slice(0, 10),
    o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i],
  })).filter((b) => b.c != null && b.h != null);
  return { meta: res.meta, rows };
}

// ---- date helpers (all in exchange-local calendar days, YYYY-MM-DD strings) ----
const ymd = (d) => d.toISOString().slice(0, 10);
function weekStart(dstr) { const d = new Date(dstr + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return ymd(d); }

function computeFromBars(rows, todayStr) {
  if (!rows.length) return {};
  const last = rows[rows.length - 1];
  // Most recent completed week: if the latest bar's week is still in progress (a weekday today,
  // same week), use the week before it; on weekends the week that just ended is complete.
  const today = new Date(todayStr + 'T12:00:00Z');
  const isWeekend = [0, 6].includes(today.getUTCDay());
  const curWk = weekStart(todayStr);
  const targetWk = (() => {
    if (isWeekend) return curWk;
    const d = new Date(curWk + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 7); return ymd(d);
  })();
  const wkBars = rows.filter((b) => weekStart(b.d) === targetWk);
  const prevWeekHigh = wkBars.length ? Math.max(...wkBars.map((b) => b.h)) : null;
  // Most recent completed calendar month.
  const pm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const pmKey = ymd(pm).slice(0, 7);
  const mBars = rows.filter((b) => b.d.slice(0, 7) === pmKey);
  const prevMonthHigh = mBars.length ? Math.max(...mBars.map((b) => b.h)) : null;
  // YTD start = first close of this calendar year.
  const yr = todayStr.slice(0, 4);
  const firstY = rows.find((b) => b.d.slice(0, 4) === yr);
  const ytdStart = firstY ? firstY.c : null;
  return {
    lastClose: last.c, lastBar: last.d,
    prevWeekHigh: r2(prevWeekHigh), prevWeekOf: wkBars.length ? targetWk : null,
    prevMonthHigh: r2(prevMonthHigh), prevMonth: mBars.length ? pmKey : null,
    ytdStart: r2(ytdStart),
  };
}

async function category(sym) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=5&newsCount=0&listsCount=0`);
  const q = j && j.quotes && (j.quotes.find((x) => (x.symbol || '').toUpperCase() === sym) || null);
  if (!q) return { category: null, industry: null, name: null };
  const type = q.quoteType;
  let cat = q.sectorDisp || q.sector || null;
  if (!cat && type === 'ETF') cat = 'ETF';
  if (!cat && type === 'MUTUALFUND') cat = 'Fund';
  if (!cat && type === 'INDEX') cat = 'Index';
  if (!cat && type === 'CRYPTOCURRENCY') cat = 'Crypto';
  return { category: cat, industry: q.industryDisp || q.industry || null, name: q.longname || q.shortname || null };
}

async function stooq(sym) {
  const s = sym.toLowerCase().replace(/\./g, '-') + '.us';
  try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const txt = await r.text();
    const lines = txt.trim().split('\n').slice(1);
    const rows = lines.map((l) => { const [d, o, h, lo, c] = l.split(','); return { d, o: +o, h: +h, l: +lo, c: +c }; }).filter((b) => b.d && isFinite(b.c));
    return rows.length ? rows : null;
  } catch { return null; }
}

async function scanOne(sym, todayStr) {
  const out = { symbol: sym, source: 'Yahoo Finance' };
  const [y1, ymax, cat] = await Promise.all([
    getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&includePrePost=false&events=split`),
    getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=3mo&includePrePost=false&events=split`),
    category(sym),
  ]);
  Object.assign(out, cat);
  const a = bars(y1);
  if (a.rows.length) {
    Object.assign(out, computeFromBars(a.rows, todayStr));
    const m = a.meta || {};
    out.price = r2(m.regularMarketPrice != null ? m.regularMarketPrice : out.lastClose);
    out.priceTime = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null;
    out.currency = m.currency || 'USD';
    out.name = out.name || m.longName || m.shortName || null;
    out.exchange = m.fullExchangeName || m.exchangeName || null;
    const mx = bars(ymax);
    const first = mx.rows.find((b) => b.o != null || b.c != null);
    const ftd = (mx.meta && mx.meta.firstTradeDate) || (a.meta && a.meta.firstTradeDate);
    out.ipoPrice = first ? r2(first.o != null ? first.o : first.c) : null;
    out.firstTradeDate = ftd ? new Date(ftd * 1000).toISOString().slice(0, 10) : (first ? first.d : null);
  } else {
    const rows = await stooq(sym);
    if (!rows) { out.error = 'No data from Yahoo or Stooq for this symbol'; return out; }
    out.source = 'Stooq (fallback)';
    Object.assign(out, computeFromBars(rows.filter((b) => b.d >= ymd(new Date(Date.now() - 400 * 864e5))), todayStr));
    out.price = r2(rows[rows.length - 1].c);
    out.priceTime = rows[rows.length - 1].d;
    out.ipoPrice = r2(rows[0].o || rows[0].c);
    out.firstTradeDate = rows[0].d;
    out.currency = 'USD';
  }
  out.ytdPct = out.price != null && out.ytdStart ? r2((out.price / out.ytdStart - 1) * 100) : null;
  out.offWeekPct = out.price != null && out.prevWeekHigh ? r2((out.price / out.prevWeekHigh - 1) * 100) : null;
  out.offMonthPct = out.price != null && out.prevMonthHigh ? r2((out.price / out.prevMonthHigh - 1) * 100) : null;
  out.vsIpoPct = out.price != null && out.ipoPrice ? r2((out.price / out.ipoPrice - 1) * 100) : null;
  delete out.lastClose;
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const symbols = parseSymbols(q.symbols).slice(0, MAX_SYMBOLS);
  if (!symbols.length) return res.status(400).json({ ok: false, error: 'Pass ?symbols=AAPL,MSFT,…' });
  const listName = String(q.list || 'Default').slice(0, 80);
  const todayStr = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10); // US-Eastern-ish calendar day

  const rows = await pool(symbols, 6, (s) => scanOne(s, todayStr).catch((e) => ({ symbol: s, error: String(e.message || e) })));
  const runAt = new Date().toISOString();
  const body = { ok: true, runAt, list: listName, rows, configured: storageReady(), saved: false, previous: null };

  if (storageReady()) {
    try {
      const prev = await sb(`stock_research_runs?select=id,run_at,rows&list_name=eq.${encodeURIComponent(listName)}&order=run_at.desc&limit=1`);
      if (prev && prev[0]) {
        const map = {};
        (prev[0].rows || []).forEach((r) => { if (r && r.symbol && r.price != null) map[r.symbol] = r.price; });
        body.previous = { runAt: prev[0].run_at, prices: map };
      }
      if (q.save === '1') {
        const slim = rows.map((r) => ({ symbol: r.symbol, price: r.price, prevWeekHigh: r.prevWeekHigh, prevMonthHigh: r.prevMonthHigh, ytdStart: r.ytdStart, ytdPct: r.ytdPct, ipoPrice: r.ipoPrice, firstTradeDate: r.firstTradeDate, category: r.category, industry: r.industry, name: r.name, source: r.source, error: r.error || null }));
        await sb('stock_research_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ run_at: runAt, list_name: listName, symbols, rows: slim }) });
        body.saved = true;
      }
    } catch (e) { body.storageError = String(e.message || e); }
  } else body.hint = SETUP_HINT;

  res.status(200).json(body);
}

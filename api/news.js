// Live news feed for the Work in Progress tab.
// Pulls free public RSS feeds (FinancialJuice, investingLive, CNBC) on the server,
// stores every new headline in Supabase (table news_items) so the feed keeps 1-2 days of
// history even though each RSS feed only shows its latest 25-100 items, and serves the
// stored window to the page.
//
// GET /api/news                -> last 48h (max 72h via ?hours=)
// GET /api/news?since=<ms>     -> only items stored after that time (for polling)
// GET /api/news?refresh=1      -> force a source pull (still rate limited); used by the
//                                 Supabase pg_cron job every 5 minutes so the archive keeps
//                                 filling while nobody has the page open.
// Source pulls happen at most once every MIN_GAP_MS, whatever the traffic.

import { storageReady, sb } from './_sb.js';

const MIN_GAP_MS = 45_000;
const UA = 'Mozilla/5.0 (compatible; AIInsightsNews/1.0; +https://ai-capital-web.vercel.app)';
const FEEDS = [
  { src: 'FJ',   url: 'https://www.financialjuice.com/feed.ashx?xy=rss' },
  { src: 'IL',   url: 'https://investinglive.com/feed' },
  { src: 'IL',   url: 'https://investinglive.com/feed/news' },
  { src: 'IL',   url: 'https://investinglive.com/feed/centralbank' },
  { src: 'IL',   url: 'https://investinglive.com/feed/stocks' },
  { src: 'IL',   url: 'https://investinglive.com/feed/commodities' },
  { src: 'IL',   url: 'https://investinglive.com/feed/forex' },
  { src: 'IL',   url: 'https://investinglive.com/feed/crypto' },
  { src: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' }, // top news
  { src: 'CNBC', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },  // markets
  { src: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },  // economy
  { src: 'CNBC', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },  // finance
  { src: 'CNBC', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },  // technology
  { src: 'CNBC', url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },  // earnings
];

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1] : ''; };

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function parse(xml, src) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let title = decode(tag(it, 'title')).replace(/^FinancialJuice:\s*/i, '');
    if (!title) continue;
    const link = decode(tag(it, 'link')) || '';
    const guid = decode(tag(it, 'guid')) || link || title;
    const t = Date.parse(decode(tag(it, 'pubDate'))) || Date.now();
    const snip = src === 'FJ' ? '' : decode(tag(it, 'description')).slice(0, 220);
    const hot = /^(breaking|urgent|alert)\b|\bbreaking\b:/i.test(title);
    out.push({ id: src + ':' + hash(guid), src, title: title.slice(0, 400), link: link.slice(0, 600), published_at: new Date(Math.min(t, Date.now() + 60_000)).toISOString(), snip, hot });
  }
  return out;
}

async function getFeed(f) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: ctl.signal });
    if (!r.ok) return { src: f.src, url: f.url, err: 'HTTP ' + r.status, items: [] };
    const items = parse(await r.text(), f.src);
    return { src: f.src, url: f.url, items, err: items.length ? null : 'no items' };
  } catch (e) { return { src: f.src, url: f.url, err: String(e.name === 'AbortError' ? 'timeout' : e.message || e), items: [] }; }
  finally { clearTimeout(to); }
}

async function pullAll() {
  const res = await Promise.all(FEEDS.map(getFeed));
  const seen = new Set(), items = [];
  for (const r of res) for (const it of r.items) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
  return { items, status: res.map(r => ({ src: r.src, n: r.items.length, err: r.err })) };
}

const toClient = r => ({ id: r.id, src: r.src, title: r.title, link: r.link, t: Date.parse(r.published_at), f: Date.parse(r.fetched_at || r.published_at), hot: !!r.hot, snip: r.snip || '' });

export default async function handler(req, res) {
  const q = req.query || {};
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const hours = Math.min(72, Math.max(1, +q.hours || 48));

  // No database configured: serve whatever the feeds have right now.
  if (!storageReady()) {
    res.setHeader('Cache-Control', 'public, s-maxage=45, stale-while-revalidate=120');
    const { items, status } = await pullAll();
    items.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    return res.status(200).json({ ok: true, stored: false, now, items: items.map(toClient), status });
  }

  try {
    // 1) Pull sources if the last pull is older than MIN_GAP_MS.
    let pulled = null;
    const meta = await sb('news_meta?select=k,at&k=eq.last_pull');
    const last = meta && meta[0] ? Date.parse(meta[0].at) : 0;
    if (now - last > MIN_GAP_MS || (q.refresh && now - last > 20_000)) {
      // claim the slot first so parallel requests don't all pull
      await sb('news_meta?on_conflict=k', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ k: 'last_pull', at: new Date(now).toISOString() }) });
      const { items, status } = await pullAll();
      if (items.length) {
        for (let i = 0; i < items.length; i += 400) {
          await sb('news_items?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(items.slice(i, i + 400)) });
        }
      }
      pulled = status;
      // prune anything older than 4 days (about 1 pull in 30)
      if (Math.random() < 0.035) await sb(`news_items?published_at=lt.${new Date(now - 4 * 86400_000).toISOString()}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }

    if (q.refresh && q.limit === '1') return res.status(200).json({ ok: true, pulled });

    // 2) Read the stored window.
    const since = +q.since || 0;
    const filt = since
      ? `fetched_at=gt.${new Date(since - 2000).toISOString()}`
      : `published_at=gt.${new Date(now - hours * 3600_000).toISOString()}`;
    const rows = await sb(`news_items?select=id,src,title,link,published_at,fetched_at,hot,snip&${filt}&order=published_at.desc&limit=3000`);
    return res.status(200).json({ ok: true, stored: true, now, hours, items: (rows || []).map(toClient), pulled });
  } catch (e) {
    // Database problem: fall back to a live pull so the pane still shows news.
    try {
      res.setHeader('Cache-Control', 'public, s-maxage=45, stale-while-revalidate=120');
      const { items, status } = await pullAll();
      items.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
      return res.status(200).json({ ok: true, stored: false, now, items: items.map(toClient), status, dbError: String(e.message || e).slice(0, 200) });
    } catch (e2) {
      return res.status(200).json({ ok: false, error: String(e2.message || e2) });
    }
  }
}

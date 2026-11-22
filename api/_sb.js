// Shared Supabase helpers (files starting with "_" are not deployed as their own functions).
// The browser never holds a key: the credential lives in this Vercel project's environment
// variables (SUPABASE_ANON_KEY), same pattern as sector-rotation-scanner.

export const SB_URL = process.env.SUPABASE_URL || 'https://ihlggfdwbhgechoqvrri.supabase.co';
export const SB_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
export const storageReady = () => !!(SB_URL && SB_KEY);

export function sbHeaders(extra) {
  return { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, ...(extra || {}) };
}

export async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: sbHeaders({ 'Content-Type': 'application/json', ...(opts.headers || {}) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 240)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** Accepts commas, spaces, newlines, tabs, and $-prefixed symbols. */
export function parseSymbols(raw) {
  if (!raw) return [];
  const seen = new Set(), out = [];
  for (let t of String(raw).split(/[\s,;]+/)) {
    t = t.trim().toUpperCase().replace(/^\$/, '');
    if (!t || !/^[A-Z^][A-Z0-9.\-=^]{0,11}$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

export const SETUP_HINT =
  'Add SUPABASE_ANON_KEY to the ai-capital-web Vercel project (Settings → Environment Variables), then redeploy. Prices still load without it; runs and watchlists just are not saved.';

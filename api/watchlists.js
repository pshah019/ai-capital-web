// Saved watchlists for the Stock Research Data tab — stored server side so a list made
// on a laptop shows up on a phone. GET lists all; POST {name, symbols, notes} creates or
// overwrites by name; DELETE ?name= removes one.
//
// Past scans: GET /api/watchlists?runs=1[&list=NAME] returns the latest stored runs.

import { storageReady, sb, readBody, parseSymbols, SETUP_HINT } from './_sb.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storageReady()) return res.status(200).json({ ok: true, configured: false, lists: [], runs: [], hint: SETUP_HINT });
  const q = req.query || {};
  try {
    if (req.method === 'GET' && q.runs) {
      const filt = q.list ? `&list_name=eq.${encodeURIComponent(q.list)}` : '';
      if (q.id) {
        const one = await sb(`stock_research_runs?select=id,run_at,list_name,symbols,rows&id=eq.${encodeURIComponent(q.id)}`);
        return res.status(200).json({ ok: true, configured: true, run: one && one[0] });
      }
      const runs = await sb(`stock_research_runs?select=id,run_at,list_name,symbols&order=run_at.desc&limit=40${filt}`);
      return res.status(200).json({ ok: true, configured: true, runs: runs || [] });
    }
    if (req.method === 'GET') {
      const lists = await sb('stock_watchlists?select=id,name,symbols,notes,updated_at&order=name.asc');
      return res.status(200).json({ ok: true, configured: true, lists: lists || [] });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 80);
      const symbols = parseSymbols(Array.isArray(b.symbols) ? b.symbols.join(',') : b.symbols).slice(0, 60);
      if (!name || !symbols.length) return res.status(400).json({ ok: false, error: 'Name and at least one ticker are required.' });
      const row = { name, symbols, notes: String(b.notes || '').slice(0, 2000), updated_at: new Date().toISOString() };
      await sb('stock_watchlists?on_conflict=name', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
      return res.status(200).json({ ok: true, configured: true, saved: row });
    }
    if (req.method === 'DELETE') {
      const name = String(q.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'Pass ?name=' });
      await sb(`stock_watchlists?name=eq.${encodeURIComponent(name)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.status(200).json({ ok: true, configured: true, deleted: name });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.status(200).json({ ok: false, configured: true, error: String(e.message || e) });
  }
}

const { redis } = require('./_redis');
const pause = action => /^(pause|aux)$/i.test(action);
const reasonOf = e => {
  const values = [e.eventData, e.miscDetails].map(v => String(v || '').trim());
  return values.find(v => v && !/^(break|pause|aux|release|ready|idle|na|n\/a|null|undefined)$/i.test(v)) || '';
};
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });
  try {
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
    if (date > today || date < '2026-09-26')
      return res.status(400).json({ error: 'Date is out of range' });
    const [members, trackingSince, seedValue] = await Promise.all([
      redis(['ZRANGE', 'break:events:' + date, 0, -1]),
      redis(['GET', 'break:tracking-since']),
      redis(['GET', 'break:seed:' + date]),
    ]);
    // Preserve reports captured before the event retention rule changed.
    if (date < today) await Promise.all([
      redis(['PERSIST', 'break:events:' + date]),
      redis(['PERSIST', 'break:seed:' + date]),
    ]);
    let seed = null;
    try { if (seedValue) seed = JSON.parse(seedValue); } catch {}
    const events = (members || []).map(value => { try { return JSON.parse(value); } catch { return null; } })
      .filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const agents = new Map();
    for (const e of events) {
      let item = agents.get(e.agentId);
      if (!item) { item = { agentId: e.agentId, breaks: [], open: null }; agents.set(e.agentId, item); }
      const time = Date.parse(e.at);
      if (pause(e.action)) {
        const reason = reasonOf(e);
        if (!item.open) item.open = { start: e.at, reason: reason || 'Reason unavailable' };
        else if (reason && item.open.reason === 'Reason unavailable') item.open.reason = reason;
      } else if (item.open && Number.isFinite(time)) {
        item.breaks.push({ ...item.open, end: e.at });
        item.open = null;
      }
    }
    const combined = new Map();
    for (const row of seed?.rows || []) {
      if (!combined.has(row.agentId)) combined.set(row.agentId, { agentId: row.agentId, agentName: row.agentName, breaks: [] });
      combined.get(row.agentId).breaks.push({ start: row.start, end: row.end, reason: row.reason, duration: row.duration });
    }
    const cutoff = seed?.rows?.length
      ? Math.max(...seed.rows.map(row => Date.parse(row.end || row.start)).filter(Number.isFinite))
      : 0;
    for (const item of agents.values()) {
      if (!combined.has(item.agentId)) combined.set(item.agentId, { agentId: item.agentId, breaks: [] });
      for (const entry of item.open ? [...item.breaks, { ...item.open, end: null }] : item.breaks) {
        if (!seed || Date.parse(entry.start) > cutoff) combined.get(item.agentId).breaks.push(entry);
      }
    }
    return res.status(200).json({ ok: true, date, trackingSince: trackingSince || null,
      baselineAt: seed?.capturedAt || null, events: events.length, agents: [...combined.values()] });
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'Live break history is unavailable' });
  }
};

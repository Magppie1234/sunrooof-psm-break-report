const crypto = require('crypto');
const { redis } = require('./_redis');

function equal(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function eventDate(value) {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return null;
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(value.replace(' ', 'T') + (explicitZone ? '' : '+05:30'));
  return Number.isNaN(date.getTime()) ? null : date;
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  if (!equal(req.query.key, process.env.OZONETEL_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    let payload = req.body;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    if (!payload || typeof payload !== 'object' || String(payload.eventType).toLowerCase() !== 'agent')
      return res.status(200).json({ ignored: true });
    if (String(payload.username || '').toLowerCase() !== String(process.env.OZONETEL_USERNAME || '').toLowerCase())
      return res.status(200).json({ ignored: true });
    const data = payload.data || {};
    const agentId = String(data.agentId || data.agent_id || '').trim();
    const action = String(data.action || '').trim();
    const at = eventDate(data.event_time || data.eventTime || payload.eventTime);
    if (!agentId || !action || !at) return res.status(200).json({ ignored: true });
    const date = new Date(at.getTime() + 330 * 60000).toISOString().slice(0, 10);
    const entry = {
      agentId, action, at: at.toISOString(),
      eventData: String(data.eventData || '').slice(0, 120),
      miscDetails: String(data.miscDetails || '').slice(0, 120),
      agentMode: String(data.agentMode || '').slice(0, 40),
    };
    await redis(['ZADD', 'break:events:' + date, 'NX', at.getTime(), JSON.stringify(entry)]);
    // Daily break events are the completed report source, so retain them.
    await redis(['PERSIST', 'break:events:' + date]);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(503).json({ error: 'Could not save agent event' });
  }
};

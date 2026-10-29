const {redis} = require('./_redis');
const {buildHistory} = require('../lib/break-history.cjs');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'GET required'});
  const now = Date.now(), today = new Date(now + 330 * 60000).toISOString().slice(0,10);
  const date = req.query?.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < '2026-09-26' || Number.isNaN(Date.parse(date)))
    return res.status(400).json({ok:false,error:'Date is out of range'});
  try {
    const previous = new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    const [members, prior, trackingSince, seedValue, liveValue] = await Promise.all([
      redis(['ZRANGE','break:events:'+date,0,-1]),
      redis(['ZRANGE','break:events:'+previous,0,-1]),
      redis(['GET','break:tracking-since']), redis(['GET','break:seed:'+date]),
      date === today ? redis(['GET','break:live-status']).catch(()=>null) : null,
    ]);
    const parse = value => {try{return JSON.parse(value);}catch{return null;}};
    const seed = parse(seedValue), live = parse(liveValue);
    const events = [...(prior||[]),...(members||[])].map(parse).filter(Boolean);
    const history = buildHistory({date,events,seed,now,statuses:live?.status||[],statusAt:live?.fetchedAt});
    return res.status(200).json({ok:true,date,fetchedAt:new Date(now).toISOString(),trackingSince:trackingSince||null,
      baselineAt:seed?.capturedAt||null,events:history.coverage.events,...history});
  } catch {
    return res.status(503).json({ok:false,error:'Break history is unavailable; totals could not be verified.'});
  }
};

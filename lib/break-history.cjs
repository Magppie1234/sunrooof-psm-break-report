const metrics = require('../break-metrics');
const pause = action => /^(pause|aux)$/i.test(action);
const resumes = action => /^(release|ready|idle|calling|incall|acw|login|logout)$/i.test(action);
const canonical = value => new Date(value).toISOString();

function buildHistory({date, events = [], seed = null, now = Date.now(), statuses = [], statusAt = null}) {
  const dayStart = metrics.stamp('00:00:00', date), dayEnd = dayStart + 86400000;
  const limit = Math.min(now, dayEnd), today = new Date(now + 330 * 60000).toISOString().slice(0, 10);
  const agents = new Map(), seen = new Set();
  const verifiedComplete = !!seed?.verifiedComplete && date < today;
  const sorted = (verifiedComplete ? [] : events).filter(e => e && e.agentId && Number.isFinite(Date.parse(e.at)))
    .filter(e => Date.parse(e.at) <= limit).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const ensure = (id, name) => {
    if (!agents.has(id)) agents.set(id, {agentId:id, agentName:name || undefined, breaks:[], open:null, incomplete:false});
    const agent = agents.get(id);
    if (name) agent.agentName = name;
    return agent;
  };
  const finish = (agent, end) => {
    if (!agent.open) return;
    if (end >= Date.parse(agent.open.start)) agent.breaks.push({...agent.open, end:canonical(end), source:'events'});
    agent.open = null;
  };
  for (const e of sorted) {
    const id = String(e.agentId).trim(), time = Date.parse(e.at);
    const duplicate = JSON.stringify([id, time, String(e.action).toLowerCase(), e.eventData || '', e.miscDetails || '']);
    if (!id || seen.has(duplicate)) continue;
    seen.add(duplicate);
    const agent = ensure(id);
    if (pause(e.action)) {
      const reason = metrics.reasonOf(e);
      if (agent.open && metrics.key(reason) !== metrics.key(agent.open.reason)) {
        if (!metrics.isNamed(reason) && !metrics.isSystem(reason)) continue;
        if (!metrics.isNamed(agent.open.reason) && !metrics.isSystem(agent.open.reason)) agent.open.reason = reason;
        else finish(agent, time);
      }
      if (!agent.open) agent.open = {start:canonical(time), reason};
    } else if (resumes(e.action)) finish(agent, time);
  }
  // A baseline is matched against that agent's overlapping break. Another agent's
  // last saved timestamp is never a reason to discard a real event.
  for (const row of seed?.rows || []) {
    const start = metrics.stamp(row.start, date), end = row.end ? metrics.stamp(row.end, date) : NaN;
    if (!row.agentId || !Number.isFinite(start) || start > limit || Number.isFinite(end) && end < start) continue;
    const agent = ensure(row.agentId, row.agentName);
    const baseline = {...row, start:canonical(start), end:Number.isFinite(end) ? canonical(end) : null, source:'saved-report'};
    if(verifiedComplete) {agent.breaks.push(baseline);continue;}
    const matching = entry => metrics.key(entry.reason) === metrics.key(baseline.reason)
      && Math.abs(Date.parse(entry.start) - start) <= 1000;
    const existing = agent.breaks.findIndex(matching);
    if (existing >= 0) {
      // A provider-confirmed end wins; an incomplete baseline cannot erase an end event.
      if (baseline.end) agent.breaks[existing] = baseline;
    } else agent.breaks.push(baseline);
    if (agent.open && matching(agent.open)) {
      if (baseline.end) agent.open = null;
      else agent.breaks = agent.breaks.filter(entry => entry !== baseline);
    }
  }
  const stateMap = new Map(statuses.map(s => [s.agentId, s]));
  const observedAt = Date.parse(statusAt || '');
  const freshStatus = Number.isFinite(observedAt) && now - observedAt <= 300000;
  const output = [];
  for (const agent of agents.values()) {
    if (agent.open) agent.breaks.push({...agent.open, end:null, source:'events'});
    const baselines = agent.breaks.filter(b => b.source === 'saved-report');
    let eventBreaks = agent.breaks.filter(b => b.source !== 'saved-report');
    for (const baseline of baselines) {
      const start = Date.parse(baseline.start), end = baseline.end ? Date.parse(baseline.end) : limit;
      eventBreaks = eventBreaks.flatMap(entry => {
        const eventStart = Date.parse(entry.start), eventEnd = entry.end ? Date.parse(entry.end) : limit;
        if (eventEnd <= start || eventStart >= end) return [entry];
        if (metrics.key(entry.reason) === metrics.key(baseline.reason)) {
          baseline.start = canonical(Math.min(start, eventStart));
          if (!baseline.end && entry.end) baseline.end = entry.end;
          return [];
        }
        // Provider baseline wins for the overlapping segment; retain real event
        // segments on either side rather than counting the same seconds twice.
        const fragments = [];
        if (eventStart < start) fragments.push({...entry,end:canonical(start)});
        if (eventEnd > end) fragments.push({...entry,start:canonical(end)});
        return fragments;
      });
    }
    agent.breaks = [...baselines,...eventBreaks];
    const unique = new Map();
    for (const entry of agent.breaks) {
      const actualStart = Date.parse(entry.start), end = entry.end ? Date.parse(entry.end) : null;
      if (actualStart >= dayEnd || end != null && end < dayStart) continue;
      const start = Math.max(actualStart, dayStart);
      if (start > limit) continue;
      const state = stateMap.get(agent.agentId);
      const contradicted = !entry.end && freshStatus && observedAt >= actualStart
        && state && !pause(state.state) && !/^(paused|break)$/i.test(state.state);
      const incomplete = !entry.end && (date < today || contradicted);
      const row = {...entry, start:canonical(start),
        ...(actualStart < dayStart ? {actualStart:entry.start, carriedOver:true} : {}),
        end:end == null ? null : canonical(Math.min(end, dayEnd)),
        ongoing:!entry.end && !incomplete, incomplete};
      if (incomplete) agent.incomplete = true;
      row.countedSeconds = incomplete ? 0 : Math.max(0, Math.floor(((end == null ? limit : Math.min(end, limit)) - start) / 1000));
      if(verifiedComplete && /^\d+:\d{2}:\d{2}$/.test(String(entry.duration||'')))
        row.countedSeconds=metrics.seconds(entry.duration);
      const key = verifiedComplete ? String(unique.size) : JSON.stringify([row.start, row.end, metrics.key(row.reason)]);
      if (!unique.has(key)) unique.set(key, row);
    }
    const breaks = [...unique.values()].sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
    output.push({agentId:agent.agentId, ...(agent.agentName ? {agentName:agent.agentName} : {}), breaks, incomplete:agent.incomplete});
  }
  if (date === today && freshStatus) for (const s of statuses) {
    if (!/^(aux|pause|paused|break)$/i.test(s.state)) continue;
    let agent = output.find(a => a.agentId === s.agentId);
    if (!agent) {agent = {agentId:s.agentId, agentName:s.agentName, breaks:[], incomplete:true};output.push(agent);}
    if (!agent.breaks.some(b => b.ongoing)) agent.incomplete = true;
  }
  const dayEvents = sorted.filter(e => Date.parse(e.at) >= dayStart && Date.parse(e.at) < dayEnd);
  return {agents:output, coverage:{firstEventAt:dayEvents[0]?.at || null, lastEventAt:dayEvents.at(-1)?.at || null,
    events:dayEvents.length, verifiedComplete, verifiedAt:verifiedComplete?seed.capturedAt:null,
    source:verifiedComplete?'Ozonetel completed detailed report':'Ozonetel agent events',
    incompleteAgents:output.filter(a => a.incomplete).map(a => a.agentId)}};
}
module.exports = {buildHistory, pause, resumes};

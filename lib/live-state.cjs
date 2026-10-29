const metrics = require('../break-metrics');
const {buildHistory} = require('./break-history.cjs');
const stateKey = value => {
  const s = String(value || '').trim().toLowerCase();
  if (/^(aux|pause|paused|break)$/.test(s)) return 'PAUSE';
  if (/^(release|ready|idle)$/.test(s)) return 'READY';
  if (/^(calling|incall|busy|oncall|on call)$/.test(s)) return 'BUSY';
  if (/^(logout|logged out)$/.test(s)) return 'LOGOUT';
  return s.toUpperCase() || 'UNKNOWN';
};
const hms = n => `${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;

function reconcileLive({rows, sampledAt, events, names = new Map(), details = new Map(), now = Date.now(), integration}) {
  const latest = new Map(), changes = new Map();
  for (const e of [...events].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
    const time = Date.parse(e.at), state = stateKey(e.action);
    if (!Number.isFinite(time) || time > now || !['PAUSE','READY','BUSY','ACW','LOGOUT'].includes(state)) continue;
    const previous = latest.get(e.agentId);
    if (!previous || previous.state !== state) changes.set(e.agentId, time);
    latest.set(e.agentId,{state,at:time});
  }
  const logins = new Map(rows.map(x=>[String(x.AgentId||x.AgentID||x.agentId||'').trim(),x]).filter(([id])=>id));
  const ids = new Set([...names.keys(),...logins.keys(),...latest.keys()]);
  const date = new Date(now+330*60000).toISOString().slice(0,10);
  const history = buildHistory({date,events,now});
  const snapshotAt = Number(sampledAt)*1000;
  const status = [...ids].map(id=>{
    const row=logins.get(id), event=latest.get(id);
    const providerState=row?stateKey(row.AgentState||row.State||row.state):'LOGOUT';
    const useEvent=event && event.at>snapshotAt;
    const state=useEvent?event.state:providerState;
    const eventStateMatches=event?.state===state;
    const open=history.agents.find(a=>a.agentId===id)?.breaks.find(b=>b.ongoing);
    const detail=details.get(id),detailMatches=detail && stateKey(detail.state)===state && now-detail.at<=300000;
    let stateSince=eventStateMatches?changes.get(id):null;
    if(state==='PAUSE'&&open&&eventStateMatches)stateSince=Date.parse(open.actualStart||open.start);
    let since=stateSince?hms(Math.max(0,Math.floor((now-stateSince)/1000))):'';
    if(!since&&detailMatches&&/^\d+:\d{2}:\d{2}$/.test(detail.since||''))
      since=hms(metrics.seconds(detail.since)+Math.max(0,Math.floor((now-detail.at)/1000)));
    const reason=state==='PAUSE'?(open&&eventStateMatches?open.reason:row?.PauseReason||row?.pauseReason||row?.AuxReason||row?.BreakReason||(detailMatches?detail.reason:'')||''):'';
    return {agentId:id,agentName:row?.AgentName||row?.agentName||names.get(id)||id,state,since,reason,
      stateStartedAt:stateSince?new Date(stateSince).toISOString():null,
      checkedAt:new Date(snapshotAt).toISOString(),checkedSecsAgo:Math.max(0,Math.floor((now-snapshotAt)/1000)),
      source:useEvent?'agent-event':'agent-logins',historyIncomplete:state==='PAUSE'&&!open};
  });
  return {status,agentCount:ids.size,fetchedAt:new Date(snapshotAt).toISOString(),
    stale:now-snapshotAt>300000||!!integration?.stale||!!integration?.pending,integration};
}

function ageLive(value, now=Date.now()) {
  const age=Math.max(0,Math.floor((now-Date.parse(value.fetchedAt))/1000));
  return {...value,stale:value.stale||age>300,
    status:(value.status||[]).map(s=>({...s,checkedSecsAgo:age,
      since:s.stateStartedAt?hms(Math.max(0,Math.floor((now-Date.parse(s.stateStartedAt))/1000)))
        :s.since&&value.collectedAt?hms(metrics.seconds(s.since)+Math.max(0,Math.floor((now-value.collectedAt)/1000))):s.since}))};
}
module.exports={reconcileLive,ageLive,stateKey};

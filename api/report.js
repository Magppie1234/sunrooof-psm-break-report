// Agent status comes from the existing shared Ozonetel integration.
// Retained agent events fill the gap between provider status snapshots.
const {redis} = require('./_redis');
const hub = require('../lib/integration-client.cjs');
const {reconcileLive,ageLive,stateKey} = require('../lib/live-state.cjs');
const saved = require('../data/break-details.json');
const names = new Map((saved.records||[]).map(r=>[r.agentId,r.agentName]));
const pause = value => stateKey(value)==='PAUSE';
const local = {snapshot:null,at:0};
function list(result) {return [result.message,result.details,result.data,result.agents].find(Array.isArray);}
async function collect() {
  const date=new Date(Date.now()+330*60000).toISOString().slice(0,10);
  const previous=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const response=await hub.query('/ca_apis/getAgentLogins',{userName:process.env.OZONETEL_USERNAME});
  const rows=list(response.j);
  if(response.http!==200||String(response.j.status).toLowerCase()!=='success'||!rows)
    throw Error('Current Ozonetel status is not available yet.');
  const sampledAt=response.j.integration?.sampledAt;
  if(!Number.isFinite(Number(sampledAt))||!sampledAt)throw Error('Ozonetel status has no verified sample time.');
  const details=new Map();
  for(const row of rows.filter(x=>pause(x.AgentState||x.State)).slice(0,3)) {
    const id=String(row.AgentId||row.AgentID||row.agentId||'');
    if(!id)continue;
    const response=await hub.query('/ca_apis/AgentDetails',{userName:process.env.OZONETEL_USERNAME,agentId:id}).catch(()=>null);
    const detail=response&&list(response.j)?.[0];
    if(detail&&response.j.integration?.sampledAt)details.set(id,{state:detail.State||detail.AgentState,
      since:detail.Since||'',reason:detail.PauseReason||detail.AuxReason||detail.StateReason||detail.BreakReason||'',
      at:response.j.integration.sampledAt*1000});
  }
  let events=[],historyUnavailable=false;
  try {
    const days=await Promise.all([redis(['ZRANGE','break:events:'+previous,0,-1]),redis(['ZRANGE','break:events:'+date,0,-1])]);
    events=days.flat().map(value=>{try{return JSON.parse(value);}catch{return null;}}).filter(Boolean);
  } catch {historyUnavailable=true;}
  const roster=new Map(names);
  for(const id of String(process.env.OZONETEL_AGENT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))if(!roster.has(id))roster.set(id,id);
  const snapshot=reconcileLive({rows,sampledAt,events,names:roster,details,integration:response.j.integration});
  if(historyUnavailable)snapshot.warning='Agent status is available; retained break history could not be checked.';
  return snapshot;
}
async function liveData() {
  let cached=null;
  try {const value=await redis(['GET','break:live-status']);if(value)cached=JSON.parse(value);}catch{}
  if(cached?.version===2&&Date.now()-cached.collectedAt<50000){hub.observe(cached.integration);return ageLive(cached);}
  if(local.snapshot&&Date.now()-local.at<50000){hub.observe(local.snapshot.integration);return ageLive(local.snapshot);}
  const lock=String(Date.now())+'-'+Math.random().toString(36).slice(2);
  let locked=false;
  try {locked=!!await redis(['SET','break:live-lock',lock,'NX','EX',30]);}catch{}
  if(!locked&&cached?.version===2){hub.observe(cached.integration);return {...ageLive(cached),stale:true,warning:'Waiting for the next Ozonetel status check.'};}
  try {
    const snapshot={...await collect(),version:2,collectedAt:Date.now()};
    local.snapshot=snapshot;local.at=Date.now();
    try {await redis(['SET','break:live-status',JSON.stringify(snapshot),'EX',900]);}catch{}
    return snapshot;
  } catch(error) {
    if(cached?.version===2){hub.observe(cached.integration);return {...ageLive(cached),stale:true,warning:'Ozonetel status is delayed; showing the last checked state.'};}
    throw error;
  } finally {
    if(locked)try {await redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,'break:live-lock',lock]);}catch{}
  }
}
module.exports=hub.wrap(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!hub.configured()||!process.env.OZONETEL_USERNAME)return res.status(503).json({ok:false,error:'The shared reporting connection is unavailable.'});
  const url=new URL(req.url,'https://dashboard.local'),view=url.searchParams.get('view');
  if(url.searchParams.has('raw')||url.searchParams.has('demo')||view&&view!=='live')return res.status(404).json({ok:false,error:'Report view unavailable.'});
  const today=new Date(Date.now()+330*60000).toISOString().slice(0,10),date=url.searchParams.get('date')||today;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today)return res.status(400).json({ok:false,error:'Invalid report date.'});
  try {
    if(view==='live') {
      const snapshot=await liveData();
      hub.observe(snapshot.integration);
      const {integration,version,collectedAt,...data}=snapshot;
      return res.status(200).json({ok:true,live:true,date:today,...data});
    }
    const response=await hub.query('/ca_reports/summaryReport',{userName:process.env.OZONETEL_USERNAME,fromDate:date+' 00:00:00',toDate:date+' 23:59:59'});
    const rows=list(response.j);
    if(response.http!==200||!rows)throw Error('The daily summary is not available yet.');
    const {seconds}=require('../break-metrics');
    return res.status(200).json({ok:true,date,integration:response.j.integration,
      fetchedAt:new Date(response.j.integration.sampledAt*1000).toISOString(),rows:rows.map(r=>({
        agentId:String(r.AgentUniqueID||r.agentId||r.AgentID||r.AgentIncrID||''),
        agentName:String(r.AgentName||r.agentName||''),pause:seconds(r.TotalPauseTime||r.pauseDuration)}))});
  } catch {return res.status(503).json({ok:false,error:'Ozonetel data could not be verified. Please retry shortly.'});}
});

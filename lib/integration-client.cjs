// Server-only shared integration adapter. No provider token/key or direct fallback.
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
const configured=()=>!!process.env.PSM_INTEGRATION_URL && !!process.env.PSM_INTEGRATION_KEY;
function observe(meta) { if(meta) context.getStore()?.push(meta); }
async function query(path,body) {
  if(!configured()) throw Error('Shared reporting integration is not configured.');
  const base=new URL(process.env.PSM_INTEGRATION_URL);
  if(base.protocol!=='https:' || base.username || base.password) throw Error('Invalid integration URL');
  const endpoint=new URL('/api/integration/query',base);
  let page=0, version, rows=[], first, began=Date.now();
  do {
    if(Date.now()-began>22000) throw Error('Shared report refresh is still pending; saved records remain available.');
    const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{Authorization:'Bearer '+process.env.PSM_INTEGRATION_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({path,body,page,version})});
    const text=await response.text();
    if(text.length>1100000) throw Error('Shared report page exceeds the response bound');
    const data=JSON.parse(text);
    observe(data.integration || {complete:false,pending:response.status===202});
    if(response.status!==200 || data.integration?.complete!==true)
      return {http:response.status===202?503:response.status,j:{status:'pending',message:data.message||data.error||'Shared report collection pending',integration:data.integration}};
    if(path!=='/ca_reports/fetchCDRDetails') return {http:200,j:data};
    if(!Array.isArray(data.details)) throw Error('Shared CDR page is incomplete');
    if(typeof data.integration.version!=='string' || !data.integration.version) throw Error('Shared CDR version missing');
    if(version && version!==data.integration.version) throw Error('Shared CDR snapshot changed during pagination');
    first=first||data;version=data.integration.version;rows.push(...data.details);
    const previous=page;page=data.integration.nextPage;
    if(page!==null && page<=previous) throw Error('Shared CDR cursor did not advance');
    if(page!==null && (!Number.isInteger(page)||page<1||page>1000)) throw Error('Invalid shared report cursor');
  } while(page!==null);
  return {http:200,j:{...first,details:rows,integration:{...first.integration,page:0,nextPage:null}}};
}
function wrap(handler) {
  return (req,res)=>context.run([],async()=>{
    const original=res.json.bind(res);
    res.json=value=>{
      const samples=[...(context.getStore()||[]),...(value?.integration?[value.integration]:[])];
      if(value && typeof value==='object') {
        const times=samples.map(x=>Number(x.sampledAt)).filter(Number.isFinite);
        const oldest=times.length?Math.min(...times):null;
        const stale=!!value.stale || samples.some(x=>x.stale||x.pending||!x.complete);
        const loading=value.ok===false && samples.some(x=>x.pending && x.complete===false);
        value={...value,sharedIntegration:{source:'shared-ozonetel',oldestSampleAt:oldest?new Date(oldest*1000).toISOString():null,
          pending:stale,complete:!loading && value.ok!==false,reportRefreshSeconds:300,retryAfterSeconds:30}};
        if(loading){
          res.status(202);res.setHeader('Retry-After','30');
          value={ok:false,pending:true,message:'Collecting this report. It will refresh automatically.',retryAfterSeconds:30,sharedIntegration:value.sharedIntegration};
        } else if(stale) value={...value,stale:true,warning:value.warning||'Showing the last collected report while a refresh is queued.'};
        // Never cache pending/partial snapshots at the CDN as completed history.
        if(stale || value.ok===false)res.setHeader('Cache-Control','no-store');
      }
      return original(value);
    };
    return handler(req,res);
  });
}
module.exports={query,wrap,configured,observe};

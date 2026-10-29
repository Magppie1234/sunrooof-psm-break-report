const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const now=Date.parse('2026-10-29T07:00:00Z');
class Clock extends Date {static now(){return now;}}
function load(file,imports,env={}){
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{
    module,URL,Date:Clock,Map,Set,Buffer,Math,process:{env},
    require:name=>name in imports?imports[name]:require(name),
  });return module.exports;
}
async function run(handler,req){
  let status,body;const headers={};
  await handler(req,{setHeader(k,v){headers[k]=v;},status(code){status=code;return this;},json(value){body=value;}});
  return {status,body,headers};
}
test('history API returns quality markers and never writes to retained history',async()=>{
  const operations=[];
  const redis=async command=>{
    operations.push(command);
    if(command[0]==='ZRANGE'&&command[1]==='break:events:2026-10-29')return [JSON.stringify({agentId:'A',action:'pause',at:'2026-10-29T06:00:00Z',eventData:'Lunch Break'})];
    if(command[0]==='GET'&&command[1]==='break:live-status')return JSON.stringify({fetchedAt:'2026-10-29T06:59:00Z',status:[{agentId:'A',state:'READY'}]});
    return command[0]==='ZRANGE'?[]:null;
  };
  const handler=load('api/today-breaks.js',{'./_redis':{redis},'../lib/break-history.cjs':require('../lib/break-history.cjs')});
  const result=await run(handler,{method:'GET',query:{date:'2026-10-29'}});
  assert.equal(result.status,200);
  assert.equal(result.body.agents[0].incomplete,true);
  assert.equal(result.body.agents[0].breaks[0].countedSeconds,0);
  assert.equal(result.headers['Cache-Control'],'no-store');
  assert.ok(operations.every(c=>['GET','ZRANGE'].includes(c[0])));
});
test('live API uses the shared service and event times; cached reads do not refetch provider',async()=>{
  let queries=0;const store=new Map();
  const pause={agentId:'A',action:'pause',at:'2026-10-29T06:59:00Z',eventData:'Lunch Break'};
  const redis=async command=>{
    const [action,key,value]=command;
    if(action==='GET')return store.get(key)||null;
    if(action==='ZRANGE')return key.endsWith('2026-10-29')?[JSON.stringify(pause)]:[];
    if(action==='SET'){store.set(key,value);return 'OK';}
    if(action==='EVAL'){store.delete('break:live-lock');return 1;}
  };
  const hub={configured:()=>true,wrap:handler=>handler,observe(){},query:async endpoint=>{
    queries++;assert.equal(endpoint,'/ca_apis/getAgentLogins');
    return {http:200,j:{status:'success',message:[{AgentId:'A',AgentName:'Agent',AgentState:'READY'}],
      integration:{complete:true,sampledAt:Date.parse('2026-10-29T06:58:00Z')/1000}}};
  }};
  const reconcile=require('../lib/live-state.cjs');
  const handler=load('api/report.js',{'./_redis':{redis},'../lib/integration-client.cjs':hub,
    '../lib/live-state.cjs':{...reconcile,reconcileLive:options=>reconcile.reconcileLive({...options,now})},
    '../data/break-details.json':{records:[]}}, {OZONETEL_USERNAME:'test-user'});
  const first=await run(handler,{url:'/api/report?view=live'});
  assert.equal(first.status,200);
  assert.equal(first.body.status[0].state,'PAUSE');
  assert.equal(first.body.status[0].reason,'Lunch Break');
  assert.equal(first.body.status[0].stateStartedAt,pause.at.replace('Z','.000Z'));
  assert.equal(first.headers['Cache-Control'],'no-store');
  await run(handler,{url:'/api/report?view=live'});
  assert.equal(queries,1);
});
test('webhook keeps explicit UTC and local IST times on the correct date',async()=>{
  for(const eventTime of ['2026-10-28T23:40:00Z','2026-10-29 05:10:00']){
    const writes=[];
    const handler=load('api/agent-event.js',{'./_redis':{redis:async c=>{writes.push(c);return 1;}}},
      {OZONETEL_WEBHOOK_SECRET:'test-secret',OZONETEL_USERNAME:'test-user'});
    const result=await run(handler,{method:'POST',query:{key:'test-secret'},body:{eventType:'Agent',username:'test-user',
      data:{agentId:'A',action:'pause',event_time:eventTime,eventData:'Lunch Break'}}});
    assert.equal(result.status,200);
    assert.equal(writes[0][1],'break:events:2026-10-29');
    assert.equal(JSON.parse(writes[0][4]).at,'2026-10-28T23:40:00.000Z');
    assert.equal(writes[1][0],'PERSIST');
  }
});

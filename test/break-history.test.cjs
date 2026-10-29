const {test}=require('node:test');
const assert=require('node:assert/strict');
const metrics=require('../break-metrics');
const {buildHistory}=require('../lib/break-history.cjs');
const {reconcileLive,ageLive}=require('../lib/live-state.cjs');
const date='2026-10-28',now=Date.parse('2026-10-29T06:00:00Z');
const at=time=>date+'T'+time+'+05:30';
const event=(action,time,reason='',agentId='A')=>({agentId,action,at:at(time),eventData:reason});
const build=(events,options={})=>buildHistory({date,events,now,...options});

test('system events never count as named breaks, including refresh and reconnect',()=>{
  for(const reason of ['refresh','reconnect','changeMode','SIP disconnected','agentBrowserRefresh']){
    assert.equal(metrics.isSystem(reason),true);
    assert.equal(metrics.isNamed(reason),false);
  }
  assert.equal(metrics.isNamed('Reason unavailable'),false);
  assert.equal(metrics.isNamed('Lunch Break'),true);
  assert.equal(metrics.reasonOf({eventData:'Lunch Break',miscDetails:'reconnect'}),'Lunch Break');
});
test('same-reason pause notifications and reconnects retain one actual break',()=>{
  const history=build([event('pause','12:00:00','Lunch Break'),event('pause','12:02:00','Lunch Break'),event('release','12:30:00')]);
  assert.equal(history.agents[0].breaks.length,1);
  assert.equal(history.agents[0].breaks[0].countedSeconds,1800);
});
test('reason changes split a break; unrelated notifications cannot end it',()=>{
  const history=build([event('pause','12:00:00','Lunch Break'),event('notification','12:01:00'),
    event('pause','12:20:00','Rest Room'),event('release','12:30:00')]);
  assert.deepEqual(history.agents[0].breaks.map(b=>[b.reason,b.countedSeconds]),[['Lunch Break',1200],['Rest Room',600]]);
});
test('duplicates and future/invalid events cannot inflate count or duration',()=>{
  const pause=event('pause','12:00:00','Lunch Break');
  const history=build([pause,{...pause},event('release','12:20:00'),{...pause,at:'invalid'},
    {...pause,at:'2027-10-29T00:00:00Z'}]);
  assert.equal(history.agents[0].breaks.length,1);
  assert.equal(history.agents[0].breaks[0].countedSeconds,1200);
});
test('another agent’s saved cutoff never removes a genuine event break',()=>{
  const history=build([event('pause','10:10:00','Rest Room','B'),event('release','10:20:00','','B')],
    {seed:{rows:[{agentId:'A',reason:'Lunch Break',start:at('10:00:00'),end:at('10:30:00')}]}});
  assert.equal(history.agents.find(a=>a.agentId==='B').breaks[0].countedSeconds,600);
  assert.equal(history.agents.find(a=>a.agentId==='A').breaks[0].countedSeconds,1800);
});
test('a provider baseline and overlapping event are not counted twice',()=>{
  const history=build([event('pause','10:00:00','Lunch Break'),event('release','10:30:00')],
    {seed:{rows:[{agentId:'A',reason:'Lunch Break',start:at('10:10:00'),end:at('10:30:00')}]}});
  assert.equal(history.agents[0].breaks.length,1);
  assert.equal(history.agents[0].breaks[0].countedSeconds,1800);
});
test('past breaks without end times remain incomplete and do not accumulate overnight',()=>{
  const history=build([event('pause','17:00:00','Lunch Break')]);
  assert.equal(history.agents[0].breaks[0].incomplete,true);
  assert.equal(history.agents[0].breaks[0].countedSeconds,0);
  assert.deepEqual(history.coverage.incompleteAgents,['A']);
});
test('current status cannot silently turn a missing release event into a growing break',()=>{
  const history=build([event('pause','12:00:00','Lunch Break')],{now:Date.parse(at('13:00:00')),
    statuses:[{agentId:'A',state:'READY'}],statusAt:at('12:59:00')});
  assert.equal(history.agents[0].breaks[0].incomplete,true);
  assert.equal(history.agents[0].breaks[0].countedSeconds,0);
});
test('a paused agent with no start event is explicitly marked incomplete',()=>{
  const history=build([],{now:Date.parse(at('13:00:00')),statuses:[{agentId:'A',state:'Pause'}],statusAt:at('12:59:00')});
  assert.equal(history.agents[0].incomplete,true);
  assert.equal(history.agents[0].breaks.length,0);
});
test('a break crossing midnight is clipped to the selected day',()=>{
  const history=build([{agentId:'A',action:'pause',at:'2026-10-27T23:50:00+05:30',eventData:'Lunch Break'},event('release','00:10:00')]);
  assert.equal(history.agents[0].breaks[0].countedSeconds,600);
  assert.equal(history.agents[0].breaks[0].carriedOver,true);
});
test('explicit timezone offsets and local IST timestamps identify the same instant',()=>{
  assert.equal(metrics.stamp('2026-10-28 12:00:00'),Date.parse('2026-10-28T06:30:00Z'));
  assert.equal(metrics.stamp('2026-10-28T06:30:00Z'),Date.parse('2026-10-28T06:30:00Z'));
});
test('newer events override an older provider snapshot, preserving exact AUX time',()=>{
  const live=reconcileLive({rows:[{AgentId:'A',AgentState:'READY'}],sampledAt:Date.parse(at('11:59:00'))/1000,
    events:[event('pause','12:00:00','Lunch Break')],now:Date.parse(at('12:05:00'))});
  assert.equal(live.status[0].state,'PAUSE');
  assert.equal(live.status[0].reason,'Lunch Break');
  assert.equal(live.status[0].stateStartedAt,new Date(at('12:00:00')).toISOString());
  assert.equal(live.status[0].since,'0:05:00');
});
test('a previous state’s AgentDetails duration is never shown as the current AUX duration',()=>{
  const live=reconcileLive({rows:[{AgentId:'A',AgentState:'Pause'}],sampledAt:Date.parse(at('12:05:00'))/1000,
    events:[],details:new Map([['A',{state:'LOGOUT',since:'01:44:12',at:Date.parse(at('12:05:00'))}]]),now:Date.parse(at('12:05:00'))});
  assert.equal(live.status[0].since,'');
  assert.equal(live.status[0].historyIncomplete,true);
});
test('cached status preserves the original sample age and advances elapsed time',()=>{
  const timestamp=Date.parse(at('12:00:00'));
  const live=ageLive({fetchedAt:new Date(timestamp).toISOString(),collectedAt:timestamp,status:[{since:'0:01:00'}]},timestamp+360000);
  assert.equal(live.stale,true);
  assert.equal(live.status[0].checkedSecsAgo,360);
  assert.equal(live.status[0].since,'0:07:00');
});

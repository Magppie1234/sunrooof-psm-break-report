const metrics=require('../break-metrics');
// Ozonetel's TotalPauseTime includes named pauses and SIP disconnections, but
// not toolbar mode changes/refresh bookkeeping. Compare like-for-like totals.
function verifyHistory(history,summaryRows) {
  const totals=new Map();
  for(const row of summaryRows) {
    const id=String(row.AgentUniqueID||row.agentId||row.AgentID||row.AgentIncrID||'');
    if(id)totals.set(id,(totals.get(id)||0)+metrics.seconds(row.TotalPauseTime??row.pauseDuration??row.pause));
  }
  const ids=new Set([...totals.keys(),...history.agents.map(a=>a.agentId)]),mismatches=[];
  for(const id of ids) {
    const agent=history.agents.find(a=>a.agentId===id);
    const recorded=(agent?.breaks||[]).filter(b=>metrics.isNamed(b.reason)||/^sipdisconnect(ed)?$/.test(metrics.key(b.reason)))
      .reduce((n,b)=>n+(b.countedSeconds||0),0);
    const reported=totals.get(id);
    if(reported==null||recorded!==reported) {
      mismatches.push(id);
      if(agent) {agent.incomplete=true;agent.reportedPauseSeconds=reported??null;agent.recordedPauseSeconds=recorded;}
      else history.agents.push({agentId:id,breaks:[],incomplete:true,reportedPauseSeconds:reported,recordedPauseSeconds:0});
    }
  }
  history.coverage.pauseTotalsMatched=!mismatches.length;
  history.coverage.incompleteAgents=[...new Set([...history.coverage.incompleteAgents,...mismatches])];
  return history;
}
module.exports={verifyHistory};

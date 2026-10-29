async function health(req,res) {
 res.setHeader('Cache-Control','no-store');
 if(!process.env.PSM_INTEGRATION_URL||!process.env.PSM_INTEGRATION_KEY) return res.status(503).json({ok:false,configured:false});
 try {
  const base=new URL(process.env.PSM_INTEGRATION_URL);
  if(base.protocol!=='https:')throw Error();
  const r=await fetch(new URL('/api/integration/check',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+process.env.PSM_INTEGRATION_KEY,'Content-Type':'application/json'},body:JSON.stringify({account:process.env.OZONETEL_USERNAME||'sunrooof'})});
  const data=await r.json();
  return res.status(r.ok&&data.accountAligned?200:503).json({ok:!!(r.ok&&data.accountAligned),configured:true,accountAligned:!!data.accountAligned,providerRequests:0});
 }catch{return res.status(503).json({ok:false,configured:true,connectionAvailable:false});}
}
module.exports=health;

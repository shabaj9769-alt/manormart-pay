const { db, admin, cors, parseBody, requireAdmin, safeError } = require('../lib/common');
module.exports=async function(req,res){
 cors(req,res,'GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.status(204).end();
 try{
  if(req.method==='GET'){
   if(!await requireAdmin(req,res)) return;
   const boys=(await db.ref('deliveryBoys').once('value')).val()||{}; const out={};
   for(const [k,v] of Object.entries(boys)){ const {secretCode,...safe}=v||{}; out[k]=safe; }
   return res.status(200).json(out);
  }
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const {action,boyId,phone,secretCode,pushToken,boyData}=parseBody(req);
  if(action==='boyLogin'){
   if(!phone||!secretCode) return res.status(400).json({error:'Phone and secret code required'});
   const boys=(await db.ref('deliveryBoys').once('value')).val()||{};
   const pair=Object.entries(boys).find(([,b])=>String(b?.phone||'').trim()===String(phone).trim() && String(b?.secretCode||'').trim()===String(secretCode).trim());
   if(!pair) return res.status(401).json({error:'Invalid phone number or secret code'});
   const [key,boy]=pair; const {secretCode:_,...safeBoyData}=boy;
   if(!process.env.FIREBASE_WEB_API_KEY){
    console.error('delivery-partners: FIREBASE_WEB_API_KEY env variable is missing');
    return res.status(500).json({error:'Server is not configured yet.'});
   }
   // A Firebase custom token (from createCustomToken) can't be checked with
   // verifyIdToken - it has to be exchanged for a real ID token first, the same
   // way admin-login.js does it. Returning the raw custom token meant every
   // delivery-boy-authenticated request (like updateBoyPushToken) would fail.
   let idToken=null, refreshToken=null;
   try{
    const customToken=await admin.auth().createCustomToken(`delivery-${key}`,{deliveryBoy:true,boyKey:key});
    const r=await fetch(
     `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.FIREBASE_WEB_API_KEY}`,
     {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:customToken,returnSecureToken:true})}
    );
    const d=await r.json().catch(()=>({}));
    if(r.ok && d.idToken){ idToken=d.idToken; refreshToken=d.refreshToken||null; }
    else console.error('delivery-partners: token exchange failed:', r.status, JSON.stringify(d.error||d));
   }catch(e){ console.error('delivery token error',e); }
   if(!idToken) return res.status(500).json({error:'Login service error. Please try again.'});
   return res.status(200).json({success:true,boyKey:key,boy:safeBoyData,idToken,refreshToken});
  }
  if(action==='updateBoyPushToken' && boyId && pushToken){
   const decoded=await requireDeliveryBoy(req,res,boyId); if(!decoded) return;
   await db.ref(`deliveryBoys/${boyId}/pushToken`).set(String(pushToken).slice(0,4096)); return res.status(200).json({success:true});
  }
  if(!await requireAdmin(req,res)) return;
  if(action==='saveBoy'&&boyId&&boyData&&typeof boyData==='object'){await db.ref(`deliveryBoys/${boyId}`).update(boyData);return res.status(200).json({success:true});}
  if(action==='deleteBoy'&&boyId){await db.ref(`deliveryBoys/${boyId}`).remove();return res.status(200).json({success:true});}
  return res.status(400).json({error:'Invalid action or missing parameters'});
 }catch(e){return safeError(res,500,'Delivery-partner operation failed.',e);}
};
async function requireDeliveryBoy(req,res,boyId){
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/,'').trim(); if(!token){res.status(401).json({error:'Unauthorized.'});return null;}
 try{const d=await admin.auth().verifyIdToken(token,true); if(d.deliveryBoy!==true||String(d.boyKey)!==String(boyId)){res.status(403).json({error:'Forbidden.'});return null;} return d;}catch{res.status(401).json({error:'Invalid session.'});return null;}
}

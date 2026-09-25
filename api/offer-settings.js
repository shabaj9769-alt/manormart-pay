const { db, cors, parseBody, requireAdmin, safeError } = require('../lib/common');
module.exports=async function(req,res){
 cors(req,res,'GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.status(204).end();
 try{
  if(req.method==='GET') return res.status(200).json((await db.ref('offerSettings').once('value')).val()||{});
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  if(!await requireAdmin(req,res)) return;
  const {action,offerData,offerId}=parseBody(req);
  if(action==='saveAll' && offerData && typeof offerData==='object') await db.ref('offerSettings').set(offerData);
  else if(action==='updateOffer' && offerId && offerData && typeof offerData==='object') await db.ref(`offerSettings/${String(offerId).replace(/[.#$\[\]/]/g,'')}`).set(offerData);
  else if(action==='deleteOffer' && offerId) await db.ref(`offerSettings/${String(offerId).replace(/[.#$\[\]/]/g,'')}`).remove();
  else return res.status(400).json({error:'Invalid action.'});
  return res.status(200).json({success:true});
 }catch(e){return safeError(res,500,'Offer operation failed.',e);}
};

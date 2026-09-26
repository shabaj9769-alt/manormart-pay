const { db, cors, parseBody, requireAdmin, safeError } = require('../lib/common');
module.exports=async function(req,res){
  cors(req,res,'GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.status(204).end();
  try{
    if(req.method==='GET') return res.status(200).json((await db.ref('deliveryAreas').once('value')).val()||{});
    if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
    if(!await requireAdmin(req,res)) return;
    const {action,areaId,areaData,allAreas}=parseBody(req);
    if(action==='saveAll' && allAreas && typeof allAreas==='object'){await db.ref('deliveryAreas').set(allAreas);return res.status(200).json({success:true,message:'All delivery areas updated'});}
    if(action==='updateArea' && areaId && areaData && typeof areaData==='object'){await db.ref(`deliveryAreas/${String(areaId).replace(/[.#$\[\]/]/g,'')}`).set(areaData);return res.status(200).json({success:true,message:'Area updated successfully'});}
    if(action==='deleteArea' && areaId){await db.ref(`deliveryAreas/${String(areaId).replace(/[.#$\[\]/]/g,'')}`).remove();return res.status(200).json({success:true,message:'Area deleted successfully'});}
    return res.status(400).json({error:'Invalid action or data.'});
  }catch(e){return safeError(res,500,'Delivery-area operation failed.',e);}
};

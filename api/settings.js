const { db, cors, parseBody, requireAdmin, safeError } = require('../lib/common');
const PUBLIC_KEYS = ['storeStatus','hubLat','hubLng','radiusKm','normCharge','expCharge','freeDel','upi','minOrder','minimumOrder','deliveryCharge','expressCharge'];
function publicSettings(s) { const out = {}; for (const k of PUBLIC_KEYS) if (Object.prototype.hasOwnProperty.call(s,k)) out[k]=s[k]; return out; }
module.exports = async function handler(req,res){
  cors(req,res,'GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.status(204).end();
  try {
    if(req.method==='GET'){ const s=(await db.ref('settings').once('value')).val()||{}; return res.status(200).json(publicSettings(s)); }
    if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
    if(!await requireAdmin(req,res)) return;
    const {action,settingsData}=parseBody(req); if(!settingsData||typeof settingsData!=='object') return res.status(400).json({error:'Invalid settings.'});
    if(action==='updateSettings') await db.ref('settings').update(settingsData); else if(action==='saveAll') await db.ref('settings').set(settingsData); else return res.status(400).json({error:'Invalid action.'});
    return res.status(200).json({success:true});
  }catch(e){return safeError(res,500,'Settings operation failed.',e);}
};

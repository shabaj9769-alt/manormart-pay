const crypto = require('crypto');
const { db, admin } = require('./common');

function secret() {
  const s = String(process.env.CUSTOMER_SESSION_SECRET || '').trim();
  if (s.length < 32) throw new Error('CUSTOMER_SESSION_SECRET must be at least 32 characters');
  return s;
}
function b64(v){ return Buffer.from(v).toString('base64url'); }
function unb64(v){ return Buffer.from(v,'base64url').toString('utf8'); }
function sign(payload){
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}
function createCustomerSession(phone){
  const body = b64(JSON.stringify({ sub:String(phone), typ:'customer', iat:Date.now() }));
  return `${body}.${sign(body)}`;
}
function verifyCustomerSession(req){
  const h=String(req.headers.authorization||'');
  const token=h.startsWith('Bearer ')?h.slice(7).trim():'';
  if(!token) return null;
  const parts=token.split('.'); if(parts.length!==2) return null;
  const [body,sig]=parts;
  const expected=sign(body);
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try{
    const p=JSON.parse(unb64(body));
    if(p.typ!=='customer'||!/^\d{10}$/.test(String(p.sub))||!p.iat) return null;
    const age=Date.now()-Number(p.iat);
    if(age<0 || age>30*24*60*60*1000) return null;
    return { phone:String(p.sub), session:true };
  }catch{return null;}
}
function hashPassword(password){
  const p=String(password||'');
  if(p.length<8 || p.length>128) throw new Error('Password must be 8-128 characters.');
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(p,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex');
  return `scrypt$16384$8$1$${salt}$${hash}`;
}
function verifyPassword(password, encoded){
  try{
    const [alg,n,r,p,salt,hex]=String(encoded||'').split('$');
    if(alg!=='scrypt'||!salt||!hex)return false;
    const derived=crypto.scryptSync(String(password||''),salt,64,{N:Number(n),r:Number(r),p:Number(p),maxmem:32*1024*1024});
    const stored=Buffer.from(hex,'hex');
    return stored.length===derived.length && crypto.timingSafeEqual(stored,derived);
  }catch{return false;}
}
async function loginCustomer(phone,password){
  const snap=await db.ref(`customers/${phone}`).once('value');
  const c=snap.val()||{};
  if(!c.passwordHash) return {ok:false, code:'PASSWORD_NOT_SET'};
  if(!verifyPassword(password,c.passwordHash)) return {ok:false, code:'INVALID_CREDENTIALS'};
  return {ok:true, token:createCustomerSession(phone), customer:{name:c.name||'',addr:c.addr||'',addresses:Array.isArray(c.addresses)?c.addresses:[]}};
}
module.exports={hashPassword,verifyPassword,createCustomerSession,verifyCustomerSession,loginCustomer};

// Shared helpers for ManorMart Vercel APIs.
const admin = require('firebase-admin');
const crypto = require('crypto');

function loadServiceAccount() {
  const candidates = ['FIREBASE_SERVICE_ACCOUNT', 'FIRE_JSON', 'FIREBASE_SERVICE_ACCOUNT_JSON'];
  const name = candidates.find((k) => process.env[k]) || Object.keys(process.env).find((k) => /^FIRE.*JSON$/i.test(k));
  if (!name) throw new Error('Firebase service account env variable not found');
  let raw = String(process.env[name]).trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  if (typeof sa.private_key === 'string') sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    databaseURL: process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || 'https://manorbiryani-default-rtdb.firebaseio.com'
  });
}
const db = admin.database();

const ORDER_ID_RE = /^ord_\d{10,16}_\d{1,3}$/;
const isValidOrderId = (id) => typeof id === 'string' && ORDER_ID_RE.test(id);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function userError(message) { const e = new Error(message); e.userFacing = true; return e; }

function cors(req, res, methods = 'GET,POST,OPTIONS', allowAuth = true) {
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://shabaj9769-alt.github.io').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', allowAuth ? 'Content-Type, Authorization' : 'Content-Type');
}

function parseBody(req) {
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body && typeof body === 'object' ? body : {};
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function verifyFirebaseToken(req) {
  const token = bearer(req);
  if (!token) return null;
  try { return await admin.auth().verifyIdToken(token, true); }
  catch { return null; }
}

async function requireAdmin(req, res) {
  const decoded = await verifyFirebaseToken(req);
  if (!decoded || decoded.admin !== true) {
    res.status(401).json({ error: 'Unauthorized.' });
    return null;
  }
  return decoded;
}

function normalizePhone(p) { return String(p || '').replace(/[^0-9]/g, '').trim(); }
async function requireCustomerForPhone(req, res, phone) {
  const wanted = normalizePhone(phone);
  if (wanted.length !== 10) { res.status(403).json({ error: 'Customer authentication required.' }); return null; }
  const { verifyCustomerSession } = require('./customer-auth');
  const session = verifyCustomerSession(req);
  if (session && session.phone === wanted) return session;
  const decoded = await verifyFirebaseToken(req);
  const ids = decoded ? [decoded.phone_number, decoded.phone, decoded.customerPhone].filter(Boolean).map(normalizePhone) : [];
  if (!decoded || !ids.includes(wanted)) {
    res.status(403).json({ error: 'Customer authentication required.' });
    return null;
  }
  return decoded;
}

function safeError(res, status, publicMessage, err) {
  if (err) console.error(publicMessage, err);
  return res.status(status).json({ error: publicMessage });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function rzp(method, path, body) {
  const auth = Buffer.from(`${process.env.RZP_KEY_ID}:${process.env.RZP_KEY_SECRET}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function computeServerTotal(order) {
  const [catsSnap, setSnap] = await Promise.all([db.ref('categories').once('value'), db.ref('settings').once('value')]);
  const cats = catsSnap.val() || {}; const st = setSnap.val() || {};
  const items = Object.values(order.items || {});
  if (!items.length) throw userError('Order has no items.');
  let sub = 0;
  for (const it of items) {
    let live = cats[it.catName] && typeof cats[it.catName] === 'object' ? cats[it.catName][it.id] : null;
    if (!live || !live.name) for (const c of Object.keys(cats)) {
      const cand = cats[c] && typeof cats[c] === 'object' ? cats[c][it.id] : null;
      if (cand && cand.name) { live = cand; break; }
    }
    if (!live || !live.name) throw userError(`"${it.name || 'Item'}" is no longer available.`);
    if (live.inStock === false || live.status === 'sold') throw userError(`"${live.name}" is out of stock.`);
    const qty = Math.floor(Number(it.qty));
    if (!(qty > 0 && qty <= 100)) throw userError('Invalid item quantity.');
    const eff = Number(live.price || 0) - Number(live.discount || 0);
    if (!(eff > 0)) throw userError(`"${live.name}" has an invalid price.`);
    sub += eff * qty;
  }
  sub = round2(sub);
  const freeDel = Number(st.freeDel || 0), norm = Number(st.normCharge || 0), exp = Number(st.expCharge || 30);
  let fee = freeDel > 0 && sub >= freeDel ? 0 : norm;
  if (order.deliveryType === 'Express') fee += exp;
  return { subtotal: sub, deliveryFee: fee, total: round2(sub + fee) };
}

async function markPaid(orderId, paymentId, amountRupees) {
  const ref = db.ref(`orders/${orderId}`);
  return ref.transaction((cur) => {
    if (!cur) return cur;
    if (cur.paymentVerified === true) {
      if (cur.razorpayPaymentId === paymentId) return;
      return { ...cur, duplicatePaymentId: paymentId, needsRefund: true };
    }
    const cancelled = String(cur.deliveryStatus || '').includes('Cancelled');
    return { ...cur, paymentVerified: true, razorpayPaymentId: paymentId, paidAmount: amountRupees, paidAt: Date.now(), ...(cancelled ? { needsRefund: true } : { deliveryStatus: 'Order Successful' }) };
  });
}

module.exports = { admin, db, isValidOrderId, round2, userError, cors, parseBody, bearer, verifyFirebaseToken, requireAdmin, requireCustomerForPhone, normalizePhone, safeError, safeEqual, rzp, computeServerTotal, markPaid };

// Shared helpers for all payment API routes
const admin = require('firebase-admin');
const crypto = require('crypto');

// Reads the Firebase service-account JSON from Vercel env. Accepts FIREBASE_SERVICE_ACCOUNT,
// or any variable named FIRE...JSON (e.g. FIREBASE_SERVICE_ACCOUNT_JSON). Plain JSON or base64 both work.
function loadServiceAccount() {
  const name = process.env.FIREBASE_SERVICE_ACCOUNT
    ? 'FIREBASE_SERVICE_ACCOUNT'
    : Object.keys(process.env).find((k) => /^FIRE.*JSON$/i.test(k));
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
    databaseURL: process.env.FIREBASE_DB_URL || 'https://manorbiryani-default-rtdb.firebaseio.com'
  });
}
const db = admin.database();

const ORDER_ID_RE = /^ord_\d{10,16}_\d{1,3}$/;
const isValidOrderId = (id) => typeof id === 'string' && ORDER_ID_RE.test(id);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// Only your pay page may call these APIs from a browser
function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://shabaj9769-alt.github.io').split(',').map(s => s.trim());
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function rzp(method, path, body) {
  const auth = Buffer.from(`${process.env.RZP_KEY_ID}:${process.env.RZP_KEY_SECRET}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// Recomputes the order total from LIVE prices in Firebase (never trusts order.total from the client)
async function computeServerTotal(order) {
  const [catsSnap, setSnap] = await Promise.all([
    db.ref('categories').once('value'),
    db.ref('settings').once('value')
  ]);
  const cats = catsSnap.val() || {};
  const st = setSnap.val() || {};

  const items = Object.values(order.items || {});
  if (items.length === 0) throw userError('Order has no items.');

  let sub = 0;
  for (const it of items) {
    let live = cats[it.catName] && typeof cats[it.catName] === 'object' ? cats[it.catName][it.id] : null;
    if (!live || !live.name) {
      for (const c of Object.keys(cats)) {
        const cand = cats[c] && typeof cats[c] === 'object' ? cats[c][it.id] : null;
        if (cand && cand.name) { live = cand; break; }
      }
    }
    if (!live || !live.name) throw userError(`"${it.name}" is no longer available.`);
    if (live.inStock === false) throw userError(`"${it.name}" is out of stock.`);

    const qty = Math.floor(Number(it.qty));
    if (!(qty > 0 && qty <= 100)) throw userError('Invalid item quantity.');
    const eff = Number(live.price || 0) - Number(live.discount || 0);
    if (!(eff > 0)) throw userError(`"${it.name}" has an invalid price.`);
    sub += eff * qty;
  }
  sub = round2(sub);

  const freeDel = Number(st.freeDel || 0);
  const norm = Number(st.normCharge || 0);
  const exp = Number(st.expCharge || 30);
  let fee = (freeDel > 0 && sub >= freeDel) ? 0 : norm;
  if (order.deliveryType === 'Express') fee += exp;

  return { subtotal: sub, deliveryFee: fee, total: round2(sub + fee) };
}

// Marks an order as paid. Safe to call many times (idempotent). Only the server can write these fields.
async function markPaid(orderId, paymentId, amountRupees) {
  const ref = db.ref(`orders/${orderId}`);
  return ref.transaction((cur) => {
    if (!cur) return cur;
    if (cur.paymentVerified === true) {
      if (cur.razorpayPaymentId === paymentId) return; // already processed -> abort
      return { ...cur, duplicatePaymentId: paymentId, needsRefund: true }; // customer paid twice
    }
    const cancelled = String(cur.deliveryStatus || '').includes('Cancelled');
    return {
      ...cur,
      paymentVerified: true,
      razorpayPaymentId: paymentId,
      paidAmount: amountRupees,
      paidAt: Date.now(),
      ...(cancelled ? { needsRefund: true } : { deliveryStatus: 'Order Successful' })
    };
  });
}

module.exports = { db, isValidOrderId, round2, userError, cors, parseBody, safeEqual, rzp, computeServerTotal, markPaid };

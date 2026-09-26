// Combined payment handlers: verifyPayment, paymentStatus, razorpayWebhook.
// Originally three separate Vercel routes (verify-payment.js,
// payment-status.js, razorpay-webhook.js). You are responsible for wiring
// these to their routes/methods in your own router.
const crypto = require('crypto');
const {
  db,
  isValidOrderId,
  cors,
  parseBody,
  safeEqual,
  markPaid,
  requireCustomerForPhone,
  safeError,
} = require('../lib/common');

// ---------------------------------------------------------------------------
// verifyPayment
// POST { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies Razorpay's signature with the SECRET key, then marks the order
// paid. Fast path (razorpayWebhook below is the safety net).
// ---------------------------------------------------------------------------

async function verifyPayment(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = parseBody(req);
    const orderId = String(b.order_id || '');
    const rzpOrderId = String(b.razorpay_order_id || '');
    const paymentId = String(b.razorpay_payment_id || '');
    const signature = String(b.razorpay_signature || '');
    if (!isValidOrderId(orderId) || !rzpOrderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'Missing or invalid fields.' });
    }

    const expected = crypto
      .createHmac('sha256', process.env.RZP_KEY_SECRET)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');
    if (!safeEqual(signature, expected)) return res.status(400).json({ error: 'Invalid signature.' });

    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order || order.rzpOrderId !== rzpOrderId || !(Number(order.serverTotal) > 0)) {
      return res.status(400).json({ error: 'Payment does not belong to this order.' });
    }
    if (!await requireCustomerForPhone(req, res, order.phone)) return;

    await markPaid(orderId, paymentId, Number(order.serverTotal));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('verifyPayment error:', e);
    return res.status(500).json({ error: 'Server error.' });
  }
}

// ---------------------------------------------------------------------------
// paymentStatus
// GET ?orderId=ord_... -> { paymentVerified: boolean }
// Used only by the payment-confirmation page (index.html) as a safety-net
// poll while it waits for razorpayWebhook to land. Deliberately
// unauthenticated (the checkout page has no customer session token), but it
// only ever reveals one boolean for one order the caller already knows the
// exact id of - it does not leak the rest of the order (name, phone, address,
// items).
// ---------------------------------------------------------------------------

async function paymentStatus(req, res) {
  cors(req, res, 'GET,OPTIONS', false);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const orderId = String(req.query.orderId || '');
    if (!isValidOrderId(orderId)) return res.status(400).json({ error: 'Invalid order id.' });

    const val = (await db.ref(`orders/${orderId}/paymentVerified`).once('value')).val();
    return res.status(200).json({ paymentVerified: val === true });
  } catch (e) {
    return safeError(res, 500, 'Could not check payment status.', e);
  }
}

// ---------------------------------------------------------------------------
// razorpayWebhook
// Razorpay -> your server. Confirms payments even if the customer closes the
// browser mid-way.
//
// NOTE: this handler needs the raw request body for the signature check, so
// whatever router you wire this into must disable body parsing for this
// route (Vercel: module.exports.config = { api: { bodyParser: false } };).
// It also has no CORS handling by design — Razorpay calls it server-to-server.
// ---------------------------------------------------------------------------

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function razorpayWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const raw = await getRawBody(req); // signature must be checked on the RAW body
    const sig = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', process.env.RZP_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!sig || !safeEqual(sig, expected)) return res.status(400).send('bad signature');

    const ev = JSON.parse(raw.toString('utf8'));
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
      const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
      const orderId = pay && pay.notes && pay.notes.order_id;
      if (pay && isValidOrderId(orderId)) {
        const order = (await db.ref(`orders/${orderId}`).once('value')).val();
        const ok = order
          && pay.status === 'captured'
          && pay.order_id === order.rzpOrderId
          && pay.amount === Math.round(Number(order.serverTotal) * 100);
        if (ok) {
          await markPaid(orderId, pay.id, pay.amount / 100);
        } else {
          console.error('razorpayWebhook: payment NOT matched to order:', orderId, pay.id, pay.amount);
        }
      }
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error('razorpayWebhook error:', e);
    return res.status(500).send('error'); // Razorpay will retry
  }
}
// Carried over for reference — apply wherever your router disables body
// parsing for this handler.
razorpayWebhook.needsRawBody = true;

module.exports = { verifyPayment, paymentStatus, razorpayWebhook };

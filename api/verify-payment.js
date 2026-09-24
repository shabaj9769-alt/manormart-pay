// POST { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies Razorpay's signature with the SECRET key, then marks the order paid. Fast path (the webhook is the safety net).
const crypto = require('crypto');
const { db, isValidOrderId, cors, parseBody, safeEqual, markPaid } = require('../lib/common');

module.exports = async (req, res) => {
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

    await markPaid(orderId, paymentId, Number(order.serverTotal));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('verify-payment error:', e);
    return res.status(500).json({ error: 'Server error.' });
  }
};

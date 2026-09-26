// GET ?orderId=ord_... -> { paymentVerified: boolean }
// Used only by the payment-confirmation page (index.html) as a safety-net poll
// while it waits for the Razorpay webhook to land. Deliberately unauthenticated
// (the checkout page has no customer session token), but it only ever reveals
// one boolean for one order the caller already knows the exact id of - it does
// not leak the rest of the order (name, phone, address, items).
const { db, isValidOrderId, cors, safeError } = require('../lib/common');

module.exports = async function handler(req, res) {
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
};

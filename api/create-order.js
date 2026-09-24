// POST { order_id } -> creates a Razorpay order for the amount the SERVER calculates.
const { db, isValidOrderId, round2, cors, parseBody, rzp, computeServerTotal } = require('../lib/common');

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const orderId = String(parseBody(req).order_id || '');
    if (!isValidOrderId(orderId)) return res.status(400).json({ error: 'Invalid order id.' });

    const ref = db.ref(`orders/${orderId}`);
    const order = (await ref.once('value')).val();
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.payment !== 'Online') return res.status(400).json({ error: 'This is not an online-payment order.' });
    if (order.paymentVerified === true) return res.status(409).json({ error: 'This order is already paid.' });
    if (!String(order.deliveryStatus || '').includes('Payment Pending')) {
      return res.status(400).json({ error: 'This order is not awaiting payment.' });
    }
    if (Date.now() - Number(order.timestamp || 0) > 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'This order has expired. Please place a new order.' });
    }

    const { total } = await computeServerTotal(order);
    const paise = Math.round(total * 100);
    if (paise < 100) return res.status(400).json({ error: 'Invalid order amount.' });

    // Reuse the same Razorpay order on retry, so the customer can never end up paying twice
    let rzpOrder = null;
    if (order.rzpOrderId) {
      const ex = await rzp('GET', `/orders/${order.rzpOrderId}`);
      if (ex.ok && ex.data.status !== 'paid' && ex.data.amount === paise) rzpOrder = ex.data;
    }
    if (!rzpOrder) {
      const created = await rzp('POST', '/orders', {
        amount: paise,
        currency: 'INR',
        receipt: orderId,
        notes: { order_id: orderId }
      });
      if (!created.ok) {
        console.error('Razorpay order create failed:', created.status, JSON.stringify(created.data));
        return res.status(502).json({ error: 'Payment gateway error. Please try again.' });
      }
      rzpOrder = created.data;
    }

    // Server-only fields (Firebase rules stop clients from writing these)
    await ref.update({
      serverTotal: total,
      rzpOrderId: rzpOrder.id,
      totalMismatch: Math.abs(total - Number(order.total || 0)) > 0.5
    });

    return res.status(200).json({
      id: rzpOrder.id,
      amount: paise,
      currency: 'INR',
      key: process.env.RZP_KEY_ID,
      total: round2(total)
    });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    console.error('create-order error:', e);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};

// Razorpay -> your server. Confirms payments even if the customer closes the browser mid-way.
const crypto = require('crypto');
const { db, isValidOrderId, safeEqual, markPaid } = require('../lib/common');

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
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
          console.error('Webhook payment NOT matched to order:', orderId, pay.id, pay.amount);
        }
      }
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error:', e);
    return res.status(500).send('error'); // Razorpay will retry
  }
};

// Vercel: don't parse the body, we need the raw bytes for the signature check
module.exports.config = { api: { bodyParser: false } };

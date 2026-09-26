// Combined commerce handlers: catalog, createOrder.
// Originally two separate Vercel routes (catalog.js, create-order.js).
// You are responsible for wiring these to their routes/methods in your own
// router — they are no longer auto-routed by filename.
const {
  db,
  cors,
  parseBody,
  requireAdmin,
  safeError,
  isValidOrderId,
  round2,
  rzp,
  computeServerTotal,
  requireCustomerForPhone,
} = require('../lib/common');

// ---------------------------------------------------------------------------
// catalog
// GET -> full categories/products tree
// POST { action, catName, prodId, data } -> admin-only product/category edits
// ---------------------------------------------------------------------------

async function catalog(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') return res.status(200).json((await db.ref('categories').once('value')).val() || {});
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!await requireAdmin(req, res)) return;
    const { action, catName, prodId, data } = parseBody(req);
    if (!catName || /[.#$\[\]/]/.test(String(catName))) return res.status(400).json({ error: 'Invalid category.' });
    if (prodId && /[.#$\[\]/]/.test(String(prodId))) return res.status(400).json({ error: 'Invalid product id.' });
    if (action === 'deleteProduct' && prodId) await db.ref(`categories/${catName}/${prodId}`).remove();
    else if (action === 'updateProduct' && prodId && data && typeof data === 'object') await db.ref(`categories/${catName}/${prodId}`).update(data);
    else if (action === 'saveCategory' && data && typeof data === 'object') await db.ref(`categories/${catName}`).set(data);
    else return res.status(400).json({ error: 'Invalid action or missing parameters.' });
    return res.status(200).json({ success: true });
  } catch (e) { return safeError(res, 500, 'Catalog operation failed.', e); }
}

// ---------------------------------------------------------------------------
// createOrder
// POST { order_id } -> creates a Razorpay order for the amount the SERVER
// calculates.
// ---------------------------------------------------------------------------

async function createOrder(req, res) {
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
    if (!await requireCustomerForPhone(req, res, order.phone)) return;
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
        console.error('createOrder: Razorpay order create failed:', created.status, JSON.stringify(created.data));
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
    console.error('createOrder error:', e);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}

module.exports = { catalog, createOrder };

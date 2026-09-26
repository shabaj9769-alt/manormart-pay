// Combined commerce handlers: catalog, Razorpay createOrder, and customer orders.
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
const { verifyCustomerSession } = require('../lib/customer-auth');

// ---------------------------------------------------------------------------
// 1. catalog
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
// 2. createOrder (Razorpay - Your original secure payment order code)[span_3](start_span)[span_3](end_span)
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

// ---------------------------------------------------------------------------
// 3. handleCustomerOrders (NEW: Create Order, Fetch by Phone, Cancel Order)
// ---------------------------------------------------------------------------
async function handleCustomerOrders(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { phone, orderId } = req.query || {};

      if (orderId) {
        if (!isValidOrderId(orderId)) return res.status(400).json({ error: 'Invalid order id.' });
        const snap = await db.ref(`orders/${orderId}`).once('value');
        const order = snap.val();
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (!await requireCustomerForPhone(req, res, order.phone)) return;
        return res.status(200).json(order);
      }

      if (phone) {
        const cleanPh = String(phone).replace(/[^0-9]/g, '').trim();
        if (cleanPh.length !== 10) return res.status(400).json({ error: 'Valid 10-digit phone required.' });
        
        const session = verifyCustomerSession(req);
        if (!session || session.phone !== cleanPh) {
          return res.status(403).json({ error: 'Customer authentication required.' });
        }

        const snap = await db.ref('orders').orderByChild('phone').equalTo(cleanPh).once('value');
        return res.status(200).json(snap.val() || {});
      }

      return res.status(400).json({ error: 'Missing parameters.' });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const { action, orderData, orderId } = body;

      if (action === 'createOrder') {
        if (!orderData || !orderData.id || !isValidOrderId(orderData.id)) {
          return res.status(400).json({ error: 'Invalid order data or ID.' });
        }
        const custPhone = String(orderData.phone || '').trim();
        if (custPhone.length !== 10) return res.status(400).json({ error: 'Valid customer phone required.' });

        const session = verifyCustomerSession(req);
        if (!session || session.phone !== custPhone) {
          return res.status(403).json({ error: 'Customer authentication required.' });
        }

        await db.ref(`orders/${orderData.id}`).set({
          ...orderData,
          createdAt: Date.now(),
          paymentVerified: false
        });

        return res.status(200).json({ success: true, orderId: orderData.id });
      }

      if (action === 'cancelCustomerOrder') {
        if (!orderId || !isValidOrderId(orderId)) return res.status(400).json({ error: 'Invalid order id.' });

        const ref = db.ref(`orders/${orderId}`);
        const order = (await ref.once('value')).val();
        if (!order) return res.status(404).json({ error: 'Order not found.' });

        if (!await requireCustomerForPhone(req, res, order.phone)) return;

        if (String(order.deliveryStatus || '').includes('Delivered') || String(order.deliveryStatus || '').includes('Out for Delivery')) {
          return res.status(400).json({ error: 'Order cannot be cancelled once dispatched.' });
        }

        const newStatus = order.payment === 'Online' 
          ? (String(order.deliveryStatus || '').includes('Payment Pending') ? '❌ Cancelled (Unpaid)' : '❌ Cancelled (Paid - Refundable)')
          : '❌ Order Cancelled (COD)';

        await ref.update({ deliveryStatus: newStatus, cancelledAt: Date.now() });
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Invalid action.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return safeError(res, 500, 'Orders operation failed.', e);
  }
}

// ---------------------------------------------------------------------------
// Vercel compatible router export handler[span_4](start_span)[span_4](end_span)
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  const url = req.url || '';
  
  if (url.includes('create-order')) {
    return createOrder(req, res);
  }
  
  if (url.includes('orders') || (req.method === 'GET' && (req.query?.phone || req.query?.orderId))) {
    return handleCustomerOrders(req, res);
  }
  if (req.method === 'POST') {
    const body = parseBody(req);
    if (body?.action === 'createOrder' || body?.action === 'cancelCustomerOrder') {
      return handleCustomerOrders(req, res);
    }
  }

  return catalog(req, res);
};

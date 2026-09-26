// ordersManager
// Originally its own Vercel route (orders-manager.js). You are responsible
// for wiring this to its route/methods in your own router.
//
// GET  ?phone=... / ?orderId=...  -> customer's own orders, or (with an admin
//      token) any order / the full orders tree.
// POST { action, ... } -> createOrder, cancelCustomerOrder (customer-facing),
//      and updateStatus / assignBoy / cancelOrder / deleteOrder (admin-only).
const {
  db,
  admin,
  cors,
  parseBody,
  requireAdmin,
  verifyFirebaseToken,
  requireCustomerForPhone,
  isValidOrderId,
  computeServerTotal,
  safeError,
  normalizePhone,
} = require('../lib/common');
const { verifyCustomerSession } = require('../lib/customer-auth');
const crypto = require('crypto');

function newId() { return `ord_${Date.now()}_${crypto.randomInt(0, 1000)}`; }
function cleanPhone(p) { return String(p || '').replace(/[^0-9]/g, '').trim(); }
async function isAdminToken(req) { const d = await verifyFirebaseToken(req); return !!(d && d.admin === true); }

async function ordersManager(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const { phone, orderId } = req.query || {};
      const adminToken = await isAdminToken(req);
      if (adminToken) {
        if (orderId) {
          if (!isValidOrderId(String(orderId))) return res.status(400).json({ error: 'Invalid order id.' });
          return res.status(200).json((await db.ref(`orders/${orderId}`).once('value')).val() || {});
        }
        return res.status(200).json((await db.ref('orders').once('value')).val() || {});
      }
      const session = verifyCustomerSession(req);
      const decoded = session || await verifyFirebaseToken(req);
      if (!decoded) return res.status(401).json({ error: 'Customer authentication required.' });
      const ownPhones = session ? [session.phone] : [decoded.phone_number, decoded.phone, decoded.customerPhone].filter(Boolean).map(cleanPhone);
      if (phone) {
        const p = cleanPhone(phone);
        if (p.length !== 10) return res.status(400).json({ error: 'Valid mobile number required' });
        if (!ownPhones.includes(p)) return res.status(403).json({ error: 'You can only access your own orders.' });
        const snap = await db.ref('orders').orderByChild('phone').equalTo(p).once('value');
        return res.status(200).json(snap.val() || {});
      }
      if (orderId) {
        if (!isValidOrderId(String(orderId))) return res.status(400).json({ error: 'Invalid order id.' });
        const order = (await db.ref(`orders/${orderId}`).once('value')).val() || {};
        if (!ownPhones.includes(cleanPhone(order.phone))) return res.status(403).json({ error: 'You can only access your own order.' });
        return res.status(200).json(order);
      }
      return res.status(400).json({ error: 'Phone or orderId required.' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { action, orderId, orderData, status, assignedBoy, boyPhone } = parseBody(req);

    if (action === 'cancelCustomerOrder') {
      const id = String(orderId || '');
      if (!isValidOrderId(id)) return res.status(400).json({ error: 'Invalid order id.' });
      const session = verifyCustomerSession(req);
      if (!session) return res.status(401).json({ error: 'Customer authentication required.' });
      const ref = db.ref(`orders/${id}`);
      const snap = await ref.once('value');
      const cur = snap.val();
      if (!cur || cleanPhone(cur.phone) !== session.phone) return res.status(403).json({ error: 'You can only cancel your own order.' });
      const st = String(cur.deliveryStatus || '');
      if (st === 'Delivered' || st === 'Out for Delivery' || st.includes('Cancelled')) return res.status(409).json({ error: 'This order can no longer be cancelled.' });
      const next = cur.payment === 'Online' && cur.paymentVerified === true ? '❌ Cancelled (Paid - Refundable)' : (cur.payment === 'Online' ? '❌ Cancelled (Unpaid)' : '❌ Order Cancelled (COD)');
      await ref.update({ deliveryStatus: next, cancelledAt: Date.now(), updatedAt: Date.now(), ...(cur.payment === 'Online' && cur.paymentVerified === true ? { needsRefund: true } : {}) });
      return res.status(200).json({ success: true });
    }

    if (action === 'createOrder' && orderData) {
      const id = isValidOrderId(String(orderData.id || '')) ? String(orderData.id) : newId();
      const secure = { ...orderData, id, timestamp: Date.now(), deliveryStatus: 'Pending' };
      if (!await requireCustomerForPhone(req, res, cleanPhone(secure.phone))) return;
      delete secure.paymentVerified; delete secure.razorpayPaymentId; delete secure.rzpOrderId; delete secure.serverTotal; delete secure.subtotal; delete secure.serverDeliveryFee; delete secure.paidAmount; delete secure.paidAt; delete secure.needsRefund; delete secure.duplicatePaymentId; delete secure.totalMismatch;
      if (!secure.name || !cleanPhone(secure.phone) || cleanPhone(secure.phone).length !== 10) return res.status(400).json({ error: 'Valid customer details required.' });
      const calc = await computeServerTotal(secure);
      secure.serverTotal = calc.total; secure.subtotal = calc.subtotal; secure.serverDeliveryFee = calc.deliveryFee; secure.totalMismatch = Math.abs(calc.total - Number(secure.total || 0)) > 0.5;
      if (secure.payment === 'Online') { secure.paymentVerified = false; secure.deliveryStatus = 'Payment Pending'; }
      await db.ref(`orders/${id}`).set(secure);
      await db.ref('admin_ring').set(true);
      return res.status(200).json({ success: true, orderId: id, order: secure });
    }

    if (!await requireAdmin(req, res)) return;
    if (!orderId || !isValidOrderId(String(orderId))) return res.status(400).json({ error: 'Invalid order id.' });
    if (action === 'updateStatus' && status) { await db.ref(`orders/${orderId}`).update({ deliveryStatus: String(status).slice(0, 100), updatedAt: Date.now() }); return res.status(200).json({ success: true }); }
    if (action === 'assignBoy') { await db.ref(`orders/${orderId}`).update({ assignedBoy: String(assignedBoy || '').slice(0, 120), deliveryBoyPhone: cleanPhone(boyPhone), updatedAt: Date.now() }); return res.status(200).json({ success: true }); }
    if (action === 'cancelOrder') { await db.ref(`orders/${orderId}`).update({ deliveryStatus: 'Cancelled', cancelledAt: Date.now() }); return res.status(200).json({ success: true }); }
    if (action === 'deleteOrder') { await db.ref(`orders/${orderId}`).remove(); return res.status(200).json({ success: true }); }
    return res.status(400).json({ error: 'Invalid action or missing parameters' });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    return safeError(res, 500, 'Order processing failed.', e);
  }
}

module.exports = { ordersManager };

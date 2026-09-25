import admin from 'firebase-admin';

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIRE_JSON)),
      databaseURL: process.env.FIRE__URL
    });
  } catch (err) {
    console.error('Firebase init error:', err);
  }
}

const db = admin.database();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. GET: Orders fetch karna
  if (req.method === 'GET') {
    const { phone, orderId } = req.query;

    try {
      // Case A: Customer sirf apne phone number ke orders dekhe
      if (phone) {
        const cleanPhone = phone.replace(/[^0-9]/g, '').trim();
        const snap = await db.ref('orders')
          .orderByChild('phone')
          .equalTo(cleanPhone)
          .once('value');
        return res.status(200).json(snap.val() || {});
      }

      // Case B: Single Order detail check
      if (orderId) {
        const snap = await db.ref(`orders/${orderId}`).once('value');
        return res.status(200).json(snap.val() || {});
      }

      // Case C: Admin Panel - Poore orders list (Admin PIN required)
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();

      if (token === process.env.ADMIN_PIN) {
        const snap = await db.ref('orders').once('value');
        return res.status(200).json(snap.val() || {});
      }

      return res.status(401).json({ error: 'Unauthorized: Phone parameter or Admin token required' });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch orders', details: e.message });
    }
  }

  // 2. POST: Order create, update status, assign boy, cancel
  if (req.method === 'POST') {
    try {
      const { action, orderId, orderData, status, assignedBoy, boyPhone, deliveryFee } = req.body;

      // --- Action 1: Place New Order (Customer App) ---
      if (action === 'createOrder' && orderData) {
        const id = orderData.id || `ord_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        // Strict default server properties
        const secureOrder = {
          ...orderData,
          id: id,
          deliveryStatus: 'Pending',
          timestamp: Date.now()
        };

        // Agar payment "Online" bheja hai, to bina server payment token ke verify nahi mana jayega
        if (secureOrder.payment === 'Online' && !secureOrder.paymentVerified) {
          secureOrder.paymentVerified = false;
        }

        await db.ref(`orders/${id}`).set(secureOrder);

        // Ring admin siren
        await db.ref('admin_ring').set(true);

        return res.status(200).json({ success: true, orderId: id, order: secureOrder });
      }

      // --- Admin / Delivery Boy Protected Actions ---
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();
      const isAdmin = (token === process.env.ADMIN_PIN);

      // --- Action 2: Update Order Status ---
      if (action === 'updateStatus' && orderId && status) {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Unauthorized: Admin PIN required' });
        }
        await db.ref(`orders/${orderId}`).update({
          deliveryStatus: status,
          updatedAt: Date.now()
        });
        return res.status(200).json({ success: true, message: `Status updated to ${status}` });
      }

      // --- Action 3: Assign Delivery Boy ---
      if (action === 'assignBoy' && orderId) {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Unauthorized: Admin PIN required' });
        }
        await db.ref(`orders/${orderId}`).update({
          assignedBoy: assignedBoy || '',
          deliveryBoyPhone: boyPhone || '',
          updatedAt: Date.now()
        });
        return res.status(200).json({ success: true, message: 'Delivery boy assigned' });
      }

      // --- Action 4: Cancel Order ---
      if (action === 'cancelOrder' && orderId) {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Unauthorized: Admin PIN required' });
        }
        await db.ref(`orders/${orderId}`).update({
          deliveryStatus: 'Cancelled',
          cancelledAt: Date.now()
        });
        return res.status(200).json({ success: true, message: 'Order cancelled' });
      }

      // --- Action 5: Delete Order ---
      if (action === 'deleteOrder' && orderId) {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Unauthorized: Admin PIN required' });
        }
        await db.ref(`orders/${orderId}`).remove();
        return res.status(200).json({ success: true, message: 'Order deleted' });
      }

      return res.status(400).json({ error: 'Invalid action or missing parameters' });
    } catch (e) {
      return res.status(500).json({ error: 'Order processing failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

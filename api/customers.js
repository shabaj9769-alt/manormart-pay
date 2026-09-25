import admin from 'firebase-admin';

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIRE_JSON)),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  } catch (err) {
    console.error('Firebase init error:', err);
  }
}

const db = admin.database();

export default async function handler(req, res) {
  // CORS setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. GET Request: Customer apna profile ya addresses load karega
  if (req.method === 'GET') {
    const { phone } = req.query;
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '').trim();

    if (!cleanPhone || cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
    }

    try {
      const snap = await db.ref(`customers/${cleanPhone}`).once('value');
      const data = snap.val() || {};
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch customer profile', details: e.message });
    }
  }

  // 2. POST Request: Profile update, address save ya push token update
  if (req.method === 'POST') {
    try {
      const { action, phone, name, addr, addresses, token } = req.body;
      const cleanPhone = (phone || '').replace(/[^0-9]/g, '').trim();

      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
      }

      // Action 1: Customer Profile Details update (Name / Single Addr)
      if (action === 'updateProfile') {
        const updateData = {};
        if (name) updateData.name = name.trim();
        if (addr) updateData.addr = addr.trim();
        updateData.updatedAt = Date.now();

        await db.ref(`customers/${cleanPhone}`).update(updateData);
        return res.status(200).json({ success: true, message: 'Profile updated' });
      }

      // Action 2: Multiple Saved Addresses list update
      if (action === 'saveAddresses') {
        if (!Array.isArray(addresses)) {
          return res.status(400).json({ error: 'Addresses must be an array' });
        }
        await db.ref(`customers/${cleanPhone}/addresses`).set(addresses);
        return res.status(200).json({ success: true, message: 'Addresses saved' });
      }

      // Action 3: Customer Push Token save (Notification node)
      if (action === 'savePushToken' && token) {
        const tokenKey = 'token_' + cleanPhone;
        await db.ref(`customerTokens/${tokenKey}`).set({
          token: token,
          phone: cleanPhone,
          updatedAt: Date.now()
        });
        return res.status(200).json({ success: true, message: 'Push token registered' });
      }

      return res.status(400).json({ error: 'Invalid action specified' });
    } catch (e) {
      return res.status(500).json({ error: 'Customer update failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

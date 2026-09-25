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
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. GET: Delivery boys ki list (Lekin bina kisi secret code ke)
  if (req.method === 'GET') {
    try {
      const snap = await db.ref('deliveryBoys').once('value');
      const boys = snap.val() || {};

      // Security Strip: Har ek boy ke object se secretCode nikaal kar sanitized list dena
      const sanitizedBoys = {};
      Object.keys(boys).forEach(key => {
        const { secretCode, ...safeData } = boys[key];
        sanitizedBoys[key] = safeData;
      });

      return res.status(200).json(sanitizedBoys);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch delivery partners', details: e.message });
    }
  }

  // 2. POST: Login check, Boy management, Push token update
  if (req.method === 'POST') {
    try {
      const { action, boyId, phone, secretCode, pushToken, boyData } = req.body;

      // Sub-Action A: Delivery Boy App Login Verification
      if (action === 'boyLogin') {
        if (!phone || !secretCode) {
          return res.status(400).json({ error: 'Phone and secret code required' });
        }

        const snap = await db.ref('deliveryBoys').once('value');
        const boys = snap.val() || {};

        let authenticatedBoy = null;
        let authBoyKey = null;

        Object.keys(boys).forEach(key => {
          if (
            boys[key].phone === phone.trim() &&
            String(boys[key].secretCode).trim() === String(secretCode).trim()
          ) {
            authenticatedBoy = boys[key];
            authBoyKey = key;
          }
        });

        if (!authenticatedBoy) {
          return res.status(401).json({ error: 'Invalid phone number or secret code' });
        }

        // Login success par secretCode hata kar response dena
        const { secretCode: _, ...safeBoyData } = authenticatedBoy;
        return res.status(200).json({
          success: true,
          boyKey: authBoyKey,
          boy: safeBoyData
        });
      }

      // Sub-Action B: Delivery Boy Push Token Update
      if (action === 'updateBoyPushToken' && boyId && pushToken) {
        await db.ref(`deliveryBoys/${boyId}/pushToken`).set(pushToken);
        return res.status(200).json({ success: true, message: 'Push token updated' });
      }

      // Sub-Action C: Admin Actions (Add, Edit, Delete Boy, Reset Code)
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();

      if (!token || token !== process.env.ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorized: Admin authorization required' });
      }

      if (action === 'saveBoy' && boyId && boyData) {
        await db.ref(`deliveryBoys/${boyId}`).update(boyData);
        return res.status(200).json({ success: true, message: 'Delivery partner saved' });
      }

      if (action === 'deleteBoy' && boyId) {
        await db.ref(`deliveryBoys/${boyId}`).remove();
        return res.status(200).json({ success: true, message: 'Delivery partner deleted' });
      }

      return res.status(400).json({ error: 'Invalid action or missing parameters' });
    } catch (e) {
      return res.status(500).json({ error: 'Delivery partner operation failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

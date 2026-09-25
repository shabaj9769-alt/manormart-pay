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

  // 1. GET: Customer App aur Admin App serviceable areas & charges padh sakein
  if (req.method === 'GET') {
    try {
      const snap = await db.ref('deliveryAreas').once('value');
      return res.status(200).json(snap.val() || {});
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch delivery areas', details: e.message });
    }
  }

  // 2. POST: Sirf verified Admin PIN se area add, edit ya delete ho
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token || token !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
    }

    try {
      const { action, areaId, areaData, allAreas } = req.body;

      // Pure delivery areas list ko ek sath replace/save karna
      if (action === 'saveAll' && allAreas) {
        await db.ref('deliveryAreas').set(allAreas);
        return res.status(200).json({ success: true, message: 'All delivery areas updated' });
      }

      // Single area add ya update karna
      if (action === 'updateArea' && areaId && areaData) {
        await db.ref(`deliveryAreas/${areaId}`).set(areaData);
        return res.status(200).json({ success: true, message: 'Area updated successfully' });
      }

      // Area delete karna
      if (action === 'deleteArea' && areaId) {
        await db.ref(`deliveryAreas/${areaId}`).remove();
        return res.status(200).json({ success: true, message: 'Area deleted successfully' });
      }

      return res.status(400).json({ error: 'Invalid action or parameters' });
    } catch (e) {
      return res.status(500).json({ error: 'Delivery areas update failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

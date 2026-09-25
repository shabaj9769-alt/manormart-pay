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

  // 1. GET: Customer App aur Admin App general store settings read karein
  if (req.method === 'GET') {
    try {
      const snap = await db.ref('settings').once('value');
      return res.status(200).json(snap.val() || {});
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch settings', details: e.message });
    }
  }

  // 2. POST: Sirf valid Admin PIN ke saath radius, delivery fee ya minimum order update ho
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token || token !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
    }

    try {
      const { action, settingsData } = req.body;

      if (action === 'updateSettings' && settingsData) {
        await db.ref('settings').update(settingsData);
        return res.status(200).json({ success: true, message: 'Settings updated successfully' });
      }

      if (action === 'saveAll' && settingsData) {
        await db.ref('settings').set(settingsData);
        return res.status(200).json({ success: true, message: 'Settings saved successfully' });
      }

      return res.status(400).json({ error: 'Invalid action or missing parameters' });
    } catch (e) {
      return res.status(500).json({ error: 'Settings update failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

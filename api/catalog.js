import admin from 'firebase-admin';

// Firebase Admin SDK Initialization
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. GET Request: Customer App & Admin App bina lock ke fast read karengi
  if (req.method === 'GET') {
    try {
      const snap = await db.ref('categories').once('value');
      return res.status(200).json(snap.val() || {});
    } catch (e) {
      return res.status(500).json({ error: 'Categories fetch failed', details: e.message });
    }
  }

  // 2. POST Request: Sirf Admin PIN ya Token ke saath write hoga
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    // Vercel Environment Variable ke PIN se check
    if (!token || token !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Admin Token/PIN' });
    }

    try {
      const { action, catName, prodId, data } = req.body;

      if (action === 'deleteProduct' && catName && prodId) {
        await db.ref(`categories/${catName}/${prodId}`).remove();
        return res.status(200).json({ success: true, message: 'Product deleted' });
      }

      if (action === 'updateProduct' && catName && prodId && data) {
        await db.ref(`categories/${catName}/${prodId}`).update(data);
        return res.status(200).json({ success: true, message: 'Product updated' });
      }

      if (action === 'saveCategory' && catName && data) {
        await db.ref(`categories/${catName}`).set(data);
        return res.status(200).json({ success: true, message: 'Category saved' });
      }

      return res.status(400).json({ error: 'Invalid action or missing parameters' });
    } catch (e) {
      return res.status(500).json({ error: 'Update failed', details: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

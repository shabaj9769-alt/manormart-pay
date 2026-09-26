// POST { refreshToken } -> a fresh 1-hour Firebase token (keeps the admin session alive without asking for the PIN again).
// The "admin" claim travels with the refresh token, so this endpoint cannot give admin rights to anyone else.
const { parseBody } = require('../lib/common');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.FIREBASE_WEB_API_KEY) return res.status(500).json({ error: 'Server is not configured yet.' });

  try {
    const refreshToken = String(parseBody(req).refreshToken || '');
    if (refreshToken.length < 20 || refreshToken.length > 2000) return res.status(400).json({ error: 'Invalid token.' });

    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${process.env.FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.id_token) return res.status(401).json({ error: 'Session expired.' });
    return res.status(200).json({ idToken: d.id_token, refreshToken: d.refresh_token, expiresIn: Number(d.expires_in) || 3600 });
  } catch (e) {
    console.error('admin-refresh error:', e);
    return res.status(500).json({ error: 'Server error.' });
  }
};

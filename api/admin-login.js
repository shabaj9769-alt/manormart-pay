// POST { pin } -> checks the admin PIN ON THE SERVER (ADMIN_PIN env var) and returns a 1-hour Firebase token
// that carries the custom claim  admin: true  (Firebase rules can then allow writes only for the admin).
const crypto = require('crypto');
const { db, parseBody } = require('../lib/common'); // also initialises firebase-admin
const admin = require('firebase-admin');

const WINDOW_MS = 15 * 60 * 1000; // lock window
const MAX_PER_IP = 5;             // wrong PINs per IP per window
const MAX_GLOBAL = 100;           // wrong PINs from everyone per window (stops distributed guessing)

function cors(res) { // the admin app is a native app; this only matters for the browser preview
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ipKey(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return 'ip_' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

const sameSecret = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

async function msLeft(path, max) {
  const cur = (await db.ref(path).once('value')).val();
  if (!cur || Date.now() - cur.start > WINDOW_MS || cur.fails < max) return 0;
  return cur.start + WINDOW_MS - Date.now();
}

async function recordFail(path) {
  await db.ref(path).transaction((cur) => {
    const now = Date.now();
    if (!cur || now - cur.start > WINDOW_MS) return { fails: 1, start: now };
    return { fails: cur.fails + 1, start: cur.start };
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_PIN || !process.env.FIREBASE_WEB_API_KEY) {
    console.error('admin-login: ADMIN_PIN or FIREBASE_WEB_API_KEY env variable is missing');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  try {
    const pin = String(parseBody(req).pin || '').trim();
    if (!/^[A-Za-z0-9]{4,32}$/.test(pin)) return res.status(400).json({ error: 'Enter your PIN.' });

    const ipPath = `adminLogin/${ipKey(req)}`;
    const wait = Math.max(await msLeft(ipPath, MAX_PER_IP), await msLeft('adminLogin/global', MAX_GLOBAL));
    if (wait > 0) {
      return res.status(429).json({ error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` });
    }

    if (!sameSecret(pin, process.env.ADMIN_PIN)) {
      await Promise.all([recordFail(ipPath), recordFail('adminLogin/global')]);
      return res.status(401).json({ error: 'Incorrect Admin Security PIN!' });
    }

    await db.ref(ipPath).remove(); // correct PIN: reset this device's counter

    const customToken = await admin.auth().createCustomToken('manormart-admin', { admin: true });
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.FIREBASE_WEB_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.idToken) {
      console.error('admin-login: token exchange failed:', r.status, JSON.stringify(d.error || d));
      return res.status(500).json({ error: 'Login service error. Please try again.' });
    }
    return res.status(200).json({ idToken: d.idToken, refreshToken: d.refreshToken, expiresIn: Number(d.expiresIn) || 3600 });
  } catch (e) {
    console.error('admin-login error:', e);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};

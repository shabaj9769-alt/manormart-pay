// Combined store-settings handlers: settings, offerSettings.
// Originally two separate Vercel routes (settings.js, offer-settings.js).
// You are responsible for wiring these to their routes/methods in your own
// router.
const { db, cors, parseBody, requireAdmin, safeError } = require('../lib/common');

// ---------------------------------------------------------------------------
// settings
// GET -> public subset of the store's settings
// POST { action, settingsData } -> admin-only settings edits
// ---------------------------------------------------------------------------

// Fields the customer app is allowed to see via a public GET. Internal-only
// admin fields (adminPushToken, orderRingAlert, ringtoneUrl) are deliberately
// left out.
const PUBLIC_KEYS = ['store', 'storeOpen', 'storeStatus', 'upi', 'hubLat', 'hubLng', 'radiusKm', 'normCharge', 'expCharge', 'freeDel', 'minOrd', 'expDeliveryTime', 'adminNote', 'b1', 'b2', 'b3'];
function publicSettings(s) { const out = {}; for (const k of PUBLIC_KEYS) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k]; return out; }

async function settings(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') { const s = (await db.ref('settings').once('value')).val() || {}; return res.status(200).json(publicSettings(s)); }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!await requireAdmin(req, res)) return;
    const { action, settingsData } = parseBody(req);
    if (!settingsData || typeof settingsData !== 'object') return res.status(400).json({ error: 'Invalid settings.' });
    if (action === 'updateSettings') await db.ref('settings').update(settingsData);
    else if (action === 'saveAll') await db.ref('settings').set(settingsData);
    else return res.status(400).json({ error: 'Invalid action.' });
    return res.status(200).json({ success: true });
  } catch (e) { return safeError(res, 500, 'Settings operation failed.', e); }
}

// ---------------------------------------------------------------------------
// offerSettings
// GET -> full offerSettings tree
// POST { action, offerData, offerId } -> admin-only offer edits
// ---------------------------------------------------------------------------

async function offerSettings(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') return res.status(200).json((await db.ref('offerSettings').once('value')).val() || {});
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!await requireAdmin(req, res)) return;
    const { action, offerData, offerId } = parseBody(req);
    if (action === 'saveAll' && offerData && typeof offerData === 'object') await db.ref('offerSettings').set(offerData);
    else if (action === 'updateOffer' && offerId && offerData && typeof offerData === 'object') await db.ref(`offerSettings/${String(offerId).replace(/[.#$\[\]/]/g, '')}`).set(offerData);
    else if (action === 'deleteOffer' && offerId) await db.ref(`offerSettings/${String(offerId).replace(/[.#$\[\]/]/g, '')}`).remove();
    else return res.status(400).json({ error: 'Invalid action.' });
    return res.status(200).json({ success: true });
  } catch (e) { return safeError(res, 500, 'Offer operation failed.', e); }
}

module.exports = { settings, offerSettings };

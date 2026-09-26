// GET/PUT/PATCH/DELETE ?path=<firebase/db/path>.json
//
// This is the endpoint the admin app's `authFetch(ADMIN_DB_PREFIX + ...)` helper
// calls for every read/write it does (settings, categories/menu, deliveryBoys,
// orders, deliveryBoySecrets, customerTokens, ...). It was missing from this
// project entirely, which means every single admin-panel action (loading
// orders/products/settings, editing products, changing settings, managing
// delivery partners, broadcasting offers) was failing outright.
//
// It mirrors the shape of Firebase's own REST Database API (`<path>.json`,
// GET/PUT/PATCH/DELETE) but requires a valid admin session token, so the app
// never needs its own direct Firebase credentials.
const { db, cors, requireAdmin, safeError } = require('../lib/common');

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Firebase Realtime Database keys can't contain these characters.
const FORBIDDEN_KEY_CHARS = /[.#$[\]]/;

// Customer records (and their password hashes) are managed exclusively through
// /api/customers.js, which knows how to hash/verify passwords correctly. Block
// this generic proxy from touching that subtree so a bug here can never write
// a customer's password in plain text.
const BLOCKED_ROOTS = new Set(['customers']);

// The client builds paths like "categories/Dairy%20Products/prodId/status.json"
// (already URL-encoded once by the app for the category name) and then the
// whole thing gets encodeURIComponent'd again to go in the query string. By the
// time it reaches req.query.path, the outer encoding has been undone by the
// normal query-string parser, so each path segment still needs its own
// decodeURIComponent to recover things like spaces in category names.
function sanitizePath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (!p) return null;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.toLowerCase().endsWith('.json')) p = p.slice(0, -5);
  if (!p) return null;

  const segments = p.split('/').filter(Boolean);
  if (!segments.length) return null;

  const decoded = [];
  for (const seg of segments) {
    let d;
    try { d = decodeURIComponent(seg); } catch { return null; }
    if (!d || d === '.' || d === '..' || FORBIDDEN_KEY_CHARS.test(d)) return null;
    decoded.push(d);
  }
  if (BLOCKED_ROOTS.has(decoded[0])) return null;
  return decoded.join('/');
}

module.exports = async function handler(req, res) {
  cors(req, res, 'GET,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (!await requireAdmin(req, res)) return;

    const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const path = sanitizePath(rawPath);
    if (!path) return res.status(400).json({ error: 'Invalid or missing path.' });

    const ref = db.ref(path);

    if (req.method === 'GET') {
      const val = (await ref.once('value')).val();
      return res.status(200).json(val === undefined ? null : val);
    }

    if (req.method === 'DELETE') {
      await ref.remove();
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await getRawBody(req);
      let value;
      try { value = raw.length ? JSON.parse(raw) : null; }
      catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }

      if (req.method === 'PUT') {
        await ref.set(value);
      } else {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return res.status(400).json({ error: 'PATCH body must be a JSON object.' });
        }
        await ref.update(value);
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return safeError(res, 500, 'Database operation failed.', e);
  }
};

// We need the raw request body ourselves (to preserve non-object JSON values
// like a bare string/boolean/null for PUT), so disable Vercel's default parser.
module.exports.config = { api: { bodyParser: false } };

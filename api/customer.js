// Combined customer handlers: customerLogin, customerProfile.
// Originally two separate Vercel routes (customer-login.js, customers.js).
// You are responsible for wiring these to their routes/methods in your own
// router — they are no longer auto-routed by filename.
const {
  db,
  cors,
  parseBody,
  verifyFirebaseToken,
  requireAdmin,
  safeError,
  normalizePhone,
} = require('../lib/common');
const {
  loginCustomer,
  verifyCustomerSession,
  createCustomerSession,
  hashPassword,
  verifyPassword,
} = require('../lib/customer-auth');

function phone(p) { return normalizePhone(p); }

// ---------------------------------------------------------------------------
// customerLogin
// POST { phone, password } -> verifies the customer's password (set by admin
// via customerProfile action=adminSetPassword, or changed by the customer via
// action=changePassword) and returns a signed customer session token.
// ---------------------------------------------------------------------------

async function customerLogin(req, res) {
  cors(req, res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);
    const clean = phone(body.phone);
    const password = String(body.password || '');

    if (clean.length !== 10) return res.status(400).json({ error: 'Valid 10-digit mobile number required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const result = await loginCustomer(clean, password);
    if (!result.ok) {
      const msg = result.code === 'PASSWORD_NOT_SET'
        ? 'No password has been set for this number yet. Please contact the store to set one.'
        : 'Invalid mobile number or password.';
      return res.status(401).json({ error: msg });
    }

    return res.status(200).json({ token: result.token, customer: result.customer });
  } catch (e) {
    return safeError(res, 500, 'Login failed. Please try again.', e);
  }
}

// ---------------------------------------------------------------------------
// customerSignup
// POST { phone, password, name?, addr? } -> creates a password for a
// customer number that doesn't have one yet, and returns a signed session
// token (same shape as customerLogin). Refuses to touch a number that
// already has a password — that number must use customerLogin or
// changePassword instead.
// ---------------------------------------------------------------------------

async function customerSignup(req, res) {
  cors(req, res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);
    const clean = phone(body.phone);
    const password = String(body.password || '');

    if (clean.length !== 10) return res.status(400).json({ error: 'Valid 10-digit mobile number required.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8-128 characters.' });

    const ref = db.ref(`customers/${clean}`);
    const existing = (await ref.once('value')).val() || {};
    if (existing.passwordHash) {
      return res.status(409).json({ error: 'An account already exists for this number. Please log in instead.' });
    }

    const u = { passwordHash: hashPassword(password), updatedAt: Date.now() };
    if (!existing.createdAt) u.createdAt = Date.now();
    if (body.name !== undefined) u.name = String(body.name).trim().slice(0, 120);
    if (body.addr !== undefined) u.addr = String(body.addr).trim().slice(0, 1000);

    await ref.update(u);

    const customer = {
      name: u.name !== undefined ? u.name : (existing.name || ''),
      addr: u.addr !== undefined ? u.addr : (existing.addr || ''),
      addresses: Array.isArray(existing.addresses) ? existing.addresses : [],
    };
    return res.status(200).json({ token: createCustomerSession(clean), customer });
  } catch (e) {
    return safeError(res, 500, 'Signup failed. Please try again.', e);
  }
}

// ---------------------------------------------------------------------------
// customerProfile
// GET ?phone=<10-digit> -> customer record (password hash stripped)
// POST { action, phone, ... } -> profile/address/password/push-token actions
// ---------------------------------------------------------------------------

async function customerAuth(req, clean) {
  const s = verifyCustomerSession(req);
  if (s && s.phone === clean) return true;
  const d = await verifyFirebaseToken(req);
  if (!d) return false;
  const candidates = [d.phone_number, d.phone, d.customerPhone].filter(Boolean).map(phone);
  return candidates.includes(clean);
}

async function customerProfile(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const clean = phone(req.query?.phone);
      if (clean.length !== 10) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
      if (!await customerAuth(req, clean)) return res.status(403).json({ error: 'Customer authentication required.' });
      const c = (await db.ref(`customers/${clean}`).once('value')).val() || {};
      delete c.passwordHash;
      return res.status(200).json(c);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = parseBody(req);
    const { action, phone: p, name, addr, addresses, token, password, oldPassword } = body;
    const clean = phone(p);
    if (clean.length !== 10) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });

    if (action === 'adminSetPassword') {
      if (!await requireAdmin(req, res)) return;
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8-128 characters.' });
      await db.ref(`customers/${clean}/passwordHash`).set(hashPassword(password));
      return res.status(200).json({ success: true });
    }
    if (action === 'changePassword') {
      const session = verifyCustomerSession(req);
      if (!session || session.phone !== clean) return res.status(403).json({ error: 'Customer authentication required.' });
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'New password must be 8-128 characters.' });
      const c = (await db.ref(`customers/${clean}`).once('value')).val() || {};
      const currentPassword = String(oldPassword || '');
      if (!currentPassword || !c.passwordHash || !verifyPassword(currentPassword, c.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
      await db.ref(`customers/${clean}/passwordHash`).set(hashPassword(password));
      return res.status(200).json({ success: true });
    }

    if (!await customerAuth(req, clean)) return res.status(403).json({ error: 'Customer authentication required.' });

    if (action === 'updateProfile') {
      const u = { updatedAt: Date.now() };
      if (name !== undefined) u.name = String(name).trim().slice(0, 120);
      if (addr !== undefined) u.addr = String(addr).trim().slice(0, 1000);
      await db.ref(`customers/${clean}`).update(u);
      return res.status(200).json({ success: true });
    }
    if (action === 'saveAddresses') {
      if (!Array.isArray(addresses) || addresses.length > 20) return res.status(400).json({ error: 'Invalid addresses.' });
      await db.ref(`customers/${clean}/addresses`).set(addresses);
      return res.status(200).json({ success: true });
    }
    if (action === 'savePushToken' && token) {
      const t = String(token).slice(0, 4096);
      await db.ref(`customerTokens/token_${clean}`).set({ token: t, phone: clean, updatedAt: Date.now() });
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: 'Invalid action.' });
  } catch (e) {
    return safeError(res, 500, 'Customer operation failed.', e);
  }
}

module.exports = { customerLogin, customerSignup, customerProfile };

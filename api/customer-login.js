// POST { phone, password } -> verifies the customer's password (set by admin via
// /api/customers action=adminSetPassword, or changed by the customer via
// action=changePassword) and returns a signed customer session token.
// This endpoint was missing entirely, which is why "Login Securely" never worked:
// the customer app called it, got a 404, and the app showed that as "Invalid
// mobile number or password."
const { cors, parseBody, normalizePhone, safeError } = require('../lib/common');
const { loginCustomer } = require('../lib/customer-auth');

module.exports = async function handler(req, res) {
  cors(req, res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');

    if (phone.length !== 10) return res.status(400).json({ error: 'Valid 10-digit mobile number required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const result = await loginCustomer(phone, password);
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
};

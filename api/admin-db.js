// Handles TWO public routes (rewritten in vercel.json to include ?route=):
//   /api/admin-login   -> ?route=login
//   /api/admin-refresh -> ?route=refresh
// admin-db stays its own file (api/admin-db.js) because it needs the raw
// request body, which would break JSON parsing for these two if merged in.
const { adminLogin, adminRefresh } = require('../lib/handlers/admin');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'login') return adminLogin(req, res);
  if (route === 'refresh') return adminRefresh(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

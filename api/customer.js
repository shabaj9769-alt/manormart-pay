// Handles THREE public routes (rewritten in vercel.json to include ?route=):
//   /api/customer-login  -> ?route=login
//   /api/customer-signup -> ?route=signup
//   /api/customers        -> ?route=profile
const { customerLogin, customerSignup, customerProfile } = require('../lib/handlers/customer');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'login') return customerLogin(req, res);
  if (route === 'signup') return customerSignup(req, res);
  if (route === 'profile') return customerProfile(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

// Handles TWO public routes (rewritten in vercel.json to include ?route=):
//   /api/settings       -> ?route=settings
//   /api/offer-settings -> ?route=offer
const { settings, offerSettings } = require('../lib/handlers/store-settings');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'settings') return settings(req, res);
  if (route === 'offer') return offerSettings(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

// Handles TWO public routes (rewritten in vercel.json to include ?route=):
//   /api/delivery-areas    -> ?route=areas
//   /api/delivery-partners -> ?route=partners
const { deliveryAreas, deliveryPartners } = require('../lib/handlers/delivery');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'areas') return deliveryAreas(req, res);
  if (route === 'partners') return deliveryPartners(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

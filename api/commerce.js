// Handles TWO public routes (rewritten in vercel.json to include ?route=):
//   /api/catalog       -> ?route=catalog
//   /api/create-order  -> ?route=create-order
const { catalog, createOrder } = require('../lib/handlers/commerce');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'catalog') return catalog(req, res);
  if (route === 'create-order') return createOrder(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

// Handles TWO public routes (rewritten in vercel.json to include ?route=):
//   /api/verify-payment -> ?route=verify
//   /api/payment-status -> ?route=status
// razorpay-webhook stays its own file (api/razorpay-webhook.js) because it
// needs the raw request body, which would break JSON parsing for these two
// if merged in.
const { verifyPayment, paymentStatus } = require('../lib/handlers/payments');

module.exports = function handler(req, res) {
  const route = req.query && req.query.route;
  if (route === 'verify') return verifyPayment(req, res);
  if (route === 'status') return paymentStatus(req, res);
  return res.status(404).json({ error: 'Unknown route.' });
};

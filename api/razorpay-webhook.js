// This route needs the raw request body for signature verification (see
// lib/handlers/payments.js), so body parsing must stay disabled here — kept
// as its own function for that reason.
module.exports = require('../lib/handlers/payments').razorpayWebhook;
module.exports.config = { api: { bodyParser: false } };

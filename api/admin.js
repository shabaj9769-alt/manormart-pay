const { adminLogin, adminRefresh, adminDb } = require('../lib/handlers/admin');

module.exports = async function handler(req, res) {
  const url = req.url || '';
  if (url.includes('refresh')) {
    return adminRefresh(req, res);
  }
  if (url.includes('login')) {
    return adminLogin(req, res);
  }
  return adminDb(req, res);
};

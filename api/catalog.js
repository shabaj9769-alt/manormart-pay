const { db, cors, parseBody, requireAdmin, safeError } = require('../lib/common');
module.exports = async function handler(req, res) {
  cors(req, res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') return res.status(200).json((await db.ref('categories').once('value')).val() || {});
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!await requireAdmin(req, res)) return;
    const { action, catName, prodId, data } = parseBody(req);
    if (!catName || /[.#$\[\]/]/.test(String(catName))) return res.status(400).json({ error: 'Invalid category.' });
    if (prodId && /[.#$\[\]/]/.test(String(prodId))) return res.status(400).json({ error: 'Invalid product id.' });
    if (action === 'deleteProduct' && prodId) await db.ref(`categories/${catName}/${prodId}`).remove();
    else if (action === 'updateProduct' && prodId && data && typeof data === 'object') await db.ref(`categories/${catName}/${prodId}`).update(data);
    else if (action === 'saveCategory' && data && typeof data === 'object') await db.ref(`categories/${catName}`).set(data);
    else return res.status(400).json({ error: 'Invalid action or missing parameters.' });
    return res.status(200).json({ success: true });
  } catch (e) { return safeError(res, 500, 'Catalog operation failed.', e); }
};

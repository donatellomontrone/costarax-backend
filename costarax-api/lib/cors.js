// Centralized CORS helper.
// Allow only the production origin (and localhost during dev) — echo back
// the request's Origin if it's allowed, so credentials/preflight work.

const ALLOWED = new Set([
  'https://costarax.com',
  'https://www.costarax.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
])

function applyCors(req, res, { methods = 'GET,POST,PATCH,DELETE,OPTIONS' } = {}) {
  const origin = req.headers.origin
  const allow = origin && ALLOWED.has(origin) ? origin : 'https://costarax.com'
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') { res.status(200).end(); return true }
  return false
}

module.exports = { applyCors, ALLOWED }

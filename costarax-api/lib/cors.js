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

// Dev origins: localhost / loopback / private-LAN over http, on any port.
// Used while testing the mobile app's web build from a phone on the LAN
// (e.g. http://192.168.x.x:8088). Auth is Bearer-token only — no cookies
// and Allow-Credentials is never set — so reflecting these origins carries
// no ambient-credential risk. Public https origins still require the
// explicit ALLOWED list above.
const DEV_ORIGIN_RX =
  /^http:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/

function isAllowedOrigin(origin) {
  if (!origin) return false
  return ALLOWED.has(origin) || DEV_ORIGIN_RX.test(origin)
}

function applyCors(req, res, { methods = 'GET,POST,PATCH,DELETE,OPTIONS' } = {}) {
  const origin = req.headers.origin
  const allow = isAllowedOrigin(origin) ? origin : 'https://costarax.com'
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') { res.status(200).end(); return true }
  return false
}

module.exports = { applyCors, ALLOWED }

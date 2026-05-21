const suppliersIndex = require('../../lib/admin-routes/suppliers')
const suppliersId = require('../../lib/admin-routes/suppliers-id')
const accessRequestsAction = require('../../lib/admin-routes/access-requests-action')
const businessesAction = require('../../lib/admin-routes/businesses-action')
const paymentsIndex = require('../../lib/admin-routes/payments')
const usersIndex = require('../../lib/admin-routes/users')
const cronIndex = require('../../lib/admin-routes/cron')
const { applyCors } = require('../../lib/cors')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS' })) return

  const queryPath = Array.isArray(req.query.path) ? req.query.path : [req.query.path].filter(Boolean)
  const urlPath = (req.url || '')
    .split('?')[0]
    .replace(/^\/api\/admin\/?/, '')
    .split('/')
    .filter(Boolean)
  const path = queryPath.length ? queryPath : urlPath
  const [resource, id, action] = path

  if (resource === 'suppliers' && path.length === 1) {
    return suppliersIndex(req, res)
  }

  if (resource === 'suppliers' && path.length === 2) {
    req.query.id = id
    return suppliersId(req, res)
  }

  if (resource === 'access-requests' && path.length === 3) {
    req.query.id = id
    req.query.action = action
    return accessRequestsAction(req, res)
  }

  if (resource === 'businesses' && path.length === 3) {
    req.query.id = id
    req.query.action = action
    return businessesAction(req, res)
  }

  if (resource === 'payments' && path.length === 1) {
    return paymentsIndex(req, res)
  }

  if (resource === 'users') {
    // /api/admin/users/<id>  → expose id via req.query.id (used by DELETE)
    if (path.length === 2) req.query.id = id
    return usersIndex(req, res)
  }

  if (resource === 'cron') {
    return cronIndex(req, res)
  }

  return res.status(404).json({ error: 'Admin route not found' })
}

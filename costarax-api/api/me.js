const { applyCors } = require('../lib/cors')
const { supabaseAdmin, requireAuth } = require('../lib/supabase-admin')
const { resolveUserContext } = require('../lib/user-context')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,OPTIONS' })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return

  const ctx = await resolveUserContext(supabaseAdmin, auth.user.id, auth.user.email)
  return res.status(200).json(ctx)
}

const { formidable } = require('formidable')
const fs = require('fs')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

const ALLOWED_MIME = new Set(['image/png','image/jpeg','image/webp','image/svg+xml'])
const MAX_BYTES    = 2 * 1024 * 1024

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

    const auth = await requireAuth(req, res)
    if (!auth) return

    const form = formidable({ maxFileSize: MAX_BYTES, maxFiles: 1 })
    let fields, files
    try { [fields, files] = await form.parse(req) }
    catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }

    const supplierId = Array.isArray(fields.supplier_id) ? fields.supplier_id[0] : fields.supplier_id
    if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' })

    // Authorization: admin can upload for any supplier; supplier role can only upload for their own
    if (auth.profile.role !== 'admin') {
      const { data: member } = await supabaseAdmin
        .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
      if (!member || member.supplier_id !== supplierId) {
        return res.status(403).json({ error: 'You can only upload a logo for your own supplier' })
      }
    }

    const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
    const file = fileArr[0]
    if (!file) return res.status(400).json({ error: 'No file provided' })

    if (!ALLOWED_MIME.has(file.mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}. Allowed: PNG, JPG, WEBP, SVG.` })
    }

    const buffer = fs.readFileSync(file.filepath)
    const ext = (file.originalFilename || 'logo').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
    const storagePath = `${supplierId}/logo-${Date.now()}.${ext}`

    const { error: upErr } = await supabaseAdmin.storage
      .from('supplier-assets')
      .upload(storagePath, buffer, { contentType: file.mimetype, upsert: false })
    fs.unlinkSync(file.filepath)
    if (upErr) return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message })

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('supplier-assets').getPublicUrl(storagePath)

    const { error: updErr } = await supabaseAdmin
      .from('suppliers').update({ logo_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', supplierId)
    if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message })

    return res.status(201).json({ logo_url: publicUrl, path: storagePath })
  } catch (fatalErr) {
    console.error('[upload/supplier-logo] Unhandled:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

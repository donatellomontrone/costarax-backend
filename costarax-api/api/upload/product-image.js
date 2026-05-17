const { formidable } = require('formidable')
const fs = require('fs')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

const ALLOWED_MIME = new Set(['image/png','image/jpeg','image/webp'])
const MAX_BYTES    = 2 * 1024 * 1024

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

    const auth = await requireAuth(req, res)
    if (!auth) return
    // Only supplier or admin can attach a product image
    if (!['admin','supplier'].includes(auth.profile.role)) {
      return res.status(403).json({ error: 'Only suppliers and admins can upload product images' })
    }

    const form = formidable({ maxFileSize: MAX_BYTES, maxFiles: 1 })
    let fields, files
    try { [fields, files] = await form.parse(req) }
    catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }

    const productId = Array.isArray(fields.product_id) ? fields.product_id[0] : fields.product_id
    if (!productId) return res.status(400).json({ error: 'product_id is required' })

    const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
    const file = fileArr[0]
    if (!file) return res.status(400).json({ error: 'No file provided' })

    if (!ALLOWED_MIME.has(file.mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}. Allowed: PNG, JPG, WEBP.` })
    }

    // Confirm the product exists
    const { data: prod, error: prodErr } = await supabaseAdmin
      .from('products').select('id, canonical_name').eq('id', productId).single()
    if (prodErr || !prod) return res.status(404).json({ error: 'Product not found' })

    const buffer = fs.readFileSync(file.filepath)
    const ext = (file.originalFilename || 'image').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const storagePath = `${productId}/${Date.now()}.${ext}`

    const { error: upErr } = await supabaseAdmin.storage
      .from('product-images')
      .upload(storagePath, buffer, { contentType: file.mimetype, upsert: false })
    fs.unlinkSync(file.filepath)
    if (upErr) return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message })

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('product-images').getPublicUrl(storagePath)

    const { error: updErr } = await supabaseAdmin
      .from('products').update({ image_url: publicUrl }).eq('id', productId)
    if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message })

    return res.status(201).json({ image_url: publicUrl, path: storagePath })
  } catch (fatalErr) {
    console.error('[upload/product-image] Unhandled:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

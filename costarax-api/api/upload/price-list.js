const formidable = require('formidable')
const fs = require('fs')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return

  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  // Resolve supplier_id from org membership
  let supplierId = null
  const { data: org } = await supabaseAdmin
    .from('organization_members')
    .select('supplier_id')
    .eq('user_id', auth.user.id)
    .single()
  supplierId = org?.supplier_id || null

  if (!supplierId && auth.profile.role !== 'admin') {
    return res.status(403).json({ error: 'No supplier linked to this account' })
  }

  const form = formidable({ maxFileSize: 20 * 1024 * 1024, maxFiles: 1 })
  let fields, files
  try {
    ;[fields, files] = await form.parse(req)
  } catch (e) {
    return res.status(400).json({ error: 'File parse error: ' + e.message })
  }

  const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
  if (!fileArr.length) return res.status(400).json({ error: 'No file provided' })

  const file = fileArr[0]
  const allowed = ['application/pdf', 'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  if (!allowed.includes(file.mimetype)) {
    return res.status(400).json({ error: 'Only PDF, CSV and Excel files are accepted' })
  }

  const buffer = fs.readFileSync(file.filepath)
  const timestamp = Date.now()
  const ext = file.originalFilename?.split('.').pop() || 'pdf'
  const storagePath = `${supplierId || 'admin'}/${timestamp}-${(file.originalFilename || 'price-list').replace(/[^a-zA-Z0-9._-]/g, '_')}`

  const { error: uploadErr } = await supabaseAdmin.storage
    .from('price-lists')
    .upload(storagePath, buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false
    })

  fs.unlinkSync(file.filepath)

  if (uploadErr) {
    console.error('Storage upload error:', uploadErr.message)
    return res.status(500).json({ error: 'Storage error: ' + uploadErr.message })
  }

  // Record upload metadata
  if (supplierId) {
    await supabaseAdmin.from('price_list_uploads').insert({
      supplier_id: supplierId,
      file_name: file.originalFilename || 'price-list.' + ext,
      file_path: storagePath,
      file_size_bytes: file.size,
      status: 'pending_review'
    }).catch(e => console.log('price_list_uploads insert skipped:', e.message))
  }

  return res.status(201).json({
    message: 'Price list uploaded successfully. Our team will review and index it shortly.',
    path: storagePath
  })
}

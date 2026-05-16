const { formidable } = require('formidable')
const fs = require('fs')
const { supabaseAdmin } = require('../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  try {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const form = formidable({ maxFileSize: 10 * 1024 * 1024, maxFiles: 5 })
  let fields, files
  try {
    ;[fields, files] = await form.parse(req)
  } catch(e) {
    return res.status(400).json({ error: 'File parse error: ' + e.message })
  }

  const accessRequestId = Array.isArray(fields.access_request_id) ? fields.access_request_id[0] : fields.access_request_id
  const docType = Array.isArray(fields.document_type) ? fields.document_type[0] : fields.document_type

  if (!accessRequestId) return res.status(400).json({ error: 'access_request_id is required' })

  // Validate that the access request exists and is still pending — prevents uploads against arbitrary UUIDs
  const { data: accessRequest, error: arErr } = await supabaseAdmin
    .from('access_requests').select('id, status').eq('id', accessRequestId).single()
  if (arErr || !accessRequest) return res.status(404).json({ error: 'Access request not found' })
  if (accessRequest.status !== 'pending') return res.status(400).json({ error: 'Access request is no longer pending' })

  const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
  const results = []

  for (const file of fileArr) {
    const buffer = fs.readFileSync(file.filepath)
    const timestamp = Date.now()
    const ext = file.originalFilename?.split('.').pop() || 'pdf'
    const storagePath = `${accessRequestId}/${timestamp}-${(file.originalFilename||'document').replace(/[^a-zA-Z0-9._-]/g,'_')}`

    const { error: uploadErr } = await supabaseAdmin.storage
      .from('access-request-docs')
      .upload(storagePath, buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false })

    if (uploadErr) {
      console.error('Storage upload error:', uploadErr.message)
      continue
    }

    await supabaseAdmin.from('access_request_documents').insert({
      access_request_id: accessRequestId,
      document_type: docType || 'other',
      file_name: file.originalFilename || 'document.' + ext,
      file_path: storagePath,
      file_size_bytes: file.size
    })

    fs.unlinkSync(file.filepath)
    results.push({ name: file.originalFilename, path: storagePath })
  }

  return res.status(201).json({ uploaded: results.length, files: results })
  } catch (fatalErr) {
    console.error('[upload/access-request-doc] Unhandled error:', fatalErr.message, fatalErr.stack)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

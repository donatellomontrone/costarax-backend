const https = require('https')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

function httpsPost(hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj)
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(data) })
          } catch (e) {
            reject(new Error('Failed to parse response: ' + data.slice(0, 200)))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const auth = await requireAuth(req, res)
    if (!auth) return

    if (!['supplier', 'admin'].includes(auth.profile.role)) {
      return res.status(403).json({ error: 'Supplier access required' })
    }

    const { text, file_name } = req.body || {}
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'No content provided' })
    }

    // Resolve supplier
    let supplierId = null, supplierName = 'Supplier'
    const { data: org } = await supabaseAdmin
      .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
    supplierId = org?.supplier_id || null
    if (!supplierId && auth.profile.role !== 'admin') {
      return res.status(403).json({ error: 'No supplier linked to this account' })
    }
    if (supplierId) {
      const { data: sup } = await supabaseAdmin.from('suppliers').select('name').eq('id', supplierId).single()
      if (sup?.name) supplierName = sup.name
    }

    // Record upload (Supabase v2 never throws — no .catch() needed)
    const { data: uploadRecord } = await supabaseAdmin
      .from('price_list_uploads')
      .insert({ supplier_id: supplierId, file_name: file_name || 'price-list', status: 'processing' })
      .select('id')
      .single()
    const uploadId = uploadRecord?.id || null

    // Check Groq key
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' })
    }

    let extracted = []
    try {
      const prompt = `You are a data extraction assistant for a Filipino foodservice procurement platform.

Extract all products and prices from this supplier price list. Return ONLY a valid JSON array.

Rules:
- Each item: "name" (string), "price" (number PHP per unit), "unit" (string)
- Normalize units: kg, g, pc, box, case, liter, dozen, bag, tray
- Convert price ranges to the lower value (e.g. "120-130" → 120)
- Skip items with no price
- Clean product names

Supplier: ${supplierName}

Content:
${text.slice(0, 8000)}

Return JSON array only, no markdown, no explanation:
[{"name":"Product","price":100,"unit":"kg"},...]`

      const aiRes = await httpsPost(
        'api.groq.com',
        '/openai/v1/chat/completions',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        {
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 4000
        }
      )

      if (!aiRes.ok) throw new Error(aiRes.body?.error?.message || `Groq returned ${aiRes.status}`)

      const content = aiRes.body.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('Empty response from Groq')
      // Handle both raw array and markdown code blocks (```json [...] ```)
      const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || content.match(/(\[[\s\S]*\])/)
      if (!jsonMatch) throw new Error('No JSON array returned by AI. Got: ' + content.slice(0, 200))
      extracted = JSON.parse(jsonMatch[1] || jsonMatch[0])
    } catch (e) {
      if (uploadId) {
        await supabaseAdmin.from('price_list_uploads').update({
          status: 'error', error_message: e.message, processed_at: new Date().toISOString()
        }).eq('id', uploadId)
      }
      return res.status(500).json({ error: 'AI extraction failed: ' + e.message })
    }

    if (!extracted.length) {
      return res.status(422).json({ error: 'No products found in the file.' })
    }

    // Match against products catalog
    const { data: catalog } = await supabaseAdmin.from('products').select('id, canonical_name').eq('active', true)
    const products = catalog || []

    function normalize(str) {
      return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
    }
    function matchProduct(name) {
      const needle = normalize(name)
      return products.find(p => {
        const hay = normalize(p.canonical_name)
        return hay === needle || needle.includes(hay) || hay.includes(needle)
      }) || null
    }

    let matched = 0
    let created = 0
    const failed = []
    for (const item of extracted) {
      if (!item.name || !item.price || item.price <= 0) continue

      let product = matchProduct(item.name)

      // Auto-create product if not in catalog
      if (!product) {
        const { data: newProduct } = await supabaseAdmin.from('products').insert({
          canonical_name: item.name.trim(),
          unit: item.unit || 'kg',
          category: 'uncategorized',
          active: true
        }).select('id, canonical_name').single()

        if (newProduct) {
          products.push(newProduct) // add to local cache for dedup
          product = newProduct
          created++
        } else {
          failed.push(item.name)
          continue
        }
      }

      await supabaseAdmin.from('supplier_prices').upsert({
        supplier_id: supplierId,
        product_id: product.id,
        price_php: parseFloat(item.price),
        unit: item.unit || null,
        active: true
      }, { onConflict: 'supplier_id,product_id' })
      matched++
    }

    if (uploadId) {
      await supabaseAdmin.from('price_list_uploads').update({
        status: 'completed',
        products_extracted: extracted.length,
        products_matched: matched,
        processed_at: new Date().toISOString()
      }).eq('id', uploadId)
    }

    return res.status(201).json({
      message: `Done! ${matched} product${matched !== 1 ? 's' : ''} indexed (${created} new added to catalog).${failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}` : ''}`,
      extracted: extracted.length,
      matched,
      created,
      failed
    })

  } catch (fatalErr) {
    console.error('FATAL price-list error:', fatalErr)
    return res.status(500).json({ error: 'Fatal: ' + (fatalErr.message || String(fatalErr)) })
  }
}

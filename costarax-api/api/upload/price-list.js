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
      .insert({ supplier_id: supplierId, file_name: file_name || 'price-list', status: 'uploaded' })
      .select('id')
      .single()
    const uploadId = uploadRecord?.id || null

    // Check Groq key
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' })
    }

    let extracted = []
    try {
      const prompt = `Extract products from this price list. Return JSON array only.
Each item: {"name":"original","canonical":"Full English Name No Abbreviations","price":number,"unit":"kg/pc/box/etc","category":"meat|seafood|produce|dry|beverages|packaging"}
Rules: skip items without price. For price ranges use lower value. Expand abbreviations in canonical (e.g. mb2=Marble Grade 2).
Category rules: meat=pork/beef/chicken/poultry, seafood=fish/shrimp/squid, produce=vegetables/fruits/eggs, dry=rice/flour/oil/canned/spices, beverages=drinks/juice/water, packaging=boxes/bags/containers.
Supplier: ${supplierName}
---
${text.slice(0, 2000)}
---
JSON:`

      const aiRes = await httpsPost(
        'api.groq.com',
        '/openai/v1/chat/completions',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.0,
          max_tokens: 1500
        }
      )

      if (!aiRes.ok) throw new Error(aiRes.body?.error?.message || `Groq returned ${aiRes.status}`)

      const content = aiRes.body.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('Empty response from Groq')

      // Extract JSON array (handle markdown code blocks too)
      const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || content.match(/(\[[\s\S]*\])/)
      if (!jsonMatch) throw new Error('No JSON array returned by AI. Got: ' + content.slice(0, 200))
      let rawJson = (jsonMatch[1] || jsonMatch[0]).trim()

      // Attempt 1: parse as-is
      try {
        extracted = JSON.parse(rawJson)
      } catch (_) {
        // Attempt 2: repair common LLM JSON issues
        let repaired = rawJson
          .replace(/,\s*([}\]])/g, '$1')          // trailing commas
          .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // unquoted keys
          .replace(/:\s*'([^']*)'/g, ': "$1"')     // single-quoted values
          .replace(/[\x00-\x1F\x7F]/g, ' ')         // control chars
        // If truncated (no closing bracket), close it
        if (!repaired.trimEnd().endsWith(']')) {
          const lastGood = repaired.lastIndexOf('},')
          repaired = (lastGood > 0 ? repaired.slice(0, lastGood + 1) : repaired) + ']'
        }
        try {
          extracted = JSON.parse(repaired)
        } catch (e2) {
          // Attempt 3: extract individual objects via regex
          const objs = []
          const objRx = /\{[^{}]*"name"[^{}]*"price"[^{}]*\}/g
          let m
          while ((m = objRx.exec(rawJson)) !== null) {
            try { objs.push(JSON.parse(m[0])) } catch (_) {}
          }
          if (objs.length === 0) throw new Error('Malformed JSON from AI: ' + rawJson.slice(0, 200))
          extracted = objs
        }
      }
    } catch (e) {
      if (uploadId) {
        await supabaseAdmin.from('price_list_uploads').update({
          status: 'rejected', ai_summary: JSON.stringify({ error: e.message })
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
    function matchProduct(canonical) {
      const needle = normalize(canonical)
      return products.find(p => {
        const hay = normalize(p.canonical_name)
        if (hay === needle) return true
        // Token overlap: ≥60% shared tokens → same product
        const needleTokens = needle.split(' ')
        const hayTokens = hay.split(' ')
        const shared = needleTokens.filter(t => t.length > 2 && hayTokens.includes(t)).length
        return shared >= Math.ceil(needleTokens.length * 0.6)
      }) || null
    }

    // Separate items into matched vs needs-creation
    const VALID_CATEGORIES = ['meat', 'seafood', 'produce', 'dry', 'beverages', 'packaging']
    const validItems = extracted.filter(i => i.name && i.price && i.price > 0)
    const toCreate = []
    const priceRows = []

    for (const item of validItems) {
      const canonicalName = (item.canonical || item.name).trim()
      const category_id = VALID_CATEGORIES.includes(item.category) ? item.category : 'dry'
      const product = matchProduct(canonicalName)
      const unit = (item.unit || 'kg').trim()
      if (product) {
        priceRows.push({ supplier_id: supplierId, product_id: product.id, price_php: parseFloat(item.price), unit, active: true })
      } else {
        toCreate.push({ canonical_name: canonicalName, category_id, default_unit: unit, active: true, _price: parseFloat(item.price), _unit: unit })
      }
    }

    // Bulk-insert new products in one query
    let created = 0
    let insertError = null
    let upsertError = null
    if (toCreate.length) {
      const insertPayload = toCreate.map(({ _price, _unit, ...p }) => p)
      const { data: newProducts, error: iErr } = await supabaseAdmin.from('products').insert(insertPayload).select('id, canonical_name')
      insertError = iErr?.message || null
      if (newProducts) {
        created = newProducts.length
        newProducts.forEach((np, i) => {
          priceRows.push({ supplier_id: supplierId, product_id: np.id, price_php: toCreate[i]._price, unit: toCreate[i]._unit, active: true })
        })
      }
    }

    // Replace supplier prices: delete old rows for this supplier+products, then insert fresh
    if (priceRows.length && supplierId) {
      const productIds = priceRows.map(r => r.product_id)
      await supabaseAdmin.from('supplier_prices').delete().eq('supplier_id', supplierId).in('product_id', productIds)
      const { error: uErr } = await supabaseAdmin.from('supplier_prices').insert(priceRows)
      upsertError = uErr?.message || null
    }

    const matched = priceRows.length
    const failed = []

    if (uploadId) {
      await supabaseAdmin.from('price_list_uploads').update({
        status: 'needs_review',
        ai_summary: JSON.stringify({ extracted: extracted.length, matched, created, error: upsertError || insertError || null })
      }).eq('id', uploadId)
    }

    return res.status(201).json({
      message: `Done! ${matched} product${matched !== 1 ? 's' : ''} indexed (${created} new added to catalog).${failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}` : ''}`,
      extracted: extracted.length,
      validItems: validItems.length,
      toCreate: toCreate.length,
      matched,
      created,
      failed,
      insertError,
      upsertError,
      sampleExtracted: extracted.slice(0, 2)
    })

  } catch (fatalErr) {
    console.error('FATAL price-list error:', fatalErr)
    return res.status(500).json({ error: 'Fatal: ' + (fatalErr.message || String(fatalErr)) })
  }
}

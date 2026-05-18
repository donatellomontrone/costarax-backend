const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken } = require('../lib/supabase-admin');

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { product, options, qty } = body;

  if (!product?.name) return res.status(400).json({ error: 'Product required' });
  if (!Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'At least 2 supplier options required' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const optionLines = options.map((o, i) =>
    `#${i + 1} ${o.supplierName} — ₱${o.price}/${product.unit}${o.rating ? ` · ★${o.rating}` : ''}${o.location ? ` · ${o.location}` : ''}${o.delivery ? ` · ${o.delivery}` : ''}${o.moa ? ` · MOA ₱${o.moa}` : ''}`
  ).join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are a procurement advisor for Philippine foodservice buyers (restaurants, hotels, canteens).
Give a concise, practical buying recommendation. Be direct and confident. Mention price difference and any relevant factors.
Write in plain English, 2-3 sentences max. No markdown, no bullet points. End with a one-line "Bottom line:" summary.`,
      messages: [{
        role: 'user',
        content: `Product: ${product.name}/${product.unit}${qty ? ` (approx. quantity: ${qty})` : ''}

Supplier options:
${optionLines}

Which supplier should I choose and why?`
      }]
    });

    const recommendation = msg.content[0]?.text?.trim() || '';
    return res.status(200).json({ recommendation });
  } catch (e) {
    console.error('AI recommend error:', e.message);
    return res.status(500).json({ error: 'AI recommendation unavailable' });
  }
};

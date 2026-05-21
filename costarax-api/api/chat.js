const Anthropic = require('@anthropic-ai/sdk');
const { applyCors } = require('../lib/cors');
const { enforce, clientIp } = require('../lib/rate-limit');

const SYSTEM = `You are the Costarax support assistant — helpful, concise, and direct.

Costarax is a private B2B procurement intelligence platform for foodservice businesses in the Philippines.

Key facts:
- Connects foodservice buyers (restaurants, hotels, canteens, catering, retail food shops) with verified suppliers and distributors
- Buyers can search 380+ suppliers, compare prices across 12,000+ AI-indexed products, and send quote requests (RFQ) directly through the platform
- Suppliers upload their price lists; AI extracts, normalizes and indexes the products automatically
- Access is by application only — every business is verified against a valid BIR/TIN registration — approval within 24h
- Free for buying businesses. Suppliers contact the team to join.
- Prices in Philippine Peso (₱). Platform in English, Filipino (Tagalog), and Chinese.
- Live at: costarax.vercel.app

How it works for buyers:
1. Apply for access (fill the form on this page)
2. Once approved, search products and compare supplier prices side by side
3. Send a quote request to one or multiple suppliers at once
4. Confirm the order, track fulfillment, leave a review

How it works for suppliers:
1. Apply as Supplier (fill the form, select Supplier/Distributor)
2. Upload your price list (PDF, Excel, photo — AI does the rest)
3. Receive quote requests from verified buyers directly on the platform
4. Reply, confirm orders, mark as fulfilled

If someone wants to sign up: tell them to fill the "Request Business Access" form on this page and select whether they are a Buyer or Supplier.
If someone has a technical issue or complaint: acknowledge it, ask for their email, and tell them the team will follow up within 24h.
If asked about pricing for suppliers: say to contact the team via the form.
Keep replies short — 2-4 sentences max unless more detail is clearly needed. No bullet lists unless the question needs a structured answer. Never make up facts.`;

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 20 messages / hour per IP (chat is public + costs money per call).
  if (!(await enforce(req, res, { bucket: 'chat', identifier: clientIp(req), max: 20, windowSec: 3600 }))) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ reply: "Hi! I'm the Costarax assistant. Our AI support is being set up — in the meantime, fill the access request form on this page and our team will get back to you within 24h." });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const safe = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 800) }));

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM,
      messages: safe
    });
    return res.status(200).json({ reply: msg.content[0]?.text?.trim() || '' });
  } catch (e) {
    console.error('Chat error:', e.message);
    return res.status(500).json({ error: 'AI unavailable', reply: "Sorry, I'm having trouble right now. Please fill the access request form and our team will reach you within 24h." });
  }
};

const nodemailer = require('nodemailer')

// Default to the production Costarax address. The previous fallback
// (onboarding@resend.dev) was Resend's sandbox sender, which gets flagged
// as spoofing by some inboxes and looks unprofessional. EMAIL_FROM env
// var still wins when set.
const FROM = process.env.EMAIL_FROM || 'Costarax <hello@costarax.com>'
const EMAIL_TIMEOUT_MS = parseInt(process.env.EMAIL_TIMEOUT_MS || '8000', 10)

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ])
}

async function sendEmail({ to, subject, html }) {
  // Prefer SMTP (Brevo) when EMAIL_HOST is configured
  if (process.env.EMAIL_HOST && process.env.EMAIL_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_PORT === '465',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        connectionTimeout: EMAIL_TIMEOUT_MS,
        greetingTimeout: EMAIL_TIMEOUT_MS,
        socketTimeout: EMAIL_TIMEOUT_MS,
      })
      await withTimeout(
        transporter.sendMail({ from: FROM, to, subject, html }),
        EMAIL_TIMEOUT_MS,
        'SMTP sendMail'
      )
      return { ok: true }
    } catch (err) { console.error('[SMTP error]', err.message); return { ok: false, error: err.message } }
  }

  // Fallback: Resend SDK
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      const { error } = await withTimeout(
        resend.emails.send({ from: FROM, to, subject, html }),
        EMAIL_TIMEOUT_MS,
        'Resend emails.send'
      )
      if (error) { console.error('[Resend error]', error); return { ok: false, error: error.message } }
      return { ok: true }
    } catch (err) { console.error('[Resend error]', err.message); return { ok: false, error: err.message } }
  }

  console.log('[Email skipped — no provider configured]', { to, subject })
  return { ok: true }
}

// Default to the production marketing domain, not the Vercel deploy URL.
// All transactional email CTAs route through APP_URL — keeping this on
// costarax.com avoids confusing users with a costarax.vercel.app link.
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://costarax.com'

// ── Shared layout ─────────────────────────────────────────────────────────────
function layout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F4;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border:1px solid #E2E0DA;border-radius:10px;overflow:hidden;">
      <!-- Header -->
      <tr>
        <td style="background:#1A5C3A;padding:22px 32px;border-radius:10px 10px 0 0;">
          <span style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.02em;">Costara<span style="color:#C8873A;">x</span></span>
        </td>
      </tr>
      <!-- Body -->
      <tr><td style="padding:32px 32px 24px;">${bodyHtml}</td></tr>
      <!-- Footer -->
      <tr>
        <td style="padding:16px 32px 24px;border-top:1px solid #E2E0DA;">
          <p style="margin:0;font-size:12px;color:#9A9890;line-height:1.6;">
            This is an automated message from Costarax — Private AI Supplier Price Intelligence for Philippine Businesses.<br>
            If you have questions, reply to <a href="mailto:hello@costarax.com" style="color:#1A5C3A;">hello@costarax.com</a>
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;margin-top:20px;background:#1A5C3A;color:#ffffff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.02em;">${label}</a>`
}
function h2(text) {
  return `<h2 style="margin:0 0 16px;font-size:20px;font-weight:800;color:#18170F;letter-spacing:-0.01em;">${text}</h2>`
}
function p(text) {
  return `<p style="margin:0 0 12px;font-size:14px;color:#3D3C38;line-height:1.65;">${text}</p>`
}
function highlight(text) {
  return `<div style="background:#EAF3EE;border-left:4px solid #1A5C3A;padding:14px 16px;margin:16px 0;border-radius:0 6px 6px 0;font-size:14px;color:#123F28;line-height:1.65;">${text}</div>`
}
function row(label, value) {
  return `<tr><td style="padding:6px 0;font-size:13px;color:#7A7870;width:140px;">${label}</td><td style="padding:6px 0;font-size:13px;color:#18170F;font-weight:600;">${value}</td></tr>`
}
function table(...rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">${rows.join('')}</table>`
}

// ── Templates ─────────────────────────────────────────────────────────────────

function quoteReceivedEmail({ supplierName, buyerName, products, message }) {
  const body = `
    ${h2('New quote request')}
    ${p(`<strong>${buyerName}</strong> has sent you a quote request on Costarax.`)}
    ${table(
      row('From:', buyerName || '—'),
      row('Products:', products || '—'),
      row('Message:', message || '—')
    )}
    ${btn(`${APP_URL}/app.html?role=supplier`, 'Reply on Costarax')}
  `
  return { subject: `New quote request from ${buyerName} — Costarax`, html: layout('New quote request — Costarax', body) }
}

function quoteRepliedEmail({ buyerName, supplierName, reply }) {
  const body = `
    ${h2('Quote reply received')}
    ${p(`<strong>${supplierName}</strong> has replied to your quote request.`)}
    ${highlight(reply || '—')}
    ${btn(`${APP_URL}/app.html?role=business`, 'View quote on Costarax')}
  `
  return { subject: `${supplierName} replied to your quote — Costarax`, html: layout('Quote reply — Costarax', body) }
}

function accessRequestEmail({ companyName, contactEmail, businessType }) {
  const body = `
    ${h2('New access request')}
    ${p('A new business has submitted a request for platform access.')}
    ${table(
      row('Company:', companyName || '—'),
      row('Email:', contactEmail || '—'),
      row('Type:', businessType || 'Not specified')
    )}
    ${btn(`${APP_URL}/app.html?role=admin`, 'Review in Admin Panel')}
  `
  return { subject: `New access request: ${companyName} — Costarax`, html: layout('New access request — Costarax', body) }
}

function accessApprovedEmail({ companyName, contactEmail }) {
  const body = `
    ${h2(`Welcome to Costarax, ${companyName}!`)}
    ${p('Your business has been verified and your account is now active.')}
    ${highlight('Check your inbox for a separate <strong>invitation email</strong> from Costarax. Click the link in that email to set your password and sign in.')}
    ${table(
      row('Login email:', contactEmail || '—'),
      row('Platform:', `<a href="${APP_URL}/login.html" style="color:#1A5C3A;">${APP_URL}/login.html</a>`)
    )}
    ${btn(`${APP_URL}/login.html`, 'Go to Costarax Login')}
    ${p('<span style="font-size:12px;color:#7A7870;">Didn\'t receive the invitation email? Check your spam folder or contact us at hello@costarax.com</span>')}
  `
  return { subject: 'Your Costarax access has been approved', html: layout('Access approved — Costarax', body) }
}

function adminRoleChangedEmail({ contactEmail, oldRole, newRole }) {
  const labelOf = r => r === 'admin' ? 'Administrator' : r === 'supplier' ? 'Supplier' : r === 'buyer' ? 'Business buyer' : (r || '—')
  const body = `
    ${h2('Your Costarax role has been updated')}
    ${p('A Costarax administrator changed your account role.')}
    ${table(
      row('Account:', contactEmail || '—'),
      row('Previous role:', labelOf(oldRole)),
      row('New role:', `<strong>${labelOf(newRole)}</strong>`),
    )}
    ${highlight('You may see different sections and permissions in the platform after your next login. If this change was unexpected, contact us at hello@costarax.com immediately.')}
    ${btn(`${APP_URL}/login.html`, 'Go to Costarax')}
  `
  return { subject: 'Your Costarax role has been updated', html: layout('Role updated — Costarax', body) }
}

function adminCreatedAccountEmail({ contactEmail, role, resetLink }) {
  const roleLabel = role === 'admin' ? 'Administrator' : role === 'supplier' ? 'Supplier' : 'Business buyer'
  const body = `
    ${h2('Your Costarax account is ready')}
    ${p(`A Costarax administrator created an account for you with the role <strong>${roleLabel}</strong>.`)}
    ${table(
      row('Login email:', contactEmail || '—'),
      row('Role:', roleLabel),
      row('Platform:', `<a href="${APP_URL}/login.html" style="color:#1A5C3A;">${APP_URL}/login.html</a>`),
    )}
    ${highlight('Your administrator should share your initial password with you separately. We recommend changing it to a password only you know after your first login.')}
    ${resetLink ? btn(resetLink, 'Set my password') : btn(`${APP_URL}/login.html`, 'Go to Costarax Login')}
    ${p('<span style="font-size:12px;color:#7A7870;">Didn\'t expect this email? Contact us at hello@costarax.com to revoke the account.</span>')}
  `
  return { subject: 'Your Costarax account is ready', html: layout('Account created — Costarax', body) }
}

function orderConfirmedEmail({ supplierName, buyerName, orderNotes }) {
  const body = `
    ${h2('Order confirmed')}
    ${p(`<strong>${buyerName}</strong> has confirmed an order from your quote reply.`)}
    ${orderNotes ? highlight(`<strong>Delivery notes:</strong><br>${orderNotes}`) : ''}
    ${p('Please prepare the delivery according to the agreed terms.')}
    ${btn(`${APP_URL}/app.html?role=supplier`, 'View order on Costarax')}
  `
  return { subject: `Order confirmed by ${buyerName} — Costarax`, html: layout('Order confirmed — Costarax', body) }
}

function orderFulfilledEmail({ buyerName, supplierName, products }) {
  const body = `
    ${h2('Order fulfilled')}
    ${p(`<strong>${supplierName}</strong> has marked your order as fulfilled.`)}
    ${products ? table(row('Products:', products)) : ''}
    ${p('If you have any issues with this delivery, please contact your supplier directly through the platform.')}
    ${btn(`${APP_URL}/app.html?role=business`, 'View on Costarax')}
  `
  return { subject: `Your order has been fulfilled by ${supplierName} — Costarax`, html: layout('Order fulfilled — Costarax', body) }
}

function orderPreparingEmail({ buyerName, supplierName }) {
  const body = `
    ${h2('Your order is being prepared')}
    ${p(`<strong>${supplierName}</strong> has started preparing your order.`)}
    ${p('You will receive another notification once your order is dispatched for delivery.')}
    ${btn(`${APP_URL}/app.html?role=business`, 'Track your order')}
  `
  return { subject: `Your order is being prepared by ${supplierName} — Costarax`, html: layout('Order preparing — Costarax', body) }
}

function orderDispatchedEmail({ buyerName, supplierName }) {
  const body = `
    ${h2('Your order is out for delivery')}
    ${p(`<strong>${supplierName}</strong> has dispatched your order — it is now on its way to you.`)}
    ${p('Please confirm delivery once you receive the goods.')}
    ${btn(`${APP_URL}/app.html?role=business`, 'Confirm delivery')}
  `
  return { subject: `Your order is out for delivery from ${supplierName} — Costarax`, html: layout('Order dispatched — Costarax', body) }
}

function orderDeliveredSupplierEmail({ buyerName, supplierName }) {
  const body = `
    ${h2('Delivery confirmed')}
    ${p(`<strong>${buyerName}</strong> has confirmed they received your delivery.`)}
    ${p('The order is now complete. The buyer may submit a review shortly.')}
    ${btn(`${APP_URL}/app.html?role=supplier`, 'View on Costarax')}
  `
  return { subject: `Delivery confirmed by ${buyerName} — Costarax`, html: layout('Delivery confirmed — Costarax', body) }
}

function watchlistPriceAlertEmail({ buyerName, alerts }) {
  const rows = alerts.map(a =>
    row(a.productName, `<span style="color:#1A5C3A;font-weight:700">₱${Number(a.currentPrice).toLocaleString()}/${a.unit}</span> <span style="color:#7A7870">(was ₱${Number(a.prevPrice).toLocaleString()} · ${a.pct > 0 ? '+' : ''}${a.pct}%)</span>`)
  ).join('')
  const body = `
    ${h2('Price alert — your watchlist')}
    ${p(`Hi ${buyerName || 'there'}, prices moved on products you are watching:`)}
    ${table(...alerts.map(a => row(a.productName, `<span style="color:${a.pct < 0 ? '#1A5C3A' : '#DC2626'};font-weight:700">₱${Number(a.currentPrice).toLocaleString()}/${a.unit}</span> <span style="color:#7A7870">(was ₱${Number(a.prevPrice).toLocaleString()} · ${a.pct > 0 ? '▲' : '▼'}${Math.abs(a.pct)}%)</span>`)))}
    ${btn(`${APP_URL}/app.html?role=business`, 'View prices on Costarax')}
    ${p('<span style="font-size:12px;color:#9A9890;">You are receiving this because you starred these products in your Costarax watchlist.</span>')}
  `
  return { subject: `Price alert: ${alerts.length} watchlist product${alerts.length > 1 ? 's' : ''} moved — Costarax`, html: layout('Price alert — Costarax', body) }
}

// ── Branded replacements for Supabase's default Auth emails ──────────────────
// The Supabase default invite / recovery emails come from
// noreply@mail.app.supabase.io with no logo, no branding, and an awkward
// "powered by Supabase ⚡" footer. We bypass them by:
//   1. Creating the auth user with createUser (which does NOT send mail)
//   2. Generating the action link with generateLink (also no mail)
//   3. Sending OUR own email using these templates via the configured
//      SMTP / Resend provider with the Costarax brand
// Run users/admin must also disable the corresponding default templates
// in Supabase Dashboard → Authentication → Email Templates so the
// platform doesn't double-send.

function welcomeInviteEmail({ companyName, contactEmail, role, inviteLink }) {
  const roleLabel = role === 'admin'    ? 'Administrator'
                  : role === 'supplier' ? 'Supplier'
                  : 'Business buyer'
  const helloName = companyName ? `, ${companyName}` : ''
  const body = `
    ${h2(`Welcome to Costarax${helloName}!`)}
    ${p(`Your ${roleLabel.toLowerCase()} account has been approved and is ready to use.`)}
    ${p('Click the button below to <strong>set your password</strong> and sign in for the first time. The link is valid for 24 hours.')}
    ${btn(inviteLink || `${APP_URL}/login.html`, 'Set my password')}
    ${table(
      row('Login email:', contactEmail || '—'),
      row('Account type:', roleLabel),
      row('Platform:', `<a href="${APP_URL}/login.html" style="color:#1A5C3A;">${APP_URL}/login.html</a>`)
    )}
    ${highlight(`<strong>Tip:</strong> bookmark <a href="${APP_URL}/login.html" style="color:#123F28;font-weight:700">costarax.com/login.html</a> so you can log in any time from any device.`)}
    ${p('<span style="font-size:12px;color:#7A7870;">If you didn\'t expect this email, you can safely ignore it. No account was created without administrator approval.</span>')}
  `
  return { subject: `Welcome to Costarax — set your password to sign in`, html: layout('Welcome — Costarax', body) }
}

function passwordResetEmail({ contactEmail, resetLink }) {
  const body = `
    ${h2('Reset your password')}
    ${p(`A password reset was requested for your Costarax account (<strong>${contactEmail}</strong>).`)}
    ${p('Click the button below to choose a new password. The link is valid for 1 hour.')}
    ${btn(resetLink || `${APP_URL}/login.html`, 'Reset my password')}
    ${highlight(`<strong>Didn't request this?</strong> You can safely ignore this email — your password won't change unless you click the link above.`)}
    ${p('<span style="font-size:12px;color:#7A7870;">For security, this link can only be used once and will expire shortly. If you need a new link, request another reset from the login screen.</span>')}
  `
  return { subject: 'Reset your Costarax password', html: layout('Reset password — Costarax', body) }
}

module.exports = {
  sendEmail,
  quoteReceivedEmail, quoteRepliedEmail,
  accessRequestEmail, accessApprovedEmail,
  adminCreatedAccountEmail, adminRoleChangedEmail,
  welcomeInviteEmail, passwordResetEmail,
  orderConfirmedEmail, orderFulfilledEmail,
  orderPreparingEmail, orderDispatchedEmail, orderDeliveredSupplierEmail,
  watchlistPriceAlertEmail,
}

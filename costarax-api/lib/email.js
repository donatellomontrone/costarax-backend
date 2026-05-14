const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
})

async function sendEmail({ to, subject, html }) {
  if (!process.env.EMAIL_USER) { console.log('[Email skipped]', { to, subject }); return { ok: true } }
  try {
    await transporter.sendMail({ from: process.env.EMAIL_FROM || 'Costarax <noreply@costarax.ph>', to, subject, html })
    return { ok: true }
  } catch (err) { console.error('[Email error]', err.message); return { ok: false } }
}

function quoteReceivedEmail({ supplierName, buyerName, products, message }) {
  return {
    subject: `New quote request from ${buyerName} — Costarax`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E2E0DA;border-radius:8px;">
      <h2 style="color:#1A5C3A;margin:0 0 16px">New quote request on Costarax</h2>
      <p><strong>From:</strong> ${buyerName}</p>
      <p><strong>Products:</strong> ${products}</p>
      <p><strong>Message:</strong> ${message}</p>
      <a href="${process.env.APP_URL || 'https://costarax.vercel.app'}/app.html?role=supplier" style="display:inline-block;margin-top:16px;background:#1A5C3A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Reply on Costarax</a>
    </div>`
  }
}

function quoteRepliedEmail({ buyerName, supplierName, reply }) {
  return {
    subject: `${supplierName} replied to your quote — Costarax`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E2E0DA;border-radius:8px;">
      <h2 style="color:#1A5C3A;margin:0 0 16px">Quote reply received</h2>
      <p><strong>${supplierName}</strong> replied to your request:</p>
      <div style="background:#EAF3EE;border-left:4px solid #1A5C3A;padding:14px;margin:16px 0;border-radius:0 6px 6px 0;">${reply}</div>
      <a href="${process.env.APP_URL || 'https://costarax.vercel.app'}/app.html?role=business" style="display:inline-block;background:#1A5C3A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">View on Costarax</a>
    </div>`
  }
}

function accessRequestEmail({ companyName, contactEmail, businessType }) {
  return {
    subject: `New access request: ${companyName} — Costarax`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E2E0DA;border-radius:8px;">
      <h2 style="margin:0 0 16px">New access request</h2>
      <p><strong>Company:</strong> ${companyName}</p>
      <p><strong>Email:</strong> ${contactEmail}</p>
      <p><strong>Type:</strong> ${businessType || 'Not specified'}</p>
    </div>`
  }
}

function accessApprovedEmail({ companyName, contactEmail }) {
  return {
    subject: `Your Costarax access has been approved`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E2E0DA;border-radius:8px;">
      <h2 style="color:#1A5C3A;margin:0 0 16px">Welcome to Costarax, ${companyName}!</h2>
      <p>Your account has been verified and activated. Login with: <strong>${contactEmail}</strong></p>
      <a href="${process.env.APP_URL || 'https://costarax.vercel.app'}/login.html" style="display:inline-block;margin-top:16px;background:#1A5C3A;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;">Sign in to Costarax</a>
    </div>`
  }
}

module.exports = { sendEmail, quoteReceivedEmail, quoteRepliedEmail, accessRequestEmail, accessApprovedEmail }

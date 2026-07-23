const cron  = require('node-cron');
const axios = require('axios');
const supabase = require('../config/supabase');


async function brevoSend({ to, subject, html, from = process.env.MAIL_FROM_SUPPORT }) {
  return axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:  { email: from, name: 'Bullion Algo System' },
      to:      [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
    }
  );
}


function expiryWarningEmail(name, expiresAt, daysLeft) {
  const date = new Date(expiresAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return {
    subject: `Your Bullion Algo subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #080B10; color: #E8E2D5; margin: 0; padding: 0; }
          .wrap { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
          .logo { font-size: 1.2rem; font-weight: 600; color: #C9A84C; letter-spacing: 0.05em; margin-bottom: 36px; }
          .logo span { color: #E8E2D5; }
          h1 { font-size: 1.6rem; font-weight: 300; color: #E8E2D5; margin-bottom: 16px; }
          h1 em { font-style: italic; color: #C9A84C; }
          p { font-size: 0.9rem; color: #8A8275; line-height: 1.7; margin-bottom: 16px; }
          .highlight { color: #E8C97A; font-weight: 600; }
          .btn {
            display: inline-block; margin-top: 24px;
            background: linear-gradient(135deg, #C9A84C, #E8C97A);
            color: #080B10; text-decoration: none;
            padding: 14px 32px; border-radius: 4px;
            font-size: 0.78rem; font-weight: 700; letter-spacing: 0.12em;
            text-transform: uppercase;
          }
          .divider { height: 1px; background: rgba(201,168,76,0.12); margin: 32px 0; }
          .footer { font-size: 0.72rem; color: #4A4540; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="logo">Bullion <span>Algo</span></div>
          <h1>Your access expires <em>soon.</em></h1>
          <p>Hi ${name},</p>
          <p>
            Your Bullion Algo subscription is set to expire on
            <span class="highlight">${date}</span> — that's
            <span class="highlight">${daysLeft} day${daysLeft !== 1 ? 's' : ''}</span> from now.
          </p>
          <p>
            Once your subscription expires, your MT5 account will be disconnected from
            the copy-trade feed and the algorithm will stop executing trades on your account.
          </p>
          <p>Renew now to keep the algorithm running without interruption.</p>
          <a href="https://bullionalgosystem.com/#pricing" class="btn">Renew Subscription →</a>
          <div class="divider"></div>
          <p class="footer">
            If you have any questions, reach us on
            <a href="https://whatsapp.com/channel/0029Vb7OzbL2v1J1Q1EoKS2H" style="color:#C9A84C;">WhatsApp</a>.<br>
            © 2026 Bullion Algo Systems. All rights reserved.<br>
            You're receiving this because you have an active BAS subscription.
          </p>
        </div>
      </body>
      </html>
    `,
  };
}

function expiredEmail(name) {
  return {
    subject: 'Your Bullion Algo subscription has expired',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #080B10; color: #E8E2D5; margin: 0; padding: 0; }
          .wrap { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
          .logo { font-size: 1.2rem; font-weight: 600; color: #C9A84C; letter-spacing: 0.05em; margin-bottom: 36px; }
          .logo span { color: #E8E2D5; }
          h1 { font-size: 1.6rem; font-weight: 300; color: #E8E2D5; margin-bottom: 16px; }
          p { font-size: 0.9rem; color: #8A8275; line-height: 1.7; margin-bottom: 16px; }
          .btn { display: inline-block; margin-top: 24px; background: linear-gradient(135deg, #C9A84C, #E8C97A); color: #080B10; text-decoration: none; padding: 14px 32px; border-radius: 4px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
          .divider { height: 1px; background: rgba(201,168,76,0.12); margin: 32px 0; }
          .footer { font-size: 0.72rem; color: #4A4540; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="logo">Bullion <span>Algo</span></div>
          <h1>Your subscription has expired.</h1>
          <p>Hi ${name},</p>
          <p>
            Your Bullion Algo subscription has expired and your MT5 account has been
            disconnected from the copy-trade feed. The algorithm is no longer executing
            trades on your account.
          </p>
          <p>Renew your subscription to restore access and resume automated trading.</p>
          <a href="https://bullionalgosystem.com/#pricing" class="btn">Renew Now →</a>
          <div class="divider"></div>
          <p class="footer">
            Questions? Contact us on
            <a href="https://whatsapp.com/channel/0029Vb7OzbL2v1J1Q1EoKS2H" style="color:#C9A84C;">WhatsApp</a>.<br>
            © 2026 Bullion Algo Systems. All rights reserved.
          </p>
        </div>
      </body>
      </html>
    `,
  };
}


function adminEaRemovalEmail(accounts) {
  const rows = accounts.map(a => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(201,168,76,0.12);">${a.name || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(201,168,76,0.12);">${a.email || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(201,168,76,0.12);">${a.server}</td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(201,168,76,0.12);">${a.account_number}</td>
    </tr>
  `).join('');

  return {
    subject: `[Action needed] ${accounts.length} MT5 account${accounts.length !== 1 ? 's' : ''} need EA removed — subscription expired`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="font-family: 'Helvetica Neue', Arial, sans-serif; background:#080B10; color:#E8E2D5; margin:0; padding:0;">
        <div style="max-width:640px;margin:0 auto;padding:32px 24px;">
          <h2 style="font-weight:300;color:#E8E2D5;">EA removal needed</h2>
          <p style="font-size:0.9rem;color:#8A8275;line-height:1.6;">
            The following ${accounts.length} account${accounts.length !== 1 ? 's' : ''} just had ${accounts.length !== 1 ? 'their' : 'its'}
            subscription expire and ${accounts.length !== 1 ? 'are' : 'is'} now marked <b>disconnected</b> in Supabase.
            Since copy-trading is manual (EA attached directly to each terminal), this is a reminder to
            log in and remove the EA from each account below.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:0.85rem;">
            <thead>
              <tr style="text-align:left;color:#C9A84C;">
                <th style="padding:8px 12px;">Name</th>
                <th style="padding:8px 12px;">Email</th>
                <th style="padding:8px 12px;">Server</th>
                <th style="padding:8px 12px;">Account #</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </body>
      </html>
    `,
  };
}


async function sendEmail(toEmail, subject, html) {
  try {
    await brevoSend({ to: toEmail, subject, html });
    console.log(`[SubscriptionChecker] Email sent to ${toEmail}: "${subject}"`);
  } catch (err) {
    console.error(`[SubscriptionChecker] Failed to send email to ${toEmail}:`, err.response?.data || err.message);
  }
}


async function runSubscriptionCheck() {
  console.log('[SubscriptionChecker] Running at', new Date().toISOString());

  const now     = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  try {


    const { data: expiringSoon } = await supabase
      .from('subscriptions')
      .select(`
        id, expires_at, plan, status,
        users ( id, name, email )
      `)
      .eq('status', 'active')
      .lte('expires_at', in3Days.toISOString())
      .gt('expires_at', now.toISOString());   // not yet expired

    if (expiringSoon?.length) {
      console.log(`[SubscriptionChecker] ${expiringSoon.length} subscription(s) expiring within 3 days`);

      for (const sub of expiringSoon) {
        const user = sub.users;
        if (!user?.email) continue;

        const expiresAt = new Date(sub.expires_at);
        const msLeft     = expiresAt - now;
        const daysLeft   = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

        // Only send on 3-day and 1-day marks to avoid spamming daily
        if (daysLeft !== 3 && daysLeft !== 1) continue;

        const { subject, html } = expiryWarningEmail(user.name, sub.expires_at, daysLeft);
        await sendEmail(user.email, subject, html);
      }
    }


    const { data: justExpired } = await supabase
      .from('subscriptions')
      .select(`
        id, expires_at, plan,
        users ( id, name, email ),
        mt5_accounts ( id, server, account_number )
      `)
      .eq('status', 'active')
      .lt('expires_at', now.toISOString());   // already past expiry

    if (justExpired?.length) {
      console.log(`[SubscriptionChecker] ${justExpired.length} expired subscription(s) to process`);


      const needsEaRemoval = [];

      for (const sub of justExpired) {
        const user    = sub.users;
        const mt5Acct = sub.mt5_accounts;


        if (mt5Acct?.id) {
          await supabase
            .from('mt5_accounts')
            .update({ status: 'disconnected', updated_at: now.toISOString() })
            .eq('id', mt5Acct.id);

          needsEaRemoval.push({
            name:           user?.name,
            email:          user?.email,
            server:         mt5Acct.server,
            account_number: mt5Acct.account_number,
          });
        }


        await supabase
          .from('subscriptions')
          .update({ status: 'expired', updated_at: now.toISOString() })
          .eq('id', sub.id);


        if (user?.email) {
          const { subject, html } = expiredEmail(user.name);
          await sendEmail(user.email, subject, html);
        }
      }


      if (needsEaRemoval.length && process.env.ADMIN_NOTIFICATION_EMAIL) {
        const { subject, html } = adminEaRemovalEmail(needsEaRemoval);
        await sendEmail(process.env.ADMIN_NOTIFICATION_EMAIL, subject, html);
      } else if (needsEaRemoval.length) {
        console.warn('[SubscriptionChecker] ADMIN_NOTIFICATION_EMAIL not set — skipping EA-removal admin alert for', needsEaRemoval.length, 'account(s).');
      }
    }

    console.log('[SubscriptionChecker] Done.');

  } catch (err) {
    console.error('[SubscriptionChecker] Fatal error:', err);
  }
}


cron.schedule('0 9 * * *', runSubscriptionCheck, {
  timezone: 'UTC',
});


if (process.env.NODE_ENV !== 'production') {
  console.log('[SubscriptionChecker] Running initial check (dev mode)...');
  runSubscriptionCheck();
}

console.log('[SubscriptionChecker] Scheduled — runs daily at 09:00 UTC');

module.exports = { runSubscriptionCheck };
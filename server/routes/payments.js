const express  = require('express');
const axios    = require('axios');
const supabase = require('../config/supabase');
const router   = express.Router();

// ── Plan config ──
const PLANS = {
  premium_monthly:     { amount: 45,  days: 30,  flwPlanId: process.env.FLW_PREMIUM_MONTHLY },
  premium_semi_annual: { amount: 260, days: 180, flwPlanId: process.env.FLW_PREMIUM_SEMI_ANNUALLY },
  premium_yearly:      { amount: 500, days: 365, flwPlanId: process.env.FLW_PREMIUM_YEARLY },
  trial:               { amount: 9,   days: 7,   flwPlanId: process.env.FLW_TRIAL },
};

// ─────────────────────────────────────────────
//  POST /payments/subscribe
// ─────────────────────────────────────────────
router.post('/subscribe', async (req, res) => {
  const { plan, guest_name, guest_email } = req.body;

  // ── Resolve user identity ──
  let userEmail, userName, userId;

  if (req.isAuthenticated()) {
    userEmail = req.user.email;
    userName  = req.user.name;
    userId    = req.user.id;
  } else if (guest_email && guest_name) {
    userEmail = guest_email;
    userName  = guest_name;
    userId    = null;
  } else {
    return res.status(401).json({ error: 'Please provide your details to continue.' });
  }

  // ── Validate plan ──
  const selectedPlan = PLANS[plan];
  if (!selectedPlan) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }

  if (!selectedPlan.flwPlanId) {
    console.error(`[Payments] Missing Flutterwave plan ID for: ${plan}`);
    return res.status(500).json({ error: 'Payment plan not configured. Contact support.' });
  }

  try {
    const tx_ref = `bas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // ── Initialize Flutterwave payment with payment_plan attached ──
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref,
        amount:       selectedPlan.amount,
        currency:     'USD',
        payment_plan: selectedPlan.flwPlanId,   // ← this makes it recurring
        redirect_url: `${process.env.FRONTEND_URL}/payment-success.html`,
        customer: {
          email: userEmail,
          name:  userName,
        },
        meta: {
          user_id: userId,   // passed back in webhook payload
          plan,
        },
        customizations: {
          title:       'Bullion Algo Subscription',
          description: `${plan.replace(/_/g, ' ')} plan`,
          logo:        `${process.env.FRONTEND_URL}/assets/logo-colored.svg`,
        },
      },
      {
        headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
      }
    );

    // ── Record pending payment in Supabase ──
    await supabase.from('payments').insert([{
      user_id:     userId,
      plan,
      amount:      selectedPlan.amount,
      status:      'pending',
      tx_ref,
      guest_email: userId ? null : userEmail,
      guest_name:  userId ? null : userName,
    }]);

    res.json({ success: true, payment_url: response.data.data.link });

  } catch (err) {
    console.error('[Payments] Subscribe error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not initialize payment. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  POST /payments/request-trial
//  Paid 7-day trial ($9) — charged via Flutterwave, same as a regular
//  subscription. Activation is automatic on successful payment (handled
//  in handleSuccessfulCharge below) — no admin approval step anymore.
//  A row is still written to trial_requests so trial signups remain
//  tracked/visible on their own, separate from the subscriptions table.
// ─────────────────────────────────────────────
router.post('/request-trial', async (req, res) => {
  const { guest_name, guest_email } = req.body;

  let userId, userEmail, userName;

  if (req.isAuthenticated()) {
    userId    = req.user.id;
    userEmail = req.user.email;
    userName  = req.user.name;
  } else if (guest_email && guest_name) {
    userId    = null;
    userEmail = guest_email;
    userName  = guest_name;
  } else {
    return res.status(401).json({ error: 'Please provide your details to continue.' });
  }

  const trialPlan = PLANS.trial;
  if (!trialPlan.flwPlanId) {
    console.error('[Trial] Missing Flutterwave plan ID for trial');
    return res.status(500).json({ error: 'Trial plan not configured. Contact support.' });
  }

  try {
    // Prevent duplicate trial requests for the same user/email
    const { data: existing } = await supabase
      .from('trial_requests')
      .select('id, status')
      .eq(userId ? 'user_id' : 'guest_email', userId || userEmail)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        error: 'A trial request already exists for this account. Contact support for changes.'
      });
    }

    const tx_ref = `bas-trial-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // ── Initialize Flutterwave payment for the $9 trial ──
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref,
        amount:       trialPlan.amount,
        currency:     'USD',
        payment_plan: trialPlan.flwPlanId,
        redirect_url: `${process.env.FRONTEND_URL}/payment-success.html`,
        customer: {
          email: userEmail,
          name:  userName,
        },
        meta: {
          user_id: userId,
          plan:    'trial',
        },
        customizations: {
          title:       'Bullion Algo — 7-Day Trial',
          description: '7-day trial access',
          logo:        `${process.env.FRONTEND_URL}/assets/logo-colored.svg`,
        },
      },
      {
        headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
      }
    );

    // ── Record the trial request (still pending until webhook confirms payment) ──
    const { error: insertError } = await supabase
      .from('trial_requests')
      .insert([{
        user_id:     userId,
        guest_name:  userId ? null : userName,
        guest_email: userId ? null : userEmail,
        status:      'pending',
      }]);

    if (insertError) {
      console.error('[Trial] Insert error:', insertError);
      // Payment link was already generated — don't block the user over a
      // logging failure, but flag it loudly since trial_requests is now
      // out of sync with what's about to happen on Flutterwave's side.
      console.error('[Trial] Continuing despite trial_requests insert failure — tx_ref:', tx_ref);
    }

    // ── Record pending payment, same table /subscribe uses ──
    await supabase.from('payments').insert([{
      user_id:     userId,
      plan:        'trial',
      amount:      trialPlan.amount,
      status:      'pending',
      tx_ref,
      guest_email: userId ? null : userEmail,
      guest_name:  userId ? null : userName,
    }]);

    console.log(`[Trial] Payment initiated for ${userEmail}`);
    res.json({ success: true, payment_url: response.data.data.link });

  } catch (err) {
    console.error('[Trial] Request error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not initialize trial payment. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  POST /payments/webhook
//  Handles Flutterwave webhook events:
//    - charge.completed  → first payment or renewal (subscriptions AND trial)
//    - subscription.*    → subscription lifecycle events
// ─────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {

  // ── Verify webhook hash ──
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
    console.warn('[Webhook] Invalid signature — request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    console.error('[Webhook] Failed to parse body:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log(`[Webhook] Event received: ${event.event}`, JSON.stringify(event.data?.id));

  // ── Respond to Flutterwave immediately (must be fast) ──
  res.status(200).json({ received: true });

  // ── Process event asynchronously ──
  try {
    if (event.event === 'charge.completed' && event.data?.status === 'successful') {
      await handleSuccessfulCharge(event.data);
    }

    if (event.event === 'subscription.cancelled') {
      await handleSubscriptionCancelled(event.data);
    }

  } catch (err) {
    // Don't re-throw — webhook already responded 200
    console.error('[Webhook] Processing error:', err.message);
  }
});

// ─────────────────────────────────────────────
//  handleSuccessfulCharge
//  Fires on BOTH first payment and every renewal — including the $9
//  trial, which is just another entry in PLANS as far as this function
//  is concerned.
// ─────────────────────────────────────────────
async function handleSuccessfulCharge(data) {
  const tx_ref = data.tx_ref;
  const meta   = data.meta || {};

  // Extract user_id and plan from meta (set during initialization)
  let userId = meta.user_id || null;
  let plan   = meta.plan   || null;

  // ── Verify the transaction with Flutterwave (security best practice) ──
  try {
    const verify = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${data.id}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    if (verify.data.data.status !== 'successful') {
      console.warn(`[Webhook] Transaction ${data.id} failed verification`);
      return;
    }
  } catch (err) {
    console.error('[Webhook] Verification failed:', err.message);
    return;
  }

  // ── If user_id not in meta, look up by email (guest or renewal) ──
  if (!userId && data.customer?.email) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', data.customer.email)
      .single();
    userId = user?.id || null;
  }

  // ── If plan not in meta, look up from tx_ref in payments table ──
  if (!plan && tx_ref) {
    const { data: payment } = await supabase
      .from('payments')
      .select('plan')
      .eq('tx_ref', tx_ref)
      .single();
    plan = payment?.plan || null;
  }

  if (!userId) {
    console.warn(`[Webhook] Could not resolve user_id for tx_ref: ${tx_ref}`);
    return;
  }

  if (!plan || !PLANS[plan]) {
    console.warn(`[Webhook] Could not resolve plan for tx_ref: ${tx_ref}`);
    return;
  }

  const planConfig = PLANS[plan];
  const now        = new Date();
  const expiresAt  = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000).toISOString();

  // ── Upsert subscription in Supabase ──
  const { error: subError } = await supabase
    .from('subscriptions')
    .upsert({
      user_id:             userId,
      plan,
      status:              'active',
      expires_at:          expiresAt,
      flw_subscription_id: data.plan?.id?.toString() || null,
      updated_at:          now.toISOString(),
    }, {
      onConflict: 'user_id',  // update existing subscription if user already has one
    });

  if (subError) {
    console.error('[Webhook] Subscription upsert error:', subError);
    return;
  }

  // ── Update payments table ──
  await supabase
    .from('payments')
    .update({ status: 'successful', updated_at: now.toISOString() })
    .eq('tx_ref', tx_ref);

  console.log(`[Webhook] Subscription active for user ${userId} until ${expiresAt}`);

  // ── If this was the paid trial, mark the matching trial_requests row
  //    as approved so it stops showing as pending — payment IS the
  //    approval now, no admin click needed. ──
  if (plan === 'trial') {
    const matchColumn = userId ? 'user_id' : 'guest_email';
    const matchValue  = userId || data.customer?.email;

    if (matchValue) {
      const { error: trialUpdateError } = await supabase
        .from('trial_requests')
        .update({
          status:      'approved',
          approved_at: now.toISOString(),
        })
        .eq(matchColumn, matchValue)
        .eq('status', 'pending');

      if (trialUpdateError) {
        console.error('[Webhook] Trial request update error:', trialUpdateError);
      } else {
        console.log(`[Webhook] Trial request marked approved for ${matchColumn}: ${matchValue}`);
      }
    }
  }
}

// ─────────────────────────────────────────────
//  handleSubscriptionCancelled
//  User cancelled recurring charge on Flutterwave side
// ─────────────────────────────────────────────
async function handleSubscriptionCancelled(data) {
  const flwSubscriptionId = data.id?.toString();
  if (!flwSubscriptionId) return;

  // Find the subscription in Supabase
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('flw_subscription_id', flwSubscriptionId)
    .single();

  if (!sub) {
    console.warn(`[Webhook] No subscription found for flw_id: ${flwSubscriptionId}`);
    return;
  }

  // Mark as cancelled — subscriptionChecker will handle disabling on expiry date
  await supabase
    .from('subscriptions')
    .update({
      status:     'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('flw_subscription_id', flwSubscriptionId);

  console.log(`[Webhook] Subscription cancelled for user ${sub.user_id} — access until expiry date`);
}

module.exports = router;
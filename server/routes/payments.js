const express  = require('express');
const axios    = require('axios');
const supabase = require('../config/supabase');
const router   = express.Router();


const PLANS = {
  premium_monthly:     { amount: 45,  days: 30,  flwPlanId: process.env.FLW_PREMIUM_MONTHLY },
  premium_semi_annual: { amount: 260, days: 180, flwPlanId: process.env.FLW_PREMIUM_SEMI_ANNUALLY },
  premium_yearly:      { amount: 500, days: 365, flwPlanId: process.env.FLW_PREMIUM_YEARLY },
  trial:               { amount: 9,   days: 7,   flwPlanId: process.env.FLW_TRIAL },
};


router.post('/subscribe', async (req, res) => {
  const { plan, guest_name, guest_email } = req.body;

  
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

    
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref,
        amount:       selectedPlan.amount,
        currency:     'USD',
        payment_plan: selectedPlan.flwPlanId,  
        redirect_url: `${process.env.FRONTEND_URL}/payment-success.html`,
        customer: {
          email: userEmail,
          name:  userName,
        },
        meta: {
          user_id: userId,   
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
      console.error('[Trial] Continuing despite trial_requests insert failure — tx_ref:', tx_ref);
    }

    
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


router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {

  
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

  
  res.status(200).json({ received: true });

  
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


async function handleSuccessfulCharge(data) {
  const tx_ref = data.tx_ref;
  const meta   = data.meta || {};

  
  let userId = meta.user_id || null;
  let plan   = meta.plan   || null;

  
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

  
  if (!userId && data.customer?.email) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', data.customer.email)
      .single();
    userId = user?.id || null;
  }

  
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
      onConflict: 'user_id',  
    });

  if (subError) {
    console.error('[Webhook] Subscription upsert error:', subError);
    return;
  }

  
  await supabase
    .from('payments')
    .update({ status: 'successful', updated_at: now.toISOString() })
    .eq('tx_ref', tx_ref);

  console.log(`[Webhook] Subscription active for user ${userId} until ${expiresAt}`);

  
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


async function handleSubscriptionCancelled(data) {
  const flwSubscriptionId = data.id?.toString();
  if (!flwSubscriptionId) return;

  
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('flw_subscription_id', flwSubscriptionId)
    .single();

  if (!sub) {
    console.warn(`[Webhook] No subscription found for flw_id: ${flwSubscriptionId}`);
    return;
  }

  
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
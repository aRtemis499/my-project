const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const protect = require('../middleware/authMiddleware');
require('dotenv').config();

const router = express.Router();

const PLANS = {
  premium_monthly: process.env.FLW_PREMIUM_MONTHLY,
  premium_semi_annually: process.env.FLW_PREMIUM_SEMI-ANNUALLY,
  premium_yearly: process.env.FLW_PREMIUM_YEARLY,
};

// --- Initialize a subscription ---
router.post('/subscribe', protect, async (req, res) => {
  const { plan } = req.body; // e.g. "premium_monthly"
  const user = req.user;

  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  try {
    const tx_ref = `tx-${user.id}-${Date.now()}`; // unique transaction reference

    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref,
        amount: 0,          // Flutterwave uses the plan amount
        currency: 'USD',
        payment_plan: PLANS[plan],
        redirect_url: `${process.env.FRONTEND_URL}/payment-success.html`,
        customer: {
          email: user.email,
          name: user.name
        },
        customizations: {
          title: 'My App Subscription',
          description: `${plan} plan`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    // Save a pending payment record
    await supabase.from('payments').insert([{
      user_id: user.id,
      plan,
      amount: 0,
      status: 'pending',
      tx_ref
    }]);

    // Send Flutterwave checkout URL to frontend
    res.json({
      success: true,
      payment_url: response.data.data.link
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not initialize payment' });
  }
});

// --- Webhook — Flutterwave calls this after payment ---
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  
  // Verify webhook is from Flutterwave
  const signature = req.headers['verif-hash'];
  if (signature !== process.env.FLW_WEBHOOK_HASH) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body);

  if (event.event === 'subscription.activated') {
    const { customer, plan, amount } = event.data;

    // Find user by email
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', customer.email)
      .single();

    if (user) {
      // Update payment record to active
      await supabase
        .from('payments')
        .update({
          status: 'active',
          amount,
        })
        .eq('user_id', user.id)
        .eq('status', 'pending');
    }
  }

  res.sendStatus(200);
});

// --- Get current user's subscription ---
router.get('/my-subscription', protect, async (req, res) => {
  const { data: payment } = await supabase
    .from('payments')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();

  res.json({ subscription: payment || null });
});

module.exports = router;
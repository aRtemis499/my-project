const express = require('express');
const axios = require('axios');
const supabase = require('../config/supabase');
const router = express.Router();

const PLANS = {
    premium_monthly:     35,
    premium_semi_annual: 200,
    premium_yearly:      360
};

router.post('/subscribe', async (req, res) => {
    const { plan, guest_name, guest_email } = req.body;
    
    let userEmail, userName;
    
    if (req.isAuthenticated()) {
        userEmail = req.user.email;
        userName = req.user.name;
    } else if (guest_email && guest_name) {
        userEmail = guest_email;
        userName = guest_name;
    } else {
        return res.status(401).json({ error: 'Please provide your details to continue' });
    }

    if (!PLANS[plan]) {
        return res.status(400).json({ error: 'Invalid plan selected' });
    }

    try {
        const tx_ref = `tx-${Date.now()}`;

        const response = await axios.post(
            'https://api.flutterwave.com/v3/payments',
            {
                tx_ref,
                amount: PLANS[plan],  // ← fixed, was 0
                currency: 'USD',
                redirect_url: `${process.env.FRONTEND_URL}/payment-success.html`,
                customer: {
                    email: userEmail,
                    name: userName
                },
                customizations: {
                    title: 'Bullion Algo Subscription',
                    description: `${plan} plan`
                }
            },
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
        );

        const userId = req.isAuthenticated() ? req.user.id : null;
        
        await supabase.from('payments').insert([{
            user_id: userId,
            plan,
            amount: PLANS[plan],
            status: 'pending',
            tx_ref,
            guest_email: userId ? null : userEmail,
            guest_name: userId ? null : userName
        }]);

        res.json({ success: true, payment_url: response.data.data.link });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Could not initialize payment' });
    }
});

module.exports = router;
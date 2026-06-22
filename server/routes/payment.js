router.post('/subscribe', async (req, res) => {
    const { plan, guest_name, guest_email } = req.body;
    
    // Use logged in user or guest details
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
                amount: 0,
                currency: 'USD',
                payment_plan: PLANS[plan],
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

        // Save pending payment — link to user if logged in
        const userId = req.isAuthenticated() ? req.user.id : null;
        
        await supabase.from('payments').insert([{
            user_id: userId,
            plan,
            amount: 0,
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
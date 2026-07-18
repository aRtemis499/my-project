const express = require('express');
const supabase = require('../config/supabase');
const protect = require('../middleware/authMiddleware');

const router = express.Router();


router.get('/', protect, async (req, res) => {
  const user_id = req.user.id;

  try {
    
    const { data: subscription } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    
    const { data: mt5 } = await supabase
      .from('mt5_accounts')
      .select('account_number, server, status, created_at')
      .eq('user_id', user_id)
      .single();

    
    res.json({
      user: {
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        joined: req.user.created_at
      },
      subscription: subscription || null,
      mt5: mt5 || null
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load dashboard' });
  }
});

module.exports = router;
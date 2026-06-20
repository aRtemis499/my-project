const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();

router.post('/subscribe', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const { error } = await supabase
      .from('newsletter')
      .insert([{ email }]);

    if (error) {
      if (error.code === '23505') {
        return res.json({ success: true, message: 'Already subscribed!' });
      }
      throw error;
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not subscribe' });
  }
});

module.exports = router;
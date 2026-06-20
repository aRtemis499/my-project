const express = require('express');
const supabase = require('../config/supabase');
const protect = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminMiddleware');

const router = express.Router();

// Apply both middlewares to ALL admin routes
router.use(protect, adminOnly);

// --- Get all users ---
router.get('/users', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, role, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ users });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

// --- Get all MT5 account submissions ---
router.get('/mt5-accounts', async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('mt5_accounts')
      .select(`
        *,
        users (name, email)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ accounts });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not fetch MT5 accounts' });
  }
});

// --- Update MT5 account status (connect or reject) ---
router.patch('/mt5-accounts/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'connected' or 'rejected'

  if (!['connected', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be connected or rejected' });
  }

  try {
    const { data, error } = await supabase
      .from('mt5_accounts')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, account: data });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not update account status' });
  }
});

// --- Get all payments ---
router.get('/payments', async (req, res) => {
  try {
    const { data: payments, error } = await supabase
      .from('payments')
      .select(`
        *,
        users (name, email)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ payments });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not fetch payments' });
  }
});

// --- Get overview stats ---
router.get('/stats', async (req, res) => {
  try {
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const { count: activeSubscriptions } = await supabase
      .from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: pendingMt5 } = await supabase
      .from('mt5_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: connectedMt5 } = await supabase
      .from('mt5_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'connected');

    res.json({
      totalUsers,
      activeSubscriptions,
      pendingMt5,
      connectedMt5
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not fetch stats' });
  }
});

// --- Invite user as admin ---
router.post('/invite', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    // Check if user exists
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'No account found with that email. They need to sign up first.' });
    }

    if (user.role === 'admin') {
      return res.status(400).json({ error: 'This user is already an admin.' });
    }

    // Update their role to admin
    await supabase
      .from('users')
      .update({ role: 'admin' })
      .eq('email', email);

    res.json({ success: true, message: `${user.name} has been added as admin!` });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// --- Get all admins ---
router.get('/admins', async (req, res) => {
  try {
    const { data: admins } = await supabase
      .from('users')
      .select('id, name, email, role')
      .eq('role', 'admin');

    res.json({ admins });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not fetch admins' });
  }
});


module.exports = router;
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

router.get('/live-summary', async (req, res) => {
    try {
        const { data: accounts } = await supabase
            .from('mt5_accounts')
            .select('metaapi_account_id')
            .eq('status', 'connected');

        if (!accounts || accounts.length === 0) {
            return res.json({
                totalBalance: 0, totalEquity: 0, totalProfit: 0,
                floatingPnl: 0, totalTrades: 0, winRate: 0, dailyData: []
            });
        }

        const MetaApi = require('metaapi.cloud-sdk').default;
        const metaApi = new MetaApi(process.env.METAAPI_TOKEN);

        let totalBalance = 0, totalEquity = 0, totalProfit = 0;
        let allHistory = [], allPositions = [];

        await Promise.all(accounts.map(async (acc) => {
            try {
                const account = await metaApi.metatraderAccountApi.getAccount(acc.metaapi_account_id);
                const connection = account.getRPCConnection();
                await connection.connect();
                await connection.waitSynchronized();

                const info = await connection.getAccountInformation();
                totalBalance += info.balance || 0;
                totalEquity += info.equity || 0;
                totalProfit += info.profit || 0;

                const positions = await connection.getPositions();
                allPositions.push(...(positions || []));

                const endTime = new Date();
                const startTime = new Date();
                startTime.setDate(startTime.getDate() - 30);
                const orders = await connection.getHistoryOrdersByTimeRange(startTime, endTime);
                allHistory.push(...(orders.history || []));
            } catch (e) {
                console.error('Error fetching account:', e.message);
            }
        }));

        // Floating PnL = total equity - total balance
        const floatingPnl = totalEquity - totalBalance;

        // Total trades & win rate from history
        const closedTrades = allHistory.filter(o => o.profit !== undefined);
        const wonTrades = closedTrades.filter(o => o.profit > 0);
        const winRate = closedTrades.length > 0
            ? Math.round((wonTrades.length / closedTrades.length) * 100)
            : 0;

        // Build daily balance snapshots (last 30 days)
        const dailyPnl = {};
        allHistory.forEach(order => {
            if (!order.doneTime || order.profit === undefined) return;
            const day = new Date(order.doneTime).toISOString().split('T')[0];
            dailyPnl[day] = (dailyPnl[day] || 0) + order.profit;
        });

        const days = [];
        let runningBalance = totalBalance;
        for (let i = 0; i < 30; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            days.unshift({ date: key, balance: runningBalance });
            runningBalance -= (dailyPnl[key] || 0);
        }

        res.json({
            totalBalance,
            totalEquity,
            totalProfit,
            floatingPnl,
            totalTrades: closedTrades.length,
            winRate,
            dailyData: days
        });

    } catch (err) {
        console.error('Live summary error:', err.message);
        res.status(500).json({ error: 'Could not fetch live summary' });
    }
});
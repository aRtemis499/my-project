const express   = require('express');
const router    = express.Router();
const supabase = require('../config/supabase');
const {
  addSlaveAccount,
  enableSlaveAccount,
  disableSlaveAccount,
} = require('../utils/duplikium'); // adjust path if needed

// ── Admin guard ──
function requireAdmin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ─────────────────────────────────────────────
//  PATCH /admin/mt5-accounts/:id
//  Update account status + sync with Duplikium
// ─────────────────────────────────────────────
router.patch('/mt5-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;

    const validStatuses = ['connected', 'pending', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    // Fetch the current account record
    const { data: account, error: fetchError } = await supabase
      .from('mt5_accounts')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    let duplikiumAccountId = account.duplikium_account_id;

    // ── Handle Duplikium sync based on new status ──

    if (status === 'connected') {

      if (!duplikiumAccountId) {
        // First time connecting — register as a new slave on Duplikium
        try {
          console.log(`[Admin] Registering account #${account.account_number} on Duplikium...`);
          const duplikiumAccount = await addSlaveAccount({
            account_number:    account.account_number,
            investor_password: account.investor_password,
            server:            account.server,
          });
          duplikiumAccountId = duplikiumAccount.account_id;
          console.log(`[Admin] Duplikium slave created: ${duplikiumAccountId}`);
        } catch (dupErr) {
          console.error('[Admin] Duplikium addSlaveAccount failed:', dupErr.message);
          // Don't block the admin — log the error and continue
          // The admin can retry or add manually in Duplikium cockpit
        }
      } else {
        // Already exists on Duplikium — just re-enable it
        try {
          await enableSlaveAccount(duplikiumAccountId);
          console.log(`[Admin] Duplikium slave re-enabled: ${duplikiumAccountId}`);
        } catch (dupErr) {
          console.error('[Admin] Duplikium enableSlaveAccount failed:', dupErr.message);
        }
      }

    } else if (status === 'rejected' || status === 'pending') {

      // If account exists on Duplikium, disable it
      if (duplikiumAccountId) {
        try {
          await disableSlaveAccount(duplikiumAccountId);
          console.log(`[Admin] Duplikium slave disabled: ${duplikiumAccountId}`);
        } catch (dupErr) {
          console.error('[Admin] Duplikium disableSlaveAccount failed:', dupErr.message);
        }
      }

    }

    // ── Update Supabase ──
    const { error: updateError } = await supabase
      .from('mt5_accounts')
      .update({
        status:               status,
        duplikium_account_id: duplikiumAccountId,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) {
      console.error('[Admin] Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to update status in database.' });
    }

    console.log(`[Admin] Account ${id} status updated to '${status}'`);

    res.json({ success: true, status, duplikium_account_id: duplikiumAccountId });

  } catch (err) {
    console.error('[Admin] Status update error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  GET /admin/mt5-accounts
//  All submitted MT5 accounts
// ─────────────────────────────────────────────
router.get('/mt5-accounts', requireAdmin, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('mt5_accounts')
      .select('*, users(name, email)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ accounts: accounts || [] });

  } catch (err) {
    console.error('[Admin] Get accounts error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  GET /admin/stats
//  Total users + active subscriptions
// ─────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const { count: activeSubscriptions } = await supabase
      .from('subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    res.json({ totalUsers, activeSubscriptions });

  } catch (err) {
    console.error('[Admin] Stats error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  GET /admin/live-summary
//  Aggregated MT5 stats across all connected users
// ─────────────────────────────────────────────
router.get('/live-summary', requireAdmin, async (req, res) => {
  try {
    // Pull aggregated data you've stored, or compute from mt5_accounts
    // This assumes you have a cached summary — adjust to your actual schema
    const { data: summary } = await supabase
      .from('admin_summary')
      .select('*')
      .single();

    res.json(summary || {
      totalBalance: 0,
      totalProfit:  0,
      floatingPnl:  0,
      totalTrades:  0,
      winRate:      0,
      dailyData:    [],
    });

  } catch (err) {
    console.error('[Admin] Live summary error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  GET /admin/admins
//  List all admin users (for invite panel)
// ─────────────────────────────────────────────
router.get('/admins', requireAdmin, async (req, res) => {
  try {
    const { data: admins } = await supabase
      .from('users')
      .select('id, name, email, avatar')
      .eq('role', 'admin');

    res.json({ admins: admins || [] });

  } catch (err) {
    console.error('[Admin] Get admins error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  POST /admin/invite
//  Promote a user to admin by email
// ─────────────────────────────────────────────
router.post('/invite', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { data: user, error } = await supabase
      .from('users')
      .update({ role: 'admin' })
      .eq('email', email)
      .select()
      .single();

    if (error || !user) {
      return res.status(404).json({
        error: 'No user found with that email. They must sign in first.'
      });
    }

    res.json({ success: true, message: `${user.name} has been promoted to admin.` });

  } catch (err) {
    console.error('[Admin] Invite error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
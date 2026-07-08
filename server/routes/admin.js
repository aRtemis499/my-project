const express   = require('express');
const router    = express.Router();
const supabase = require('../config/supabase');
const MetaApi   = require('metaapi.cloud-sdk').default;
const {
  addSlaveAccount,
  enableSlaveAccount,
  disableSlaveAccount,
} = require('../utils/duplikium'); // adjust path if needed

const metaApi = new MetaApi(process.env.METAAPI_TOKEN);

// ── Admin guard ──
function requireAdmin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ─────────────────────────────────────────────
//  PATCH /admin/mt5-accounts/:id
//  Update account status + sync with Duplikium + MetaApi
// ─────────────────────────────────────────────
router.patch('/mt5-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;

    const validStatuses = ['connected', 'pending', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    const { data: account, error: fetchError } = await supabase
      .from('mt5_accounts')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    let duplikiumAccountId = account.duplikium_account_id;
    let metaapiAccountId   = account.metaapi_account_id;

    if (status === 'connected') {

      if (!duplikiumAccountId) {
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
          return res.status(502).json({
            error: 'Duplikium registration failed. Account not marked as connected.',
            detail: dupErr.message,
          });
        }
      } else {
        try {
          await enableSlaveAccount(duplikiumAccountId);
          console.log(`[Admin] Duplikium slave re-enabled: ${duplikiumAccountId}`);
        } catch (dupErr) {
          console.error('[Admin] Duplikium enableSlaveAccount failed:', dupErr.message);
          return res.status(502).json({
            error: 'Duplikium re-enable failed. Account not marked as connected.',
            detail: dupErr.message,
          });
        }
      }

      if (!metaapiAccountId) {
        try {
          console.log(`[Admin] Registering account #${account.account_number} on MetaApi...`);
          const metaAccount = await metaApi.metatraderAccountApi.createAccount({
            name:        `user-${account.user_id}`,
            type:        'cloud',
            login:       account.account_number,
            password:    account.investor_password,
            server:      account.server,
            platform:    'mt5',
            magic:       0,
            reliability: 'high',
          });
          metaapiAccountId = metaAccount.id;
          console.log(`[Admin] MetaApi account created: ${metaapiAccountId}`);
        } catch (metaErr) {
          console.error('[Admin] MetaApi account creation failed:', metaErr.message);
          console.error('[Admin] MetaApi error details:', JSON.stringify(metaErr.details || metaErr.response?.data || metaErr, null, 2));
          return res.status(502).json({
            error: 'MetaApi registration failed. Account not marked as connected.',
            detail: metaErr.message,
          });
        }
      }

    } else if (status === 'rejected' || status === 'pending') {

      if (duplikiumAccountId) {
        try {
          await disableSlaveAccount(duplikiumAccountId);
          console.log(`[Admin] Duplikium slave disabled: ${duplikiumAccountId}`);
        } catch (dupErr) {
          console.error('[Admin] Duplikium disableSlaveAccount failed:', dupErr.message);
        }
      }

    }

    const { error: updateError } = await supabase
      .from('mt5_accounts')
      .update({
        status:               status,
        duplikium_account_id: duplikiumAccountId,
        metaapi_account_id:   metaapiAccountId,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) {
      console.error('[Admin] Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to update status in database.' });
    }

    console.log(`[Admin] Account ${id} status updated to '${status}'`);

    res.json({
      success: true,
      status,
      duplikium_account_id: duplikiumAccountId,
      metaapi_account_id:   metaapiAccountId,
    });

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
//  GET /admin/trial-requests
//  All pending trial requests
// ─────────────────────────────────────────────
router.get('/trial-requests', requireAdmin, async (req, res) => {
  try {
    const { data: requests, error } = await supabase
      .from('trial_requests')
      .select('*, users(name, email)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ requests: requests || [] });

  } catch (err) {
    console.error('[Admin] Get trial requests error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  PATCH /admin/trial-requests/:id
//  Approve or reject a trial request
// ─────────────────────────────────────────────
router.patch('/trial-requests/:id', requireAdmin, async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    const { data: request, error: fetchError } = await supabase
      .from('trial_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Trial request not found.' });
    }

    if (status === 'approved') {
      let userId = request.user_id;

      if (!userId && request.guest_email) {
        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('email', request.guest_email)
          .single();
        userId = user?.id || null;
      }

      const now       = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const { error: subError } = await supabase
        .from('subscriptions')
        .upsert({
          user_id:     userId,
          guest_name:  userId ? null : request.guest_name,
          guest_email: userId ? null : request.guest_email,
          plan:        'trial',
          status:      'active',
          expires_at:  expiresAt,
          updated_at:  now.toISOString(),
        }, { onConflict: userId ? 'user_id' : 'guest_email' });

      if (subError) {
        console.error('[Admin] Trial subscription upsert error:', subError);
        return res.status(500).json({ error: 'Failed to activate trial subscription.' });
      }
    }

    const { error: updateError } = await supabase
      .from('trial_requests')
      .update({
        status:      status,
        approved_at: status === 'approved' ? new Date().toISOString() : null,
      })
      .eq('id', id);

    if (updateError) {
      console.error('[Admin] Trial request update error:', updateError);
      return res.status(500).json({ error: 'Failed to update trial request.' });
    }

    console.log(`[Admin] Trial request ${id} ${status}`);
    res.json({ success: true, status });

  } catch (err) {
    console.error('[Admin] Trial approval error:', err);
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
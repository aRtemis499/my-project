const express   = require('express');
const router    = express.Router();
const supabase = require('../config/supabase');
const MetaApi   = require('metaapi.cloud-sdk').default;
const { decrypt } = require('../utils/crypto');

const metaApi = new MetaApi(process.env.METAAPI_TOKEN);


function requireAdmin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}


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

    let metaapiAccountId = account.metaapi_account_id;

    if (status === 'connected' && !metaapiAccountId) {
      try {
        console.log(`[Admin] Registering account #${account.account_number} on MetaApi...`);
        const metaAccount = await metaApi.metatraderAccountApi.createAccount({
          name:        `user-${account.user_id}`,
          type:        'cloud',
          login:       account.account_number,
          password:    decrypt(account.trading_password),
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

    const { error: updateError } = await supabase
      .from('mt5_accounts')
      .update({
        status:             status,
        metaapi_account_id: metaapiAccountId,
        updated_at:         new Date().toISOString(),
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
      metaapi_account_id: metaapiAccountId,
    });

  } catch (err) {
    console.error('[Admin] Status update error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});


router.get('/mt5-accounts', requireAdmin, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('mt5_accounts')
      .select('id, user_id, server, account_number, status, metaapi_account_id, created_at, updated_at, users(name, email)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ accounts: accounts || [] });

  } catch (err) {
    console.error('[Admin] Get accounts error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});


router.get('/mt5-accounts/:id/credentials', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: account, error } = await supabase
      .from('mt5_accounts')
      .select('server, account_number, trading_password')
      .eq('id', id)
      .single();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    let plainPassword;
    try {
      plainPassword = decrypt(account.trading_password);
    } catch (decryptErr) {
      console.error(`[Admin] Failed to decrypt trading_password for account ${id}:`, decryptErr.message);
      return res.status(500).json({
        error: 'Could not decrypt stored password. It may predate the backfill migration — check with the team.',
      });
    }

    res.json({
      account: {
        server:           account.server,
        account_number:   account.account_number,
        trading_password: plainPassword,
      },
    });

  } catch (err) {
    console.error('[Admin] Get credentials error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});


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


router.get('/live-summary', requireAdmin, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('mt5_accounts')
      .select('metaapi_account_id')
      .eq('status', 'connected')
      .not('metaapi_account_id', 'is', null);

    if (error) throw error;

    if (!accounts || !accounts.length) {
      return res.json({
        totalBalance: 0, totalProfit: 0, floatingPnl: 0,
        totalTrades: 0, winRate: 0, dailyData: [],
      });
    }

    let totalBalance = 0;
    let totalEquity  = 0;
    let totalProfit  = 0;
    let totalTrades  = 0;
    let totalWins    = 0;
    let totalClosed  = 0;
    const combinedProfitByDay = {};

    await Promise.all(accounts.map(async (acc) => {
      try {
        const metaAccount = await metaApi.metatraderAccountApi.getAccount(acc.metaapi_account_id);
        await metaAccount.waitConnected();
        const connection = metaAccount.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        const info      = await connection.getAccountInformation();
        const dealsResp = await connection.getDealsByTimeRange(
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          new Date()
        );
        const history = (dealsResp?.deals || []).filter(d => d.entryType === 'DEAL_ENTRY_OUT');

        totalBalance += info.balance || 0;
        totalEquity  += info.equity  || 0;

        history.forEach(deal => {
          if (deal.profit === undefined) return;
          totalTrades += 1;
          totalProfit += deal.profit;
          totalClosed += 1;
          if (deal.profit > 0) totalWins += 1;

          const day = new Date(deal.time).toISOString().slice(0, 10);
          combinedProfitByDay[day] = (combinedProfitByDay[day] || 0) + deal.profit;
        });

      } catch (accErr) {
        console.error(`[Admin] Live summary — account ${acc.metaapi_account_id} failed:`, accErr.message);
      }
    }));

    const winRate = totalClosed > 0 ? Math.round((totalWins / totalClosed) * 100) : 0;
    const floatingPnl = totalEquity - totalBalance;

    const days = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    let runningBalance = totalBalance;
    const dailyDataReversed = [];
    for (let i = days.length - 1; i >= 0; i--) {
      const day = days[i];
      dailyDataReversed.push({ date: day, balance: runningBalance });
      runningBalance -= (combinedProfitByDay[day] || 0);
    }
    const dailyData = dailyDataReversed.reverse();

    res.json({
      totalBalance,
      totalProfit,
      floatingPnl,
      totalTrades,
      winRate,
      dailyData,
    });

  } catch (err) {
    console.error('[Admin] Live summary error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});


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
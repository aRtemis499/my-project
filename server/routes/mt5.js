const express   = require('express');
const router    = express.Router();
const MetaApi   = require('metaapi.cloud-sdk').default;
const supabase = require('../config/supabase');
const {
  addSlaveAccount,
  enableSlaveAccount,
  disableSlaveAccount,
} = require('../utils/duplikium'); // adjust path if needed


const metaApi = new MetaApi(process.env.METAAPI_TOKEN);

// ── Auth guard ──
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─────────────────────────────────────────────
//  POST /mt5/connect
//  User submits MT5 credentials → save to Supabase
//  Admin still needs to verify + mark connected
// ─────────────────────────────────────────────
router.post('/connect', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { server, account_number, investor_password } = req.body;

    if (!server || !account_number || !investor_password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Check if user already has a pending/connected account
    const { data: existing } = await supabase
      .from('mt5_accounts')
      .select('id, status')
      .eq('user_id', userId)
      .single();

    if (existing) {
      return res.status(400).json({
        error: 'You already have an account submitted. Contact support to make changes.'
      });
    }

    // Save to Supabase (status = 'pending' until admin approves)
    const { data: newAccount, error: insertError } = await supabase
      .from('mt5_accounts')
      .insert({
        user_id:          userId,
        server:           server.trim(),
        account_number:   account_number.trim(),
        investor_password: investor_password.trim(),
        status:           'pending',
        duplikium_account_id: null, // will be set when admin marks connected
        metaapi_account_id:   null, // will be set when admin marks connected
      })
      .select()
      .single();

    if (insertError) {
      console.error('[MT5 Connect] Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save account details.' });
    }

    console.log(`[MT5 Connect] User ${userId} submitted account #${account_number}`);

    res.json({
      success: true,
      message: 'Account submitted. We will connect it shortly.',
    });

  } catch (err) {
    console.error('[MT5 Connect] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  GET /mt5/status
//  Returns user's MT5 account record
// ─────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data: account } = await supabase
      .from('mt5_accounts')
      .select('id, status, server, account_number, duplikium_account_id, metaapi_account_id, created_at')
      .eq('user_id', req.user.id)
      .single();

    res.json({ account: account || null });

  } catch (err) {
    console.error('[MT5 Status] Error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
//  GET /mt5/live-data
//  Returns live balance, equity, positions,
//  trade history from MetaApi
// ─────────────────────────────────────────────
router.get('/live-data', requireAuth, async (req, res) => {
  try {
    const { data: account } = await supabase
      .from('mt5_accounts')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (!account || account.status !== 'connected') {
      return res.json({ connected: false });
    }

    // MetaApi account must have been provisioned already (done in
    // PATCH /admin/mt5-accounts/:id when admin marks status 'connected').
    // Do NOT fall back to the Supabase row id — that is not a valid
    // MetaApi account id and will always fail lookups.
    if (!account.metaapi_account_id) {
      console.warn(`[MT5 Live Data] No metaapi_account_id for user ${req.user.id} — account not yet provisioned on MetaApi.`);
      return res.json({
        connected: false,
        error: 'MetaApi account not yet provisioned. Please contact support.',
      });
    }

    // Connect via MetaApi
    const metaAccount = await metaApi.metatraderAccountApi.getAccount(
      account.metaapi_account_id
    );

    await metaAccount.waitConnected();
    const connection = metaAccount.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const info      = await connection.getAccountInformation();
    const positions = await connection.getPositions();
    const history   = await connection.getHistoryOrdersByTimeRange(
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days
      new Date()
    );

    res.json({
      connected: true,
      balance:   info.balance,
      equity:    info.equity,
      profit:    info.profit,
      positions: positions || [],
      history:   history   || [],
    });

  } catch (err) {
    console.error('[MT5 Live Data] Error:', err.message);
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
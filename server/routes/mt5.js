const express = require('express');
const supabase = require('../config/supabase');
const protect = require('../middleware/authMiddleware');
const MetaApi = require('metaapi.cloud-sdk').default;
require('dotenv').config();

const router = express.Router();
const metaApi = new MetaApi(process.env.METAAPI_TOKEN);

// --- User submits their MT5 account details ---
router.post('/connect', protect, async (req, res) => {
  const { account_number, server, investor_password } = req.body;
  const user = req.user;

  if (!account_number || !server || !investor_password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const { data: existing } = await supabase
      .from('mt5_accounts')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (existing) {
      return res.status(400).json({
        error: 'You have already submitted an account. Contact support to make changes.'
      });
    }

    // Register the account with MetaApi
    const metaAccount = await metaApi.metatraderAccountApi.createAccount({
      name: `${user.name}-${account_number}`,
      type: 'cloud',
      login: account_number,
      password: investor_password,
      server: server,
      platform: 'mt5',
      magic: 0
    });

    // Deploy the account (don't wait for full connection - happens in background)
await metaAccount.deploy();

    // Save to Supabase, including the MetaApi account id
    const { data, error } = await supabase
      .from('mt5_accounts')
      .insert([{
        user_id: user.id,
        account_number,
        server,
        investor_password,
        status: 'pending',
        metaapi_account_id: metaAccount.id
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Account submitted successfully! We will connect it shortly.' });

  } catch (err) {
    console.error('MT5 connect error:', JSON.stringify(err));
    res.status(500).json({ error: 'Could not connect account. Please check your credentials and try again.' });
  }
});

// --- Get current user's MT5 account status ---
router.get('/status', protect, async (req, res) => {
  const { data } = await supabase
    .from('mt5_accounts')
    .select('account_number, server, status, created_at, metaapi_account_id')
    .eq('user_id', req.user.id)
    .single();

  res.json({ account: data || null });
});

// --- Get live account data (balance, positions, history) ---
router.get('/live-data', protect, async (req, res) => {
  try {
    const { data: mt5Account } = await supabase
      .from('mt5_accounts')
      .select('metaapi_account_id, status')
      .eq('user_id', req.user.id)
      .single();

    if (!mt5Account || !mt5Account.metaapi_account_id) {
      return res.json({ connected: false });
    }

    const account = await metaApi.metatraderAccountApi.getAccount(mt5Account.metaapi_account_id);
    const connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const accountInfo = await connection.getAccountInformation();
    const positions = await connection.getPositions();

    // Get last 90 days of history for the calendar
    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 90);

    const historyOrders = await connection.getHistoryOrdersByTimeRange(startTime, endTime);

    res.json({
      connected: true,
      balance: accountInfo.balance,
      equity: accountInfo.equity,
      profit: accountInfo.profit,
      positions,
      history: historyOrders.history || []
    });

  } catch (err) {
    console.error('Live data error:', JSON.stringify(err));
    res.status(500).json({ error: 'Could not fetch live data' });
  }
});

module.exports = router;
const express   = require('express');
const router    = express.Router();
const MetaApi   = require('metaapi.cloud-sdk').default;
const supabase = require('../config/supabase');
const { encrypt } = require('../utils/crypto');

const metaApi = new MetaApi(process.env.METAAPI_TOKEN);


function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}


router.post('/connect', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { server, account_number, trading_password } = req.body;

    if (!server || !account_number || !trading_password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    
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

    
    const { data: newAccount, error: insertError } = await supabase
      .from('mt5_accounts')
      .insert({
        user_id:          userId,
        server:           server.trim(),
        account_number:   account_number.trim(),
        trading_password: encrypt(trading_password.trim()),
        status:           'pending',
        duplikium_account_id: null, 
        metaapi_account_id:   null, 
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

    
    if (!account.metaapi_account_id) {
      console.warn(`[MT5 Live Data] No metaapi_account_id for user ${req.user.id} — account not yet provisioned on MetaApi.`);
      return res.json({
        connected: false,
        error: 'MetaApi account not yet provisioned. Please contact support.',
      });
    }

    
    const metaAccount = await metaApi.metatraderAccountApi.getAccount(
      account.metaapi_account_id
    );

    await metaAccount.waitConnected();
    const connection = metaAccount.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const info      = await connection.getAccountInformation();
    const positions = await connection.getPositions();
    const dealsResp = await connection.getDealsByTimeRange(
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days
      new Date()
    );
    const deals = dealsResp?.deals || [];

    
    const openingDealsByPosition = {};
    deals.forEach(d => {
      if (d.entryType === 'DEAL_ENTRY_IN' && d.positionId) {
        openingDealsByPosition[d.positionId] = d;
      }
    });

    const history = deals
      .filter(d => d.entryType === 'DEAL_ENTRY_OUT' && d.profit !== undefined)
      .map(closeDeal => {
        const openDeal = openingDealsByPosition[closeDeal.positionId];
        return {
          doneTime:   closeDeal.time,
          openPrice:  openDeal ? openDeal.price : null,
          closePrice: closeDeal.price,
          type:       openDeal ? openDeal.type : closeDeal.type,
          volume:     closeDeal.volume,
          profit:     closeDeal.profit,
        };
      })
      .sort((a, b) => new Date(b.doneTime) - new Date(a.doneTime));

    res.json({
      connected: true,
      balance:   info.balance,
      equity:    info.equity,
      profit:    info.profit,
      positions: positions || [],
      history:   history,
    });

  } catch (err) {
    console.error('[MT5 Live Data] Error:', err.message);
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
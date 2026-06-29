const BASE_URL = 'https://www.trade-copier.com/webservice/v4';

// ── Token cache (tokens last 48hrs, we refresh at 47hrs) ──
let _cachedToken   = null;
let _tokenExpiry   = 0;       // Unix timestamp (ms)
const TOKEN_BUFFER = 60 * 60 * 1000; // refresh 1hr before expiry

/**
 * Get a valid Duplikium Bearer token.
 * Caches it in memory and auto-refreshes before expiry.
 */
async function getDuplikiumToken() {
  const now = Date.now();

  if (_cachedToken && now < _tokenExpiry - TOKEN_BUFFER) {
    return _cachedToken;
  }

  const username = process.env.DUPLIKIUM_USERNAME;
  const password = process.env.DUPLIKIUM_PASSWORD;

  if (!username || !password) {
    throw new Error('DUPLIKIUM_USERNAME or DUPLIKIUM_PASSWORD not set in environment');
  }

  const credentials = Buffer.from(`${username}:${password}`).toString('base64');

  const res = await fetch(`${BASE_URL}/access/getToken.php`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}` }
  });

  if (!res.ok) {
    throw new Error(`Duplikium auth failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (!data.token) {
    throw new Error(`Duplikium token error: ${JSON.stringify(data)}`);
  }

  _cachedToken  = data.token;
  _tokenExpiry  = data.exp * 1000; // convert Unix seconds → ms
  console.log('[Duplikium] Token refreshed. Expires:', new Date(_tokenExpiry).toISOString());

  return _cachedToken;
}

/**
 * Make an authenticated POST to a Duplikium endpoint.
 * @param {string} endpoint  - e.g. '/account/addAccount.php'
 * @param {object} fields    - key/value pairs to send as form body
 */
async function duplikiumPost(endpoint, fields) {
  const token = await getDuplikiumToken();
  const body  = new URLSearchParams(fields);

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`
    },
    body
  });

  if (!res.ok) {
    throw new Error(`Duplikium request failed [${endpoint}]: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────
//  ACCOUNT OPERATIONS
// ─────────────────────────────────────────────

/**
 * Add a user's MT5 account as a Slave on Duplikium.
 * Called when admin marks a user's account as 'connected'.
 *
 * @param {object} account - { account_number, investor_password, server }
 * @param {string} [masterAccountId] - optional: your Duplikium master account ID
 *                                     to link the slave directly
 * @returns {object} Duplikium response — contains account.account_id on success
 */
async function addSlaveAccount(account, masterAccountId = null) {
  const fields = {
    type:         '1',                              // 1 = Slave
    name:         `BAS_${account.account_number}`,  // identifiable name in cockpit
    broker:       'mt5',
    login:        String(account.account_number),
    password:     account.investor_password,
    server:       account.server,
    status:       '1',                              // 1 = enabled
    subscription: 'auto',                           // auto-assign available slot
    alert_email:  '1',                              // email alerts for disconnects
  };

  // Optionally link directly to your master account
  // Uncomment and set DUPLIKIUM_MASTER_ID in env if you want auto-linking
  // if (masterAccountId || process.env.DUPLIKIUM_MASTER_ID) {
  //   fields.master_id = masterAccountId || process.env.DUPLIKIUM_MASTER_ID;
  // }

  const data = await duplikiumPost('/account/addAccount.php', fields);

  if (!data.account) {
    throw new Error(`Duplikium addAccount failed: ${JSON.stringify(data)}`);
  }

  return data.account; // { account_id, name, login, server, ... }
}

/**
 * Enable a slave account on Duplikium (e.g. after payment confirmed).
 * @param {string} duplikiumAccountId
 */
async function enableSlaveAccount(duplikiumAccountId) {
  const data = await duplikiumPost('/account/updateAccount.php', {
    account_id: duplikiumAccountId,
    status:     '1',  // 1 = enabled
  });

  if (!data.account) {
    throw new Error(`Duplikium enableAccount failed: ${JSON.stringify(data)}`);
  }

  return data.account;
}

/**
 * Disable a slave account on Duplikium (e.g. on subscription expiry).
 * @param {string} duplikiumAccountId
 */
async function disableSlaveAccount(duplikiumAccountId) {
  const data = await duplikiumPost('/account/updateAccount.php', {
    account_id: duplikiumAccountId,
    status:     '0',  // 0 = disabled
  });

  if (!data.account) {
    throw new Error(`Duplikium disableAccount failed: ${JSON.stringify(data)}`);
  }

  return data.account;
}

/**
 * Delete a slave account from Duplikium entirely.
 * Use this if a user deletes their account from BAS.
 * @param {string} duplikiumAccountId
 */
async function deleteSlaveAccount(duplikiumAccountId) {
  const data = await duplikiumPost('/account/deleteAccount.php', {
    account_id: duplikiumAccountId,
  });

  if (!data.account) {
    throw new Error(`Duplikium deleteAccount failed: ${JSON.stringify(data)}`);
  }

  return data.account;
}

/**
 * Get all slave accounts from Duplikium cockpit.
 * Useful for admin reconciliation.
 */
async function getAllAccounts() {
  const data = await duplikiumPost('/account/getAccounts.php', {});
  return data.accounts || [];
}

/**
 * Get a single account's status from Duplikium.
 * @param {string} duplikiumAccountId
 */
async function getAccountStatus(duplikiumAccountId) {
  const data = await duplikiumPost('/account/getAccounts.php', {
    account_id: duplikiumAccountId,
  });
  return data.accounts?.[0] || null;
}

// ─────────────────────────────────────────────
//  EWALLET
// ─────────────────────────────────────────────

/**
 * Get current eWallet balance.
 * Useful to alert admin when balance is running low.
 */
async function getEwalletBalance() {
  try {
    const data = await duplikiumPost('/ewallet/getEwalletBalance.php', {});
    return data;
  } catch (err) {
    console.error('[Duplikium] eWallet balance check failed:', err.message);
    return null;
  }
}

module.exports = {
  getDuplikiumToken,
  addSlaveAccount,
  enableSlaveAccount,
  disableSlaveAccount,
  deleteSlaveAccount,
  getAllAccounts,
  getAccountStatus,
  getEwalletBalance,
};
require('dotenv').config();
const supabase = require('../config/supabase');
const { encrypt, isEncrypted } = require('../utils/crypto');

async function backfill() {
  const { data: accounts, error } = await supabase
    .from('mt5_accounts')
    .select('id, trading_password');

  if (error) {
    console.error('Failed to fetch accounts:', error);
    process.exit(1);
  }

  console.log(`Found ${accounts.length} mt5_accounts row(s) to check.`);

  let updated = 0;
  let skippedEmpty = 0;
  let skippedAlreadyEncrypted = 0;
  let failed = 0;

  for (const acc of accounts) {
    if (!acc.trading_password) {
      skippedEmpty++;
      continue;
    }

    if (isEncrypted(acc.trading_password)) {
      skippedAlreadyEncrypted++;
      continue;
    }

    try {
      const encryptedValue = encrypt(acc.trading_password);
      const { error: updateError } = await supabase
        .from('mt5_accounts')
        .update({ trading_password: encryptedValue })
        .eq('id', acc.id);

      if (updateError) {
        console.error(`  ✗ Account ${acc.id}: update failed —`, updateError.message);
        failed++;
        continue;
      }

      console.log(`  ✓ Account ${acc.id}: encrypted`);
      updated++;
    } catch (err) {
      console.error(`  ✗ Account ${acc.id}: encryption failed —`, err.message);
      failed++;
    }
  }

  console.log('\nBackfill complete.');
  console.log(`  Updated:            ${updated}`);
  console.log(`  Already encrypted:  ${skippedAlreadyEncrypted}`);
  console.log(`  Empty/skipped:      ${skippedEmpty}`);
  console.log(`  Failed:             ${failed}`);

  if (failed > 0) {
    console.log('\nSome rows failed — check the errors above before considering this complete.');
    process.exit(1);
  }
}

backfill();
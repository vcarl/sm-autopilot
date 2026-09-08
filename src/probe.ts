import { Account } from '@spacemolt/lib';
import { readFileSync, writeFileSync } from 'node:fs';

const text = readFileSync('/Users/vcarl/workspace/testbench/roci-testing/players/kvothe/me/credentials.txt', 'utf8');
const password = text.match(/^Password: (.+)$/m)?.[1]?.trim();
if (!password) throw new Error('Password field missing');
const account = new Account({url: 'wss://game.spacemolt.com/ws/v2'});
try {
  await account.connect();
  await account.login({username: 'kvothe', password});
  const status = await account.commands.spacemolt.get_status();
  writeFileSync(new URL('../runtime/initial-status.json', import.meta.url), JSON.stringify(status, null, 2), {mode: 0o600});
  console.log(JSON.stringify(status));
} finally { account.close(); }

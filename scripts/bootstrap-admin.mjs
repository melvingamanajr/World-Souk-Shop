import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.mjs';
import { bootstrapAdministrator } from '../src/identity.mjs';
import { promptHidden } from './terminal-secret.mjs';

async function readPassword(input, output, useStdin) {
  if (useStdin) {
    if (input.isTTY) throw new Error('--password-stdin expects piped input. Omit it for a hidden terminal prompt.');
    let password = '';
    input.setEncoding('utf8');
    for await (const chunk of input) {
      password += chunk;
      if (password.length > 1024) throw new Error('Password input is too long.');
    }
    return password.replace(/\r?\n$/, '');
  }
  if (!input.isTTY) throw new Error('Use a terminal or pass --password-stdin with piped input.');
  const password = await promptHidden(input, output, 'Administrator password (hidden): ');
  if (password !== await promptHidden(input, output, 'Confirm password (hidden): ')) throw new Error('Passwords do not match.');
  return password;
}

let db;
try {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, 'password-stdin': { type: 'boolean' } } });
  if (!values.email || !values.name) throw new Error('Usage: npm run admin:bootstrap -- --email <email> --name <operator name> [--password-stdin]');
  const password = await readPassword(process.stdin, process.stderr, values['password-stdin']);
  db = openDatabase(resolve(process.env.WSS_DB ?? 'data/world-souk.sqlite'));
  const result = await bootstrapAdministrator(db, { email: values.email, name: values.name, password });
  console.log(`Administrator account created (${result.id}). Sign in with the configured email and password.`);
} catch (error) {
  console.error(`Administrator bootstrap failed. ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}

import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.mjs';
import { bootstrapAdministrator } from '../src/identity.mjs';

function promptHidden(input, output, message) {
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw;
    let value = '';
    emitKeypressEvents(input);
    function finish(error) {
      input.removeListener('keypress', readKey);
      input.setRawMode(previousRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    }
    function readKey(character, key) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') finish(new Error('Password entry canceled.'));
      else if (['return', 'enter'].includes(key.name)) finish();
      else if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (character && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(character) && value.length < 1024) value += character;
    }
    output.write(message);
    input.setRawMode(true);
    input.on('keypress', readKey);
    input.resume();
  });
}

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

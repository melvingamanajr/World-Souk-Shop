import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.mjs';
import { createOperatorMfa, parseOperatorMfaKey } from '../src/operator-mfa.mjs';
import { promptHidden } from './terminal-secret.mjs';

let db;
try {
  const { values } = parseArgs({ options: { email: { type: 'string' }, replace: { type: 'boolean' } } });
  if (!values.email) throw new Error('Usage: npm run admin:mfa -- --email <operator email> [--replace]');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use a private interactive terminal to enroll the authenticator.');
  const key = parseOperatorMfaKey(process.env.WSS_OPERATOR_MFA_KEY);
  if (!key) throw new Error('Set WSS_OPERATOR_MFA_KEY to the same key the API uses.');
  db = openDatabase(resolve(process.env.WSS_DB ?? 'data/world-souk.sqlite'));
  const operator = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'ADMIN' AND id <> 'demo-admin'")
    .get(values.email.trim().toLowerCase());
  if (!operator) throw new Error('Operator account not found. Provision it with admin:bootstrap first.');
  const mfa = createOperatorMfa(db, { key });
  key.fill(0);
  if (mfa.isEnrolled(operator.id) && !values.replace) throw new Error('The operator already has an authenticator. Use --replace to rotate it.');
  const { secret, uri } = mfa.prepareEnrollment(operator.id);
  console.log('Add a time-based entry to the operator’s authenticator. Store the enrollment secret privately.');
  console.log(`Manual key: ${secret}\nAuthenticator URI: ${uri}`);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await promptHidden(process.stdin, process.stderr, 'Current authenticator code (hidden): ');
    try { result = mfa.enroll(operator.id, { secret, code, replaceExisting: Boolean(values.replace) }); break; }
    catch (error) {
      if (error.code !== 'INVALID_MFA_CODE' || attempt === 2) throw error;
      console.error(error.message);
    }
  }
  console.log('\nSave these single-use recovery codes in a private location. This is the only display.');
  console.log(result.recoveryCodes.join('\n'));
  console.log('\nExisting operator sessions were revoked. Wait for a fresh authenticator code before signing in.');
} catch (error) {
  console.error(`Operator MFA enrollment failed. ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}

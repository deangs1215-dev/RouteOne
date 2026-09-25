import 'dotenv/config'; // must run first - loads SECRET_KEY like the other scripts
// One-off admin utility: sets a user's password directly against the database.
//
// For the case where nobody can log in - a forgotten admin password, or a rep
// whose one-time password from import-reps.js was lost. Everything else about
// the user row is left alone.
//
// The new password is typed at a prompt, not passed as an argument, so it never
// lands in shell history. It is checked against the same passwordIsStrong rules
// the app enforces, so this cannot be used to set a weak password that the app
// would otherwise reject.
//
// Usage:  node server/reset-password.js <email>
//         node server/reset-password.js <email> --force-change
//
// --force-change marks the account must_change_password, so the user is made to
// pick their own on first login. Use it when resetting someone else's account;
// omit it when resetting your own.
import bcrypt from 'bcryptjs';
import readline from 'readline';
import { dbx } from './db.js';
import { passwordIsStrong } from './auth.js';

const email = process.argv[2];
const FORCE_CHANGE = process.argv.includes('--force-change');

if (!email || email.startsWith('--')) {
  console.error('Usage: node server/reset-password.js <email> [--force-change]');
  process.exit(1);
}

// Prompt without echoing - this is a password, and RDP sessions get shoulder-surfed.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (chunk) => { if (!muted) rl.output.write(chunk); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const user = await dbx.prepare(`
  SELECT u.id, u.name, u.email, u.active, r.name AS role_name
  FROM users u JOIN roles r ON r.id = u.role_id
  WHERE u.email = ?
`).get(email);

if (!user) {
  console.error(`No user with email ${email}.`);
  process.exit(1);
}

console.log(`\nResetting password for:`);
console.log(`  ${user.name} <${user.email}>  role=${user.role_name}${user.active ? '' : '  (INACTIVE)'}\n`);

const password = await promptHidden('New password: ');
const confirm = await promptHidden('Confirm password: ');

if (password !== confirm) {
  console.error('Passwords do not match - nothing was changed.');
  process.exit(1);
}

if (!passwordIsStrong(password)) {
  console.error('Password rejected: must be 12-128 characters and not a known-weak value.');
  console.error('Nothing was changed.');
  process.exit(1);
}

await dbx.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?')
  .run(bcrypt.hashSync(password, 12), FORCE_CHANGE ? 1 : 0, user.id);

console.log(`\nPassword updated for ${user.email}.`);
if (FORCE_CHANGE) console.log('They will be asked to choose a new one at first login.');
console.log('');
process.exit(0);

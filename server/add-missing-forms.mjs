// One-off: add any standard customer forms that are missing from form_templates,
// matched by name. Never deletes or changes existing forms or submissions.
//
//   node add-missing-forms.mjs           (shows what it would add, changes nothing)
//   node add-missing-forms.mjs --apply   (adds them)
//
// Delete this file when done.
import { initDb, dbx } from './db.js';
import { DEFAULT_FORMS } from './defaultForms.js';

const apply = process.argv.includes('--apply');
await initDb();

const existing = await dbx.prepare('SELECT id, name, active FROM form_templates').all();
console.log('Forms currently in the database:');
for (const f of existing) console.log(`  #${f.id}  ${f.name}  (active=${f.active})`);

const have = new Set(existing.map((f) => f.name.trim().toLowerCase()));
const missing = DEFAULT_FORMS.filter((f) => !have.has(f.name.trim().toLowerCase()));

if (missing.length === 0) {
  console.log('\nNothing to add - every standard form is already there.');
  process.exit(0);
}
console.log(`\n${apply ? 'Adding' : 'Would add'}:`);
for (const f of missing) console.log(`  + ${f.name}  [${f.category === 'technical' ? 'technical' : 'general'}, ${f.fields.length} fields]`);

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to add them.');
  process.exit(0);
}
const insert = dbx.prepare('INSERT INTO form_templates (name, description, fields, category, active) VALUES (?, ?, ?, ?, 1)');
for (const f of missing) {
  await insert.run(f.name, f.description || null, JSON.stringify(f.fields), f.category === 'technical' ? 'technical' : 'general');
}
console.log('\nDone. Forms now in the database:');
for (const f of await dbx.prepare('SELECT id, name, category, active FROM form_templates ORDER BY id').all()) {
  console.log(`  #${f.id}  ${f.name}  [${f.category}, active=${f.active}]`);
}
process.exit(0);

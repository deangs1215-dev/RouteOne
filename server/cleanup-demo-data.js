// Cleanup script: removes demo reps, customers, and products while preserving system data
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db, setSetting } from './db.js';

console.log('Cleaning up demo data...');

db.pragma('foreign_keys = OFF');

// Clear all data-related tables
const cleanup = db.transaction(() => {
  const tables = [
    'rep_locations',
    'form_submissions',
    'form_templates',
    'visit_photos',
    'quote_items',
    'quotes',
    'price_rules',
    'invoices',
    'order_items',
    'orders',
    'visits',
    'customer_prices',
    'customer_contacts',
    'customers',
    'products',
    'product_categories',
    'warehouses',
    'users',
    'route_cycles',
    'route_cycle_stops',
    'activity_log',
    'rep_budgets',
    'sync_runs'
  ];

  for (const table of tables) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
      console.log(`✓ Cleared ${table}`);
    } catch (e) {
      // Table might not exist, skip silently
    }
  }
});

cleanup();

// Recreate system data (roles, territories, admin user)
console.log('\nRecreating system structure...');

const roleIds = {};
for (const name of ['admin', 'manager', 'office', 'rep', 'customer']) {
  roleIds[name] = db.prepare('INSERT INTO roles (name) VALUES (?)').run(name).lastInsertRowid;
  console.log(`✓ Created role: ${name}`);
}

const territories = [
  ['Cape Town North', 'Western Cape'],
  ['Cape Town South', 'Western Cape'],
  ['Winelands', 'Western Cape']
];

for (const [name, region] of territories) {
  db.prepare('INSERT INTO territories (name, region) VALUES (?, ?)').run(name, region);
  console.log(`✓ Created territory: ${name}`);
}

// Create a default admin user with a unique one-time password.
const temporaryAdminPassword = `${crypto.randomBytes(12).toString('base64url')}aA1!`;
const hash = bcrypt.hashSync(temporaryAdminPassword, 12);
db.prepare(`
  INSERT INTO users (name, email, password_hash, role_id, active)
  VALUES (?, ?, ?, ?, 1)
`).run('Admin', 'admin@routeone.local', hash, roleIds['admin']);
console.log('✓ Created admin user');

db.pragma('foreign_keys = ON');

// Reset counters
setSetting('counter_ORD', '0');
setSetting('counter_CUS', '0');

console.log('\n✅ Demo data removed. System ready for real data.');
console.log('\n📝 Default admin user created:');
console.log('   Email: admin@routeone.local');
console.log(`   Temporary password: ${temporaryAdminPassword}`);

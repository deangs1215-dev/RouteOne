// Non-destructive demo invoice loader. Stands in for the SYSPRO invoice sync
// until the ERP view is wired up. Safe to re-run: it only clears and rebuilds
// the invoices table, leaving customers, orders, cycles and tasks untouched.
//
// Each active customer gets 2-4 invoices dated within the last ~30 days, a mix
// of paid / outstanding / overdue, so the "Invoices — last 30 days" panels show
// realistic data on both the mobile and back-office customer screens.
import { db, getTodayISO, getLocalDateISO } from './db.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo invoice seeding is disabled when NODE_ENV=production.');
}

const round2 = (n) => Math.round(n * 100) / 100;
const rand = (n) => Math.floor(Math.random() * n);
const dateStr = (daysAgo) => getLocalDateISO(-daysAgo);
const today = getTodayISO();

db.prepare('DELETE FROM invoices').run();
db.prepare("DELETE FROM sqlite_sequence WHERE name = 'invoices'").run();

const customers = db.prepare("SELECT id, code FROM customers WHERE status != 'closed'").all();

const insert = db.prepare(`
  INSERT INTO invoices (number, customer_id, customer_code, order_number, invoice_date, due_date,
    subtotal, vat_amount, total, amount_paid, balance, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let invN = 90000;
let count = 0;
for (const cust of customers) {
  const n = 2 + rand(3); // 2-4 invoices
  for (let i = 0; i < n; i++) {
    invN += 1;
    const daysAgo = 1 + rand(29);                 // within the rolling 30-day window
    const termDays = [7, 14, 30][rand(3)];        // mixed terms so some go overdue
    const invoiceDate = dateStr(daysAgo);
    const dueDate = dateStr(daysAgo - termDays);
    const subtotal = round2(1500 + rand(14000));
    const vat = round2(subtotal * 0.15);
    const total = round2(subtotal + vat);

    // ~45% fully paid; the rest outstanding, and overdue if past the due date.
    const paidRoll = Math.random();
    let amountPaid = 0;
    if (paidRoll < 0.45) amountPaid = total;
    else if (paidRoll < 0.6) amountPaid = round2(total * 0.5); // part-paid
    const balance = round2(total - amountPaid);
    let status;
    if (balance <= 0.005) status = 'paid';
    else if (dueDate < today) status = 'overdue';
    else status = 'outstanding';

    insert.run(`INV-${invN}`, cust.id, cust.code, `SO-${44000 + rand(900)}`,
      invoiceDate, dueDate, subtotal, vat, total, amountPaid, balance, status);
    count += 1;
  }
}

console.log(`Seeded ${count} demo invoices across ${customers.length} customers (last 30 days).`);

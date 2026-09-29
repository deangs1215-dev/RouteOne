import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-api-test-'));
const databasePath = path.join(tempDir, 'test.db');
// Backend under test. Default SQLite; DB_BACKEND=mssql (with DB_NAME pointing at a
// scratch database, run via `node --env-file=server/.env`) runs the same suite
// against SQL Server. The fixture below goes through dbx, so it works on both.
const useMssql = (process.env.DB_BACKEND || '').toLowerCase() === 'mssql';
process.env.DATABASE_PATH = databasePath;
const { dbx, closeDb } = await import('../db.js');
const port = 4327;
const baseUrl = `http://127.0.0.1:${port}`;
const allowedOrigin = 'http://localhost:5190';
const testPassword = 'RouteOne-Test-Password-2026!';
let server;
let fixture;

function runNode(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        DISABLE_SCHEDULERS: '1',
        NODE_ENV: 'test',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `Process exited ${code}`)));
  });
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const elapsedMs = performance.now() - started;
  const body = await response.json().catch(() => ({}));
  return { response, body, elapsedMs };
}

async function login(email, password = testPassword) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    origin: allowedOrigin,
    body: { email, password }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const setCookie = result.response.headers.get('set-cookie');
  assert.match(setCookie || '', /routeone_session=.*HttpOnly/i);
  assert.match(setCookie || '', /SameSite=Strict/i);
  return setCookie.split(';')[0];
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready');
}

before(async () => {
  await runNode('server/seed.js');
  const hash = bcrypt.hashSync(testPassword, 10);
  const reps = await dbx.prepare(`
    SELECT u.id, u.email FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' ORDER BY u.id LIMIT 2
  `).all();
  assert.equal(reps.length, 2);
  const admin = await dbx.prepare(`
    SELECT u.id, u.email FROM users u
    JOIN roles r ON r.id = u.role_id WHERE r.name = 'admin' LIMIT 1
  `).get();
  for (const user of [admin, ...reps]) {
    await dbx.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  }

  const customers = [];
  for (const rep of reps) customers.push(await dbx.prepare('SELECT id FROM customers WHERE rep_id = ? ORDER BY id LIMIT 1').get(rep.id));
  assert.ok(customers.every(Boolean));
  const product = await dbx.prepare('SELECT id, list_price FROM products WHERE active = 1 AND list_price > 0 ORDER BY id LIMIT 1').get();
  const template = await dbx.prepare('SELECT id FROM form_templates WHERE active = 1 ORDER BY id LIMIT 1').get();
  const invoice = await dbx.prepare(`
    INSERT INTO invoices (number, customer_id, customer_code, invoice_date, total, balance, status)
    SELECT ?, id, code, date('now'), 500, 500, 'outstanding' FROM customers WHERE id = ?
  `).run('TEST-INV-REP2', customers[1].id);

  const repRoleId = (await dbx.prepare("SELECT id FROM roles WHERE name = 'rep'").get()).id;
  const warehouseId = (await dbx.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get())?.id || null;
  const loadUsers = [];
  await dbx.transaction(async (tx) => {
    const insertUser = tx.prepare(`
      INSERT INTO users (name, email, password_hash, role_id, warehouse_id, active, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1, 0)
    `);
    const insertCustomer = tx.prepare(`
      INSERT INTO customers (code, name, rep_id, warehouse_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `);
    for (let index = 1; index <= 40; index += 1) {
      const email = `load.rep.${index}@routeone.test`;
      const userId = (await insertUser.run(`Load Rep ${index}`, email, hash, repRoleId, warehouseId)).lastInsertRowid;
      const customerId = (await insertCustomer.run(`LOAD-${index}`, `Load Customer ${index}`, userId, warehouseId)).lastInsertRowid;
      loadUsers.push({ email, userId, customerId });
    }
  });

  fixture = {
    admin,
    reps,
    customers,
    product,
    template,
    invoiceId: invoice.lastInsertRowid,
    loadUsers
  };

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_PORT: String(port),
      DATABASE_PATH: databasePath,
      DISABLE_SCHEDULERS: '1',
      APP_ORIGIN: allowedOrigin,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError += chunk; });
  server.on('exit', (code) => {
    if (code && code !== 0) process.stderr.write(serverError);
  });
  await waitForServer();
});

after(async () => {
  if (server && !server.killed) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('health, security headers, authentication cookie, and cross-site blocking', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.response.headers.get('content-security-policy') || '', /object-src 'none'/);

  const anonymous = await request('/api/dashboard');
  assert.equal(anonymous.response.status, 401);
  const upload = await request('/uploads/not-a-real-file.pdf');
  assert.equal(upload.response.status, 401);

  const cookie = await login(fixture.reps[0].email);
  const dashboard = await request('/api/dashboard', { cookie });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.response.headers.get('cache-control'), 'no-store');

  const crossSite = await request('/api/locations', {
    method: 'POST',
    cookie,
    origin: 'https://attacker.example',
    body: { lat: -33.9, lng: 18.4 }
  });
  assert.equal(crossSite.response.status, 403);
});

test('rep cannot read or write another rep customer records', async () => {
  const cookie = await login(fixture.reps[0].email);
  const foreignCustomerId = fixture.customers[1].id;
  const checks = await Promise.all([
    request(`/api/products/for-customer/${foreignCustomerId}`, { cookie }),
    request('/api/orders', {
      method: 'POST', cookie, origin: allowedOrigin,
      body: { customer_id: foreignCustomerId, items: [{ product_id: fixture.product.id, qty: 1 }] }
    }),
    request('/api/visits', {
      method: 'POST', cookie, origin: allowedOrigin,
      body: { customer_id: foreignCustomerId }
    }),
    request('/api/tasks', {
      method: 'POST', cookie, origin: allowedOrigin,
      body: {
        customer_id: foreignCustomerId,
        task_type: 'Call Customer',
        follow_up_date: '2026-08-01'
      }
    }),
    request('/api/form-submissions', {
      method: 'POST', cookie, origin: allowedOrigin,
      body: { template_id: fixture.template.id, customer_id: foreignCustomerId, data: {} }
    }),
    request(`/api/invoices/${fixture.invoiceId}`, { cookie })
  ]);
  assert.deepEqual(checks.map((result) => result.response.status), [403, 403, 403, 403, 403, 403]);
});

test('rep-supplied prices and discounts cannot override server pricing', async () => {
  const cookie = await login(fixture.reps[0].email);
  const result = await request('/api/orders', {
    method: 'POST',
    cookie,
    origin: allowedOrigin,
    body: {
      customer_id: fixture.customers[0].id,
      status: 'draft',
      items: [{
        product_id: fixture.product.id,
        qty: 1,
        unit_price: 0.01,
        discount_pct: 100
      }]
    }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.items[0].unit_price > 0.01);
  assert.equal(result.body.items[0].discount_pct, 0);
  assert.ok(result.body.total > 0);
});

test('rep cannot mutate or convert another rep quote', async () => {
  const repOneCookie = await login(fixture.reps[0].email);
  const repTwoCookie = await login(fixture.reps[1].email);
  const created = await request('/api/quotes', {
    method: 'POST',
    cookie: repTwoCookie,
    origin: allowedOrigin,
    body: {
      customer_id: fixture.customers[1].id,
      items: [{ product_id: fixture.product.id, qty: 1 }]
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));

  const status = await request(`/api/quotes/${created.body.id}/status`, {
    method: 'PUT', cookie: repOneCookie, origin: allowedOrigin, body: { status: 'rejected' }
  });
  const convert = await request(`/api/quotes/${created.body.id}/convert`, {
    method: 'POST', cookie: repOneCookie, origin: allowedOrigin
  });
  assert.equal(status.response.status, 403);
  assert.equal(convert.response.status, 403);
});

test('converting a quote honours quoted prices but re-checks product availability', async () => {
  const repCookie = await login(fixture.reps[0].email);
  const newQuote = async () => {
    const created = await request('/api/quotes', {
      method: 'POST',
      cookie: repCookie,
      origin: allowedOrigin,
      body: {
        customer_id: fixture.customers[0].id,
        items: [{ product_id: fixture.product.id, qty: 2 }]
      }
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    return created.body;
  };

  // Happy path: a live product converts, at the quoted total.
  const live = await newQuote();
  const converted = await request(`/api/quotes/${live.id}/convert`, {
    method: 'POST', cookie: repCookie, origin: allowedOrigin
  });
  assert.equal(converted.response.status, 200, JSON.stringify(converted.body));
  assert.equal(converted.body.total, live.total);

  // A quote written before the product was discontinued must not convert -
  // otherwise conversion is a way around the discontinued guard that order
  // and quote capture both enforce.
  const stale = await newQuote();
  await dbx.prepare('UPDATE products SET active = 0, discontinued = 1 WHERE id = ?').run(fixture.product.id);
  try {
    const blocked = await request(`/api/quotes/${stale.id}/convert`, {
      method: 'POST', cookie: repCookie, origin: allowedOrigin
    });
    assert.equal(blocked.response.status, 400, JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /discontinued/i);
  } finally {
    await dbx.prepare('UPDATE products SET active = 1, discontinued = 0 WHERE id = ?').run(fixture.product.id);
  }
});

test('draft, submit, and cancel transitions preserve stock integrity', async () => {
  const repCookie = await login(fixture.reps[0].email);
  const adminCookie = await login(fixture.admin.email);
  const readStock = async () => (await dbx.prepare('SELECT stock_qty FROM products WHERE id = ?').get(fixture.product.id)).stock_qty;
  const before = await readStock();
  const created = await request('/api/orders', {
    method: 'POST',
    cookie: repCookie,
    origin: allowedOrigin,
    body: {
      customer_id: fixture.customers[0].id,
      status: 'draft',
      items: [{ product_id: fixture.product.id, qty: 2 }]
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(await readStock(), before);

  const submitted = await request(`/api/orders/${created.body.id}/status`, {
    method: 'PUT', cookie: adminCookie, origin: allowedOrigin, body: { status: 'submitted' }
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(await readStock(), before - 2);

  const cancelled = await request(`/api/orders/${created.body.id}/status`, {
    method: 'PUT', cookie: adminCookie, origin: allowedOrigin, body: { status: 'cancelled' }
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(await readStock(), before);
});

test('password-change gate and logout lifecycle work end to end', async () => {
  const email = fixture.loadUsers[0].email;
  await dbx.prepare('UPDATE users SET must_change_password = 1 WHERE email = ?').run(email);

  const cookie = await login(email);
  const blocked = await request('/api/dashboard', { cookie });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');

  const newPassword = 'Changed-RouteOne-Password-2026';
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    cookie,
    origin: allowedOrigin,
    body: { current_password: testPassword, new_password: newPassword }
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.user.must_change_password, false);
  const changedCookie = changed.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/dashboard', { cookie: changedCookie })).response.status, 200);

  const loggedOut = await request('/api/auth/logout', {
    method: 'POST', cookie: changedCookie, origin: allowedOrigin
  });
  assert.equal(loggedOut.response.status, 200);
  assert.match(loggedOut.response.headers.get('set-cookie') || '', /routeone_session=;/);
});

test('changing a password ends every other session for that account', async () => {
  // A user of its own: this test rotates a password, and the load test below
  // logs its 40 reps in with the shared one.
  const email = 'rotation.probe@routeone.test';
  const repRoleId = (await dbx.prepare("SELECT id FROM roles WHERE name = 'rep'").get()).id;
  await dbx.prepare(`
    INSERT INTO users (name, email, password_hash, role_id, active, must_change_password)
    VALUES (?, ?, ?, ?, 1, 0)
  `).run('Rotation Probe', email, bcrypt.hashSync(testPassword, 10), repRoleId);

  const staleCookie = await login(email);
  const activeCookie = await login(email);
  assert.equal((await request('/api/dashboard', { cookie: staleCookie })).response.status, 200);

  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    cookie: activeCookie,
    origin: allowedOrigin,
    body: { current_password: testPassword, new_password: 'Rotated-RouteOne-Password-2026' }
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));

  // The session that performed the change is re-issued and keeps working...
  const reissued = changed.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/dashboard', { cookie: reissued })).response.status, 200);
  // ...while every token minted before the change is dead, including the one
  // that made the request. A stolen session must not outlive the password.
  assert.equal((await request('/api/dashboard', { cookie: staleCookie })).response.status, 401);
  assert.equal((await request('/api/dashboard', { cookie: activeCookie })).response.status, 401);

  await dbx.prepare('DELETE FROM users WHERE email = ?').run(email);
});

test('rep cannot price another rep customer and never receives cost price', async () => {
  const repCookie = await login(fixture.reps[0].email);
  const adminCookie = await login(fixture.admin.email);
  const mine = await dbx.prepare('SELECT code FROM customers WHERE id = ?').get(fixture.customers[0].id);
  const theirs = await dbx.prepare('SELECT code FROM customers WHERE id = ?').get(fixture.customers[1].id);
  const product = await dbx.prepare('SELECT code FROM products WHERE id = ?').get(fixture.product.id);

  const pricingUrl = (code) =>
    `/api/customer-pricing?customer_code=${encodeURIComponent(code)}&product_code=${encodeURIComponent(product.code)}`;
  assert.equal((await request(pricingUrl(mine.code), { cookie: repCookie })).response.status, 200);
  // Contract / buying-group pricing for an account this rep does not own.
  assert.equal((await request(pricingUrl(theirs.code), { cookie: repCookie })).response.status, 403);

  const repProducts = await request('/api/products', { cookie: repCookie });
  assert.equal(repProducts.response.status, 200);
  assert.ok(repProducts.body.length > 0);
  assert.ok(repProducts.body.every((p) => !('cost_price' in p)), 'rep product list leaked cost_price');

  const snapshot = await request('/api/sync/snapshot', { cookie: repCookie });
  assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.body));
  assert.ok(snapshot.body.products.every((p) => !('cost_price' in p)), 'offline snapshot leaked cost_price');

  const repAnalytics = await request('/api/analytics', { cookie: repCookie });
  assert.ok(!('margin' in repAnalytics.body.totals), 'rep analytics leaked margin');

  // Office roles still need all of it - this must scope down, not remove.
  const adminProducts = await request('/api/products', { cookie: adminCookie });
  assert.ok(adminProducts.body.some((p) => 'cost_price' in p), 'office lost cost_price');
  const adminAnalytics = await request('/api/analytics', { cookie: adminCookie });
  assert.ok('margin' in adminAnalytics.body.totals, 'office lost margin');
});

test('an unrecognised role is denied, not defaulted to office access', async () => {
  const email = 'auditor@routeone.test';
  const roleId = (await dbx.prepare("INSERT INTO roles (name) VALUES ('auditor')").run()).lastInsertRowid;
  await dbx.prepare(`
    INSERT INTO users (name, email, password_hash, role_id, active, must_change_password)
    VALUES (?, ?, ?, ?, 1, 0)
  `).run('Auditor', email, bcrypt.hashSync(testPassword, 10), roleId);

  try {
    // Credentials are valid, so the login itself succeeds - the role is only
    // rejected once a scoped endpoint is reached. Before this guard, a role
    // that was neither office nor rep fell into the office branch of every
    // `scope.isRep ? ... : ...` and was handed the whole company's data.
    const cookie = await login(email);
    const blocked = await request('/api/dashboard', { cookie });
    assert.equal(blocked.response.status, 403, JSON.stringify(blocked.body));
    const customers = await request('/api/customers', { cookie });
    assert.equal(customers.response.status, 403);
  } finally {
    await dbx.prepare('DELETE FROM users WHERE email = ?').run(email);
    await dbx.prepare("DELETE FROM roles WHERE name = 'auditor'").run();
  }
});

test('document uploads validate file signatures and remain authenticated', async () => {
  const adminCookie = await login(fixture.admin.email);
  const repCookie = await login(fixture.reps[0].email);
  const invalid = await request('/api/documents', {
    method: 'POST',
    cookie: adminCookie,
    origin: allowedOrigin,
    body: {
      title: 'Invalid document',
      file: `data:application/pdf;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`
    }
  });
  assert.equal(invalid.response.status, 400);

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const created = await request('/api/documents', {
    method: 'POST',
    cookie: adminCookie,
    origin: allowedOrigin,
    body: {
      title: 'Audit PDF',
      file: `data:application/pdf;base64,${pdf.toString('base64')}`
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const documents = await request('/api/documents', { cookie: adminCookie });
  const document = documents.body.find((row) => row.id === created.body.id);
  assert.ok(document?.file_path);
  assert.equal((await request(document.file_path)).response.status, 401);
  const authorized = await request(document.file_path, { cookie: repCookie });
  assert.equal(authorized.response.status, 200);
  assert.match(authorized.response.headers.get('content-type') || '', /application\/pdf/);
  const removed = await request(`/api/documents/${created.body.id}`, {
    method: 'DELETE', cookie: adminCookie, origin: allowedOrigin
  });
  assert.equal(removed.response.status, 200);
  assert.equal((await request(document.file_path, { cookie: repCookie })).response.status, 403);
});

test('online backup captures the database and upload directory', { skip: useMssql && 'SQL Server databases are backed up by SQL Server' }, async () => {
  const backupDir = path.join(tempDir, 'backups');
  await runNode('server/backup.js', { BACKUP_DIR: backupDir, BACKUP_RETENTION_DAYS: '2' });
  const snapshots = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith('routeone-') && !name.endsWith('.tmp'));
  assert.equal(snapshots.length, 1);
  const snapshot = path.join(backupDir, snapshots[0]);
  assert.ok(fs.statSync(path.join(snapshot, 'fieldsales.db')).size > 0);
  assert.ok(fs.statSync(path.join(snapshot, 'uploads')).isDirectory());
  assert.ok(fs.statSync(path.join(snapshot, 'backup.json')).size > 0);
});

test('demo seed utilities refuse to run in production mode', async () => {
  await assert.rejects(
    runNode('server/seed.js', { NODE_ENV: 'production', SECRET_KEY: 'test-only-production-secret' }),
    /Demo seeding is disabled/
  );
  await assert.rejects(
    runNode('server/seed-invoices.js', { NODE_ENV: 'production', SECRET_KEY: 'test-only-production-secret' }),
    /Demo invoice seeding is disabled/
  );
});

test('40 simultaneous reps can authenticate and perform mixed read/write traffic', async () => {
  const loginStarted = performance.now();
  const loadUsers = fixture.loadUsers.slice(1);
  loadUsers.push({ ...fixture.loadUsers[0], email: fixture.loadUsers[0].email, password: 'Changed-RouteOne-Password-2026' });
  const sessions = await Promise.all(loadUsers.map(async (user) => ({
    ...user,
    cookie: await login(user.email, user.password || testPassword)
  })));
  const loginElapsedMs = performance.now() - loginStarted;

  const timings = [];
  const failures = [];
  await Promise.all(sessions.map(async (session, repIndex) => {
    for (let round = 0; round < 8; round += 1) {
      const operations = [
        request('/api/my-day', { cookie: session.cookie }),
        request('/api/products?active=true', { cookie: session.cookie }),
        request('/api/tasks?filter=upcoming', { cookie: session.cookie }),
        request('/api/locations', {
          method: 'POST',
          cookie: session.cookie,
          origin: allowedOrigin,
          body: { lat: -33.9 + repIndex * 0.0001, lng: 18.4 + round * 0.0001 }
        })
      ];
      const results = await Promise.all(operations);
      for (const result of results) {
        timings.push(result.elapsedMs);
        if (result.response.status !== 200) failures.push(result.response.status);
      }
    }
  }));

  timings.sort((a, b) => a - b);
  const percentile = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
  const loadResult = {
    reps: sessions.length,
    requests: timings.length,
    failures: failures.length,
    login_elapsed_ms: Math.round(loginElapsedMs),
    p50_ms: Math.round(percentile(0.50)),
    p95_ms: Math.round(percentile(0.95)),
    p99_ms: Math.round(percentile(0.99)),
    max_ms: Math.round(timings[timings.length - 1])
  };
  console.log(`LOAD_RESULT ${JSON.stringify(loadResult)}`);
  assert.equal(failures.length, 0);
  assert.ok(percentile(0.95) < 5000, JSON.stringify(loadResult));
});

test('settings routes: rep contacts are private, recipients are admin-only, duplicates are rejected', async () => {
  const adminCookie = await login(fixture.admin.email);
  const repCookie = await login(fixture.reps[0].email);
  const otherRepCookie = await login(fixture.reps[1].email);
  const opts = (cookie, extra = {}) => ({ cookie, origin: allowedOrigin, ...extra });

  const added = await request('/api/my-email-contacts', opts(repCookie, { method: 'POST', body: { name: 'Buyer', email: 'Buyer@Example.com' } }));
  assert.equal(added.response.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.email, 'buyer@example.com');
  const list = await request('/api/my-email-contacts', opts(repCookie));
  assert.equal(list.body.length, 1);
  assert.equal((await request('/api/my-email-contacts', opts(otherRepCookie))).body.length, 0);
  // Another rep cannot delete it, the owner can.
  assert.equal((await request(`/api/my-email-contacts/${added.body.id}`, opts(otherRepCookie, { method: 'DELETE' }))).response.status, 404);
  assert.equal((await request(`/api/my-email-contacts/${added.body.id}`, opts(repCookie, { method: 'DELETE' }))).response.status, 200);

  assert.equal((await request('/api/email-recipients', opts(repCookie))).response.status, 403);
  const create = { name: 'Orders Desk', email: 'Desk@Example.com', category: 'orders' };
  const made = await request('/api/email-recipients', opts(adminCookie, { method: 'POST', body: create }));
  assert.equal(made.response.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.email, 'desk@example.com');
  const dupe = await request('/api/email-recipients', opts(adminCookie, { method: 'POST', body: create }));
  assert.equal(dupe.response.status, 400);
  assert.equal(dupe.body.error, 'Email already exists');
  const all = await request('/api/email-recipients', opts(adminCookie));
  assert.ok(all.body.some((r) => r.id === made.body.id));
  assert.equal((await request(`/api/email-recipients/${made.body.id}`, opts(adminCookie, { method: 'DELETE' }))).response.status, 200);
});

test('small route files still work after the async migration (tasks, documents, pushes, tickets, clock-in, invoices, drafts)', async () => {
  const adminCookie = await login(fixture.admin.email);
  const repCookie = await login(fixture.reps[0].email);
  const o = (cookie, method = 'GET', body) => ({ cookie, origin: allowedOrigin, method, ...(body ? { body } : {}) });
  const ok = (r, label) => assert.equal(r.response.status, 200, `${label}: ${r.response.status} ${JSON.stringify(r.body)}`);

  // tasks
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const task = await request('/api/tasks', o(repCookie, 'POST', { customer_id: fixture.customers[0].id, task_type: 'Call Customer', follow_up_date: day, notes: 'ring' }));
  ok(task, 'create task');
  assert.ok(task.body.id);
  ok(await request(`/api/tasks/${task.body.id}`, o(repCookie, 'PUT', { status: 'done' })), 'update task');
  const tasks = await request('/api/tasks?filter=all', o(repCookie));
  ok(tasks, 'list tasks');
  assert.ok(Array.isArray(tasks.body));
  ok(await request('/api/tasks/all', o(adminCookie)), 'all tasks');
  ok(await request(`/api/customers/${fixture.customers[0].id}/tasks`, o(repCookie)), 'customer tasks');
  assert.equal((await request('/api/tasks', o(repCookie, 'POST', { customer_id: fixture.customers[1].id, task_type: 'Call Customer', follow_up_date: day }))).response.status, 403);

  // documents
  ok(await request('/api/documents', o(repCookie)), 'documents');
  const before = await request('/api/documents/unread-count', o(repCookie));
  ok(before, 'unread');
  assert.equal(typeof before.body.count, 'number');
  ok(await request('/api/documents/mark-viewed', o(repCookie, 'POST')), 'mark viewed');

  // sales pushes
  const push = await request('/api/sales-pushes', o(adminCookie, 'POST', { message: 'Push flour' }));
  ok(push, 'create push');
  ok(await request(`/api/sales-pushes/${push.body.id}`, o(adminCookie, 'PUT', { message: 'Push flour hard', active: true })), 'update push');
  const active = await request('/api/sales-pushes/active', o(repCookie));
  assert.ok(active.body.some((p) => p.id === push.body.id && p.message === 'Push flour hard'));
  ok(await request('/api/sales-pushes', o(adminCookie)), 'list pushes');
  ok(await request(`/api/sales-pushes/${push.body.id}`, o(adminCookie, 'DELETE')), 'delete push');

  // support tickets
  const ticket = await request('/api/support-tickets', o(repCookie, 'POST', { subject: 'App slow', description: 'Very', category: 'other' }));
  ok(ticket, 'create ticket');
  ok(await request('/api/support-tickets', o(adminCookie)), 'list tickets');
  ok(await request(`/api/support-tickets/${ticket.body.id}`, o(adminCookie)), 'get ticket');
  ok(await request(`/api/support-tickets/${ticket.body.id}`, o(adminCookie, 'PUT', { status: 'resolved', admin_notes: 'done' })), 'update ticket');

  // branch clock-in
  const clock = await request('/api/branch-clock-in', o(repCookie, 'POST', { notes: 'arrived' }));
  ok(clock, 'clock in');
  ok(await request('/api/branch-clock-in/today', o(repCookie)), 'clock-ins today');
  ok(await request(`/api/branch-clock-in/${clock.body.id}`, o(repCookie, 'PUT', { notes: 'edited' })), 'edit clock-in');
  ok(await request(`/api/branch-clock-in/${clock.body.id}/clock-out`, o(repCookie, 'POST')), 'clock out');

  // invoices
  const invoices = await request('/api/invoices', o(adminCookie));
  ok(invoices, 'invoices');
  assert.ok(Array.isArray(invoices.body));
  ok(await request(`/api/invoices/${fixture.invoiceId}`, o(adminCookie)), 'invoice detail');

  // drafts
  const draft = await request('/api/drafts', o(repCookie, 'POST', { kind: 'order', customer_id: fixture.customers[0].id, label: 'wip', data: { a: 1 } }));
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  ok(await request(`/api/drafts/${draft.body.id}`, o(repCookie, 'PUT', { label: 'wip2', data: { a: 2 } })), 'update draft');
  ok(await request(`/api/drafts/${draft.body.id}`, o(repCookie)), 'get draft');
  ok(await request('/api/drafts', o(repCookie)), 'list drafts');
  ok(await request(`/api/drafts/${draft.body.id}`, o(repCookie, 'DELETE')), 'delete draft');
});

// Runs in shadow-validation mode (DBX_SHADOW_LOG set, see server/dbxShadow.js) and
// against SQL Server: hits every GET route as admin and as a rep. Their SQL is
// bound against the SQL Server schema (shadow mode) or executed for real
// (mssql mode). Any 5xx fails the test - the routes' data is not asserted.
test('crawl: every GET route answers without a server error', { skip: !(process.env.DBX_SHADOW_LOG || useMssql) }, async () => {
  const routesDir = path.join(projectRoot, 'server', 'routes');
  const paths = new Set();
  for (const f of fs.readdirSync(routesDir)) {
    for (const m of fs.readFileSync(path.join(routesDir, f), 'utf8').matchAll(/router\.get\(\s*'([^']+)'/g)) {
      paths.add(m[1].replace(/:\w+/g, '1'));
    }
  }
  const adminCookie = await login(fixture.admin.email);
  const repCookie = await login(fixture.reps[0].email);
  const failures = [];
  let visited = 0;
  for (const p of paths) {
    for (const [who, cookie] of [['admin', adminCookie], ['rep', repCookie]]) {
      const r = await request(`/api${p}`, { cookie, origin: allowedOrigin }).catch((e) => ({ response: { status: 599 }, body: { error: e.message } }));
      visited += 1;
      if (r.response.status >= 500) failures.push(`${who} GET ${p} -> ${r.response.status}`);
    }
  }
  if (process.env.DBX_SHADOW_LOG) await request('/api/__shadow/flush'); // wait for the SQL Server checks to finish
  console.log(`crawl: ${paths.size} paths, ${visited} requests, ${failures.length} server errors`);
  assert.deepEqual(failures, []);
});

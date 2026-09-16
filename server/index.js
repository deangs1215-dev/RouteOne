import 'dotenv/config'; // must run first - sets SECRET_KEY etc. before anything reads process.env
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { db, UPLOAD_DIR } from './db.js';
import { requireAuth, customerGuard, passwordGuard, scopeForUser } from './auth.js';
import authRoutes from './routes/auth.routes.js';
import customerRoutes from './routes/customers.routes.js';
import productRoutes from './routes/products.routes.js';
import visitRoutes from './routes/visits.routes.js';
import orderRoutes from './routes/orders.routes.js';
import quoteRoutes from './routes/quotes.routes.js';
import formRoutes from './routes/forms.routes.js';
import syncRoutes from './routes/sync.routes.js';
import planningRoutes from './routes/planning.routes.js';
import cycleRoutes from './routes/cycles.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import integrationRoutes from './routes/integration.routes.js';
import intelligenceRoutes from './routes/intelligence.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import invoicesRoutes from './routes/invoices.routes.js';
import documentRoutes from './routes/documents.routes.js';
import backupRoutes from './routes/backups.routes.js';
import monitoringRoutes from './routes/monitoring.routes.js';
import salesPushesRoutes from './routes/sales-pushes.routes.js';
import draftsRoutes from './routes/drafts.routes.js';
import supportRoutes from './routes/support.routes.js';
import branchClockInRoutes from './routes/branch-clock-in.routes.js';
import { startScheduler } from './integration/scheduler.js';
import { startRepDigestScheduler } from './integration/repDigest.js';
import { startBackupScheduler } from './backup.js';
import { ensureDefaultForms } from './defaultForms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(compression());                 // gzip JSON/HTML - big saving on mobile networks

const configuredOrigins = (process.env.APP_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins.length
  ? configuredOrigins
  : ['http://localhost:4200', 'http://127.0.0.1:4200', 'http://localhost:5190', 'http://127.0.0.1:5190', 'http://localhost:3000', 'http://127.0.0.1:3000']);
if (process.env.NODE_ENV === 'production' && !configuredOrigins.length) {
  throw new Error('APP_ORIGIN is required in production');
}

function originAllowed(origin) {
  return !origin || allowedOrigins.has(origin);
}

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    callback(null, originAllowed(origin));
  }
}));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (crossSite || !originAllowed(origin))) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
});
app.use(express.json({ limit: '12mb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: blob: https://*.openstreetmap.org",
    "connect-src 'self' https://router.project-osrm.org https://*.openstreetmap.org",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => {
  const ok = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
  res.status(ok ? 200 : 503).json({ ok });
});
app.use('/api/auth', authRoutes);

function canReadUpload(user, relativePath) {
  if (scopeForUser(user).isOffice) return true;
  if (user.role_name !== 'rep') return false;
  if (db.prepare('SELECT 1 FROM documents WHERE file_path = ?').get(relativePath)) return true;
  if (db.prepare(`
    SELECT 1 FROM visit_photos p
    JOIN visits v ON v.id = p.visit_id
    WHERE p.path = ? AND v.rep_id = ?
  `).get(relativePath, user.id)) return true;
  return !!db.prepare(`
    SELECT 1 FROM form_submissions
    WHERE user_id = ? AND instr(data, ?) > 0
  `).get(user.id, relativePath);
}

app.get('/uploads/:filename', requireAuth, customerGuard, passwordGuard, (req, res, next) => {
  const filename = req.params.filename;
  if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|webp|pdf)$/i.test(filename)) {
    return res.status(404).end();
  }
  const relativePath = `/uploads/${filename}`;
  if (!canReadUpload(req.user, relativePath)) {
    return res.status(403).json({ error: 'File access denied' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(path.join(UPLOAD_DIR, filename), (err) => {
    if (err) next(err);
  });
});
// Every /api route below requires a valid login; customer-portal logins are
// additionally fenced off from the internal endpoints by customerGuard.
app.use('/api', requireAuth, customerGuard, passwordGuard, customerRoutes);
app.use('/api', productRoutes);
app.use('/api', visitRoutes);
app.use('/api', orderRoutes);
app.use('/api', quoteRoutes);
app.use('/api', formRoutes);
app.use('/api', syncRoutes);
app.use('/api', planningRoutes);
app.use('/api', cycleRoutes);
app.use('/api', tasksRoutes);
app.use('/api', integrationRoutes);
app.use('/api', intelligenceRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', invoicesRoutes);
app.use('/api', documentRoutes);
app.use('/api', backupRoutes);
app.use('/api', monitoringRoutes);
app.use('/api', salesPushesRoutes);
app.use('/api', draftsRoutes);
app.use('/api', supportRoutes);
app.use('/api', branchClockInRoutes);
app.use('/api', settingsRoutes);

// Serve the built client in production. Vite fingerprints asset filenames, so
// they can be cached hard; index.html must stay fresh so new builds are picked up.
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, {
    maxAge: '1y',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  app.get(/^(?!\/api|\/uploads).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, req, res, next) => {
  console.error(err);
  // A sync holding a write lock past better-sqlite3's busy_timeout (db.js) throws
  // this instead of waiting forever - tell the rep to retry rather than showing
  // a bare "Internal server error" for what is a transient, self-resolving state.
  if (err.code === 'SQLITE_BUSY') {
    return res.status(503).json({ error: 'Sync in progress - please try again in a few minutes' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// Last-resort backstop. Node's default for an unhandled rejection is to exit,
// which would take every logged-in rep offline for a fault in a background job
// that has nothing to do with serving requests. Individual jobs still handle
// their own errors - this only stops one that slipped through from ending the
// process. Logged loudly so it is fixed at source rather than left to absorb.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept running):', reason);
});

export function startServer(port = process.env.API_PORT || 4200) {
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM roles').get().n > 0;
  if (!seeded) console.log('! Database is empty - run "npm run seed" to load demo data.');
  else ensureDefaultForms(); // add the standard customer-visit forms if missing

  return app.listen(port, () => {
    console.log(`RouteOne API running on http://localhost:${port}`);
    if (process.env.DISABLE_SCHEDULERS !== '1') {
      startScheduler();
      startRepDigestScheduler();
      startBackupScheduler();
    }
  });
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) startServer();

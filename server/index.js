import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db, UPLOAD_DIR } from './db.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.routes.js';
import customerRoutes from './routes/customers.routes.js';
import productRoutes from './routes/products.routes.js';
import visitRoutes from './routes/visits.routes.js';
import orderRoutes from './routes/orders.routes.js';
import quoteRoutes from './routes/quotes.routes.js';
import formRoutes from './routes/forms.routes.js';
import syncRoutes from './routes/sync.routes.js';
import planningRoutes from './routes/planning.routes.js';
import integrationRoutes from './routes/integration.routes.js';
import intelligenceRoutes from './routes/intelligence.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import { startScheduler } from './integration/scheduler.js';
import { ensureDefaultForms } from './defaultForms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(compression());                 // gzip JSON/HTML - big saving on mobile networks
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/api/auth', authRoutes);
app.use('/api', requireAuth, customerRoutes);
app.use('/api', productRoutes);
app.use('/api', visitRoutes);
app.use('/api', orderRoutes);
app.use('/api', quoteRoutes);
app.use('/api', formRoutes);
app.use('/api', syncRoutes);
app.use('/api', planningRoutes);
app.use('/api', integrationRoutes);
app.use('/api', intelligenceRoutes);
app.use('/api', dashboardRoutes);

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
  res.status(500).json({ error: 'Internal server error' });
});

const seeded = db.prepare('SELECT COUNT(*) AS n FROM roles').get().n > 0;
if (!seeded) console.log('! Database is empty - run "npm run seed" to load demo data.');
else ensureDefaultForms(); // add the standard customer-visit forms if missing

const PORT = process.env.API_PORT || 4200;
app.listen(PORT, () => {
  console.log(`RouteOne API running on http://localhost:${PORT}`);
  startScheduler(); // automatic SYSPRO sync per the schedule set on the Integration page
});

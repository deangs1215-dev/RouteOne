// Runs every test that can run on SQL Server, in order, against RouteOne_Test.
//   npm run test:mssql
// They share one scratch database and each wipes it first, so they must not overlap.
import { spawnSync } from 'node:child_process';
const suites = ['api.integration', 'scripts', 'sync', 'dbh', 'email', 'scheduler'].map((n) => `server/tests/${n}.test.js`);
const r = spawnSync(process.execPath, ['--env-file=server/.env', '--test', '--test-concurrency=1', ...suites], {
  stdio: 'inherit',
  env: { ...process.env, DB_BACKEND: 'mssql', DB_NAME: 'RouteOne_Test' }
});
process.exit(r.status ?? 1);

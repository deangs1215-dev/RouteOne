// Shared by tests that can run on either backend. On SQL Server the target is
// emptied first, so it only ever runs against a database named RouteOne_Test.
export const useMssql = (process.env.DB_BACKEND || '').toLowerCase() === 'mssql';

export async function resetBackend(dbx) {
  if (!useMssql) return; // SQLite tests get a fresh temp file
  if (process.env.DB_NAME !== 'RouteOne_Test') {
    throw new Error('refusing to wipe a database other than RouteOne_Test');
  }
  const { wipeTables } = await import('../dbh.js');
  const tables = (await dbx.prepare("SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'").all()).map((t) => t.name);
  await wipeTables(tables);
}

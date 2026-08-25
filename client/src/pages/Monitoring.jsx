// Read-only ops snapshot (disk, DB size, backups, monitor-script logs) plus an
// editable alert-recipient list. Surfaces what previously required RDP +
// PowerShell into the app itself - see MONITORING_SETUP.md for the underlying
// scheduled tasks this reads from (server/monitor-*.ps1).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Field, ErrorNote, Spinner } from '../components/ui';

const GB = (bytes) => (bytes == null ? null : (bytes / 1024 ** 3).toFixed(1));

function Bar({ usedBytes, totalBytes }) {
  const pct = totalBytes ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;
  const color = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function LogLine({ line }) {
  const color = line.includes('[FAIL]') ? 'text-red-600' : line.includes('[WARN]') ? 'text-amber-600' : 'text-slate-500';
  return <div className={`font-mono text-xs ${color}`}>{line}</div>;
}

function LogPanel({ title, lines }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {lines.length === 0 ? (
        <div className="text-xs text-slate-400">No entries yet — the scheduled task may not have run, or isn't deployed on this server.</div>
      ) : (
        <div className="space-y-0.5">{lines.map((l, i) => <LogLine key={i} line={l} />)}</div>
      )}
    </div>
  );
}

export default function Monitoring() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState('');

  const load = () => {
    api.get('/monitoring/status')
      .then((s) => { setStatus(s); setRecipients(s.alertRecipients || ''); })
      .catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, []);

  const saveRecipients = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      await api.put('/monitoring/alert-recipients', { value: recipients });
      setNotice('Alert recipients saved.');
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  if (!status) return error ? <ErrorNote error={error} /> : <Spinner />;

  const diskUsedGB = GB(status.disk?.usedBytes);
  const diskTotalGB = GB(status.disk?.totalBytes);
  const diskFreeGB = GB(status.disk?.freeBytes);
  const dbSizeGB = GB(status.database?.sizeBytes);
  const backupSizeMB = status.backups.latest ? (status.backups.latest.sizeBytes / 1024 ** 2).toFixed(0) : null;
  const backupAgeHours = status.backups.latest
    ? ((Date.now() - new Date(status.backups.latest.createdAt).getTime()) / 3600000).toFixed(1)
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Monitoring</h1>
      <ErrorNote error={error} />
      {notice && <div className="rounded bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <Card title="Server disk space">
        {status.disk ? (
          <>
            <Bar usedBytes={status.disk.usedBytes} totalBytes={status.disk.totalBytes} />
            <p className="mt-2 text-sm text-slate-600">
              {diskUsedGB}GB used / {diskTotalGB}GB total — <span className={Number(diskFreeGB) < 20 ? 'font-semibold text-red-600' : Number(diskFreeGB) < 50 ? 'font-semibold text-amber-600' : ''}>{diskFreeGB}GB free</span>
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">Could not read disk space (PowerShell unavailable, or the app doesn't have permission).</p>
        )}
      </Card>

      <Card title="Database">
        <p className="text-sm text-slate-600">Size: {dbSizeGB ? `${dbSizeGB}GB` : '—'}</p>
      </Card>

      <Card title="Backups">
        {status.backups.latest ? (
          <div className="text-sm text-slate-600">
            <p>Latest: <span className="font-mono">{status.backups.latest.name}</span></p>
            <p>{backupSizeMB}MB, {backupAgeHours}h ago</p>
            <p>{status.backups.count} backups on disk</p>
          </div>
        ) : (
          <p className="text-sm text-red-600">No backups found — check the Backups admin page.</p>
        )}
      </Card>

      <Card title="Alert recipients">
        <p className="mb-2 text-sm text-slate-500">
          Comma-separated email addresses. Used by the scheduled health/disk/backup
          monitor scripts (server/monitor-*.ps1) — takes effect on their next run,
          no restart needed.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Field label="Recipients" span>
            <input className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="it-oncall@sbakels.net,dean@sbakels.co.za" />
          </Field>
        </div>
        <button className="btn-primary mt-3" onClick={saveRecipients} disabled={busy === 'save'}>
          {busy === 'save' ? 'Saving…' : 'Save recipients'}
        </button>
      </Card>

      <Card title="Recent monitor activity">
        <div className="grid gap-4 sm:grid-cols-3">
          <LogPanel title="Health checks" lines={status.logs.health} />
          <LogPanel title="Disk checks" lines={status.logs.disk} />
          <LogPanel title="Backup checks" lines={status.logs.backup} />
        </div>
      </Card>
    </div>
  );
}

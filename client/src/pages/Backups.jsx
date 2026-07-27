// Database + uploads backup management. Restore is destructive and requires
// the admin to restart the server afterward - see server/backup.js for why.
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote } from '../components/ui';

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function Backups() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [schedule, setSchedule] = useState(null);
  const [restoring, setRestoring] = useState(null); // backup row being confirmed

  const load = () => api.get('/backups').then((d) => { setData(d); setSchedule(d.schedule); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (!data) return <Spinner />;

  const saveSchedule = async () => {
    setBusy('schedule');
    setError('');
    setNotice('');
    try {
      await api.put('/backups/schedule', schedule);
      setNotice('Backup schedule saved.');
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const runNow = async () => {
    setBusy('run');
    setError('');
    setNotice('');
    try {
      await api.post('/backups/run', {});
      setNotice('Backup completed.');
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Backups</h1>
      <ErrorNote error={error} />
      {notice && <div className="rounded bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <Card title="Schedule">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Automatic backups">
            <label className="flex items-center gap-2 pt-2 text-sm">
              <input type="checkbox" checked={schedule.enabled === '1'}
                onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked ? '1' : '0' })} />
              Enabled
            </label>
          </Field>
          <Field label="Time of day">
            <input className="input" type="time" value={schedule.time}
              onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} disabled={schedule.enabled !== '1'} />
          </Field>
          <Field label="Keep backups for (days)">
            <input className="input" type="number" min="1" value={schedule.retention_days}
              onChange={(e) => setSchedule({ ...schedule, retention_days: e.target.value })} disabled={schedule.enabled !== '1'} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn-primary" onClick={saveSchedule} disabled={busy === 'schedule'}>
            {busy === 'schedule' ? 'Saving…' : 'Save schedule'}
          </button>
          <button className="btn-secondary" onClick={runNow} disabled={busy === 'run'}>
            {busy === 'run' ? 'Backing up…' : 'Run backup now'}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Backs up the database and uploaded files together to {data.last_backup_path ? <span className="font-mono">{data.last_backup_path.replace(/[/\\][^/\\]+$/, '')}</span> : 'the configured backup folder'}.
          Last backup: {data.last_backup_at ? fmtDateTime(data.last_backup_at) : 'never'}.
        </p>
      </Card>

      <Card title="Available backups">
        <Table headers={['Created', 'Size', '']} empty={data.backups.length === 0 && 'No backups yet.'}>
          {data.backups.map((b) => (
            <tr key={b.name} className="hover:bg-slate-50">
              <td className="td font-medium">{fmtDateTime(b.created_at)}</td>
              <td className="td text-slate-500">{fmtBytes(b.size_bytes)}</td>
              <td className="td text-right">
                <button className="text-xs text-red-600 hover:underline" onClick={() => setRestoring(b)}>restore</button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {restoring && (
        <RestoreModal backup={restoring} onClose={() => setRestoring(null)} />
      )}
    </div>
  );
}

function RestoreModal({ backup, onClose }) {
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post(`/backups/${backup.name}/restore`, {});
      setDone(true);
      void result;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Restore backup" onClose={onClose}>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-emerald-700">Restore complete.</p>
          <p className="text-sm text-slate-600">
            The server has taken a safety backup of what was live, restored this snapshot, and shut itself
            down — it must be restarted before the restored data loads. Restart it now
            (<span className="font-mono">npm run dev</span> / <span className="font-mono">npm start</span>), then reload this page.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <ErrorNote error={error} />
          <p className="text-sm text-slate-600">
            This replaces the <b>entire live database and all uploaded files</b> with the backup from{' '}
            <b>{fmtDateTimeInline(backup.created_at)}</b>. Everything created or changed since then will be lost.
            A safety backup of the current state is taken automatically first, but the server will shut down
            immediately after and must be restarted manually.
          </p>
          <Field label={<>Type <span className="font-mono">RESTORE</span> to confirm</>}>
            <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          </Field>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              disabled={confirmText !== 'RESTORE' || busy} onClick={restore}>
              {busy ? 'Restoring…' : 'Restore and shut down'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function fmtDateTimeInline(s) {
  return s ? new Date(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

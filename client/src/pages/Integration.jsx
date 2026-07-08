// SYSPRO / email integration admin: connection settings, sync runs, email log.
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge } from '../components/ui';
import { useAuth } from '../auth';

const STATUS_COLORS = { completed: '#16a34a', failed: '#dc2626', running: '#f59e0b', sent: '#16a34a', pending: '#f59e0b' };

export default function Integration() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [settings, setSettings] = useState(null);
  const [runs, setRuns] = useState([]);
  const [emails, setEmails] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = () => {
    if (isAdmin) api.get('/integration/settings').then(setSettings).catch((e) => setError(e.message));
    api.get('/integration/sync-runs').then(setRuns).catch(() => {});
    api.get('/integration/emails').then(setEmails).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setSettings({ ...settings, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value });

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      await api.put('/integration/settings', settings);
      setNotice('Settings saved.');
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const testConnection = async () => {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const r = await api.post('/integration/test-connection');
      setNotice(`Connection OK (source: ${r.source}).`);
    } catch (e) { setError(`Connection failed: ${e.message}`); }
    setBusy('');
  };

  const sync = async (entity) => {
    setBusy(entity);
    setError('');
    setNotice('');
    try {
      const r = await api.post(`/integration/sync/${entity}`);
      const parts = (r.results || [r]).map((x) => `${x.entity}: ${x.rows_upserted}/${x.rows_read}${x.row_errors ? ` (${x.row_errors} errors)` : ''}`);
      setNotice(`Sync done — ${parts.join(', ')}`);
      load();
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const resend = async (id) => {
    try { await api.post(`/integration/emails/${id}/resend`); load(); }
    catch (e) { setError(e.message); }
  };

  const openEmail = async (id) => {
    try { setViewing(await api.get(`/integration/emails/${id}`)); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">SYSPRO integration</h1>
      <ErrorNote error={error} />
      {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-3 py-2">{notice}</div>}

      {isAdmin && (!settings ? <Spinner /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="SYSPRO connection (read-only SQL views)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Data source">
                <select className="input" value={settings.intg_source || 'demo'} onChange={set('intg_source')}>
                  <option value="demo">Demo data (no SYSPRO yet)</option>
                  <option value="syspro">SYSPRO SQL Server</option>
                </select>
              </Field>
              <div />
              <Field label="SQL Server host"><input className="input" value={settings.syspro_host || ''} onChange={set('syspro_host')} placeholder="SYSPROSVR01" /></Field>
              <Field label="Port"><input className="input" value={settings.syspro_port || ''} onChange={set('syspro_port')} placeholder="1433" /></Field>
              <Field label="Database"><input className="input" value={settings.syspro_db || ''} onChange={set('syspro_db')} placeholder="SysproCompanyA" /></Field>
              <Field label="SQL login (read-only)"><input className="input" value={settings.syspro_user || ''} onChange={set('syspro_user')} placeholder="fieldsales_ro" /></Field>
              <Field label={`Password${settings.syspro_password_set ? ' (saved — type to replace)' : ''}`}>
                <input className="input" type="password" onChange={set('syspro_password')} placeholder="••••••••" />
              </Field>
              <div />
              <Field label="Customers view"><input className="input" value={settings.syspro_view_customers || ''} onChange={set('syspro_view_customers')} placeholder="vw_FS_Customers" /></Field>
              <Field label="Products view"><input className="input" value={settings.syspro_view_products || ''} onChange={set('syspro_view_products')} placeholder="vw_FS_Products" /></Field>
              <Field label="Stock view"><input className="input" value={settings.syspro_view_stock || ''} onChange={set('syspro_view_stock')} placeholder="vw_FS_Stock" /></Field>
              <Field label="Contract prices view"><input className="input" value={settings.syspro_view_prices || ''} onChange={set('syspro_view_prices')} placeholder="vw_FS_ContractPrices" /></Field>
            </div>
            <div className="mt-4 flex gap-2">
              <button className="btn-primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
              <button className="btn-secondary" onClick={testConnection} disabled={busy === 'test'}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            </div>
          </Card>

          <Card title="Email (orders dept + customer quotes)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Orders department email" span>
                <input className="input" value={settings.orders_email || ''} onChange={set('orders_email')} placeholder="orders@yourcompany.co.za" />
              </Field>
              <Field label="SMTP host"><input className="input" value={settings.smtp_host || ''} onChange={set('smtp_host')} placeholder="smtp.office365.com" /></Field>
              <Field label="SMTP port"><input className="input" value={settings.smtp_port || ''} onChange={set('smtp_port')} placeholder="587" /></Field>
              <Field label="SMTP user"><input className="input" value={settings.smtp_user || ''} onChange={set('smtp_user')} /></Field>
              <Field label={`SMTP password${settings.smtp_password_set ? ' (saved — type to replace)' : ''}`}>
                <input className="input" type="password" onChange={set('smtp_password')} placeholder="••••••••" />
              </Field>
              <Field label="From address"><input className="input" value={settings.smtp_from || ''} onChange={set('smtp_from')} placeholder="fieldsales@yourcompany.co.za" /></Field>
              <Field label="Options">
                <div className="space-y-1 pt-1 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={settings.smtp_secure === '1'} onChange={set('smtp_secure')} /> SSL/TLS (port 465)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={(settings.email_auto_send ?? '1') === '1'} onChange={set('email_auto_send')} /> Auto-email orders on submit
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={(settings.email_confirm_customer ?? '1') === '1'} onChange={set('email_confirm_customer')} /> Also send customer a confirmation
                  </label>
                </div>
              </Field>
            </div>
            <p className="mt-3 text-xs text-slate-400">Orders are emailed to the orders department for capture into SYSPRO (rep in CC). Quotes are emailed to the customer. If SMTP isn't configured, emails wait in the log below and can be sent later.</p>
          </Card>
        </div>
      ))}

      <Card title="Data sync" actions={
        <div className="flex gap-2">
          {['customers', 'products', 'stock', 'prices'].map((e) => (
            <button key={e} className="btn-secondary text-xs capitalize" onClick={() => sync(e)} disabled={!!busy}>
              {busy === e ? 'Syncing…' : e}
            </button>
          ))}
          <button className="btn-primary text-xs" onClick={() => sync('all')} disabled={!!busy}>
            {busy === 'all' ? 'Syncing…' : '⟳ Sync all'}
          </button>
        </div>
      }>
        {isAdmin && settings && (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Automatic sync">
                <select className="input" value={settings.sync_schedule || 'off'} onChange={set('sync_schedule')}>
                  <option value="off">Off (manual only)</option>
                  <option value="hourly">Every hour</option>
                  <option value="4hours">Every 4 hours</option>
                  <option value="daily">Daily at…</option>
                </select>
              </Field>
              {settings.sync_schedule === 'daily' && (
                <Field label="Time">
                  <input className="input" type="time" value={settings.sync_daily_time || '02:00'} onChange={set('sync_daily_time')} />
                </Field>
              )}
              <button className="btn-secondary" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Saving…' : 'Save schedule'}
              </button>
              <div className="text-xs text-slate-500">
                {settings.last_auto_sync_at
                  ? <>Last auto-sync: {fmtDateTime(settings.last_auto_sync_at)}<br />{settings.last_auto_sync_result}</>
                  : 'No automatic sync has run yet.'}
              </div>
            </div>
          </div>
        )}
        <Table headers={['#', 'Source', 'Entity', 'Read', 'Upserted', 'Status', 'Started', 'Errors']}
          empty={runs.length === 0 && 'No syncs yet — hit "Sync all".'}>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="td text-slate-400">{r.id}</td>
              <td className="td">{r.source}</td>
              <td className="td capitalize font-medium">{r.entity}</td>
              <td className="td">{r.rows_read}</td>
              <td className="td">{r.rows_upserted}</td>
              <td className="td"><Badge color={STATUS_COLORS[r.status]}>{r.status}</Badge></td>
              <td className="td text-slate-500">{fmtDateTime(r.started_at)}</td>
              <td className="td text-xs text-red-600 max-w-[280px] truncate" title={r.error || ''}>{r.error || '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Email log">
        <Table headers={['Kind', 'To', 'Subject', 'Status', 'When', '']}
          empty={emails.length === 0 && 'No emails yet — submit an order.'}>
          {emails.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="td capitalize">{e.kind}</td>
              <td className="td text-slate-500">{e.to_addr}</td>
              <td className="td max-w-[300px] truncate" title={e.subject}>{e.subject}</td>
              <td className="td">
                <Badge color={STATUS_COLORS[e.status] || '#dc2626'}>{e.status}</Badge>
                {e.error && <span className="ml-1 text-xs text-slate-400" title={e.error}>ⓘ</span>}
              </td>
              <td className="td text-slate-500">{fmtDateTime(e.sent_at || e.created_at)}</td>
              <td className="td whitespace-nowrap">
                <button className="text-xs text-brand-600 hover:underline" onClick={() => openEmail(e.id)}>view</button>
                {e.status !== 'sent' && (
                  <button className="ml-2 text-xs text-brand-600 hover:underline" onClick={() => resend(e.id)}>send</button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {viewing && (
        <Modal title={viewing.subject} onClose={() => setViewing(null)} wide>
          <div className="mb-2 text-xs text-slate-500">To: {viewing.to_addr}{viewing.cc_addr ? ` · CC: ${viewing.cc_addr}` : ''}</div>
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-slate-200 p-3"
            dangerouslySetInnerHTML={{ __html: viewing.body_html }} />
        </Modal>
      )}
    </div>
  );
}

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
  const [testTo, setTestTo] = useState('');
  const [connResult, setConnResult] = useState(null); // { ok, message } - shown right by the button
  const [matchResult, setMatchResult] = useState(null); // { ok, message } - shown right by the match-reps button

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

  const sendTest = async () => {
    setBusy('test-email');
    setError('');
    setNotice('');
    try {
      await api.post('/integration/test-email', { to: testTo });
      setNotice(`Test email sent to ${testTo}.`);
      load();
    } catch (e) { setError(`Test email failed: ${e.message}`); }
    setBusy('');
  };

  const testConnection = async () => {
    setBusy('test');
    setError('');
    setNotice('');
    setConnResult(null);
    try {
      // Send the form's current values (not just what's saved) so "Test
      // connection" checks what's actually typed, even before "Save settings".
      const r = await api.post('/integration/test-connection', {
        intg_source: settings.intg_source,
        syspro_host: settings.syspro_host,
        syspro_port: settings.syspro_port,
        syspro_db: settings.syspro_db,
        syspro_user: settings.syspro_user,
        syspro_encrypt: settings.syspro_encrypt ?? '1',
        syspro_trust_server_certificate: settings.syspro_trust_server_certificate ?? '0',
        syspro_password: settings.syspro_password || undefined
      });
      setConnResult({ ok: true, message: `Connection OK (source: ${r.source}).` });
    } catch (e) { setConnResult({ ok: false, message: e.message }); }
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

  const matchReps = async () => {
    setBusy('match-reps');
    setMatchResult(null);
    try {
      const r = await api.post('/integration/match-reps');
      setMatchResult({ ok: true, message: `${r.matched} newly assigned, ${r.alreadyAssigned} already had a rep, ${r.noMatch} had no matching rep code/branch (left unassigned).` });
    } catch (e) { setMatchResult({ ok: false, message: e.message }); }
    setBusy('');
  };

  const sendDigestNow = async () => {
    setBusy('digest');
    setError('');
    setNotice('');
    try {
      const r = await api.post('/integration/rep-digest/run-now');
      const sent = r.results.filter((x) => x.status === 'sent').length;
      const skipped = r.results.filter((x) => x.status.startsWith('skipped')).length;
      setNotice(`Digest run done — ${sent} sent, ${skipped} skipped (nothing to report), ${r.results.length - sent - skipped} failed.`);
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
        <>
        <Card title="Company details (letterhead on emails + PDF documents)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name" span>
              <input className="input" value={settings.company_name || ''} onChange={set('company_name')} placeholder="South Bakels (Pty) Ltd" />
            </Field>
            <Field label="Registration no"><input className="input" value={settings.company_reg || ''} onChange={set('company_reg')} placeholder="1970/012345/07" /></Field>
            <Field label="VAT no"><input className="input" value={settings.company_vat || ''} onChange={set('company_vat')} placeholder="4000000000" /></Field>
            <Field label="Address" span><input className="input" value={settings.company_address || ''} onChange={set('company_address')} placeholder="123 Bakery Road, Cape Town, 7405" /></Field>
            <Field label="Phone"><input className="input" value={settings.company_phone || ''} onChange={set('company_phone')} placeholder="+27 21 000 0000" /></Field>
            <Field label="Email"><input className="input" value={settings.company_email || ''} onChange={set('company_email')} placeholder="info@sbakels.co.za" /></Field>
            <Field label="Website"><input className="input" value={settings.company_website || ''} onChange={set('company_website')} placeholder="www.sbakels.co.za" /></Field>
            <Field label="Logo (PNG/JPG)">
              <div className="flex items-center gap-3">
                {settings.company_logo && <img src={settings.company_logo} alt="logo" className="h-10 max-w-[120px] object-contain rounded border border-slate-200 bg-white p-1" />}
                <input type="file" accept="image/png,image/jpeg" className="text-xs" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 500000) { setError('Logo too large — please use an image under 500KB.'); return; }
                  const reader = new FileReader();
                  reader.onload = () => setSettings({ ...settings, company_logo: reader.result });
                  reader.readAsDataURL(file);
                }} />
                {settings.company_logo && <button className="text-xs text-red-600 hover:underline" onClick={() => { if (window.confirm('Remove the company logo?')) setSettings({ ...settings, company_logo: '' }); }}>remove</button>}
              </div>
            </Field>
          </div>
          <div className="mt-4">
            <button className="btn-primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save company details'}</button>
          </div>
          <p className="mt-3 text-xs text-slate-400">These appear as the letterhead on customer emails and on the attached quote/order PDFs. The registration and VAT numbers show in the document footer.</p>
        </Card>

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
              <div className="space-y-2 text-sm text-slate-600">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={(settings.syspro_encrypt ?? '1') === '1'} onChange={set('syspro_encrypt')} />
                  Encrypt SQL connection
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.syspro_trust_server_certificate === '1'} onChange={set('syspro_trust_server_certificate')} />
                  Trust an internal server certificate
                </label>
              </div>
              <Field label="Warehouses view"><input className="input" value={settings.syspro_view_warehouses || ''} onChange={set('syspro_view_warehouses')} placeholder="vw_FS_Warehouses" /></Field>
              <Field label="Customers view"><input className="input" value={settings.syspro_view_customers || ''} onChange={set('syspro_view_customers')} placeholder="vw_FS_Customers" /></Field>
              <Field label="Products view"><input className="input" value={settings.syspro_view_products || ''} onChange={set('syspro_view_products')} placeholder="vw_FS_Products" /></Field>
              <Field label="Stock view"><input className="input" value={settings.syspro_view_stock || ''} onChange={set('syspro_view_stock')} placeholder="vw_FS_Stock" /></Field>
              <Field label="Customer pricing view"><input className="input" value={settings.syspro_view_customer_pricing || ''} onChange={set('syspro_view_customer_pricing')} placeholder="vw_FS_CustomerPricing_ContractBuyingGroup" /></Field>
              <Field label="Invoices view"><input className="input" value={settings.syspro_view_invoices || ''} onChange={set('syspro_view_invoices')} placeholder="vw_FS_Invoices" /></Field>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className="btn-primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
              <button className="btn-secondary" onClick={testConnection} disabled={busy === 'test'}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              {connResult && (
                <span className={`text-sm ${connResult.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                  {connResult.ok ? '✓' : '✗'} {connResult.message}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">Tests whatever is currently in the fields above (no need to save first).</p>
          </Card>

        </div>
        </>
      ))}

      <Card title="Data sync" actions={
        <div className="flex flex-wrap items-center gap-2">
          {['warehouses', 'customers', 'products', 'stock', 'customer_pricing', 'invoices'].map((e) => (
            <button key={e} className="btn-secondary text-xs capitalize" onClick={() => sync(e)} disabled={!!busy}>
              {busy === e ? 'Syncing…' : e.replace('_', ' ')}
            </button>
          ))}
          <button className="btn-primary text-xs" onClick={() => sync('all')} disabled={!!busy}>
            {busy === 'all' ? 'Syncing…' : '⟳ Sync all'}
          </button>
          <span className="mx-1 h-4 w-px bg-slate-200" />
          <button className="btn-primary text-xs" onClick={matchReps} disabled={!!busy}>
            {busy === 'match-reps' ? 'Syncing…' : '🔄 Sync rep'}
          </button>
        </div>
      }>
        {matchResult && (
          <div className={`mb-4 rounded-lg border p-3 text-sm ${matchResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
            {matchResult.ok ? '✓' : '✗'} {matchResult.message}
          </div>
        )}
        {isAdmin && settings && (
          <>
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <h3 className="font-medium text-sm mb-3">Automatic data sync</h3>
            <div className="space-y-3">
              {['warehouses', 'customers', 'products', 'stock', 'customer_pricing', 'invoices'].map((entity) => (
                <div key={entity} className="flex flex-wrap items-end gap-3 pb-3 border-b border-slate-200 last:border-b-0 last:pb-0">
                  <Field label={`${entity.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())} schedule`}>
                    <select className="input" value={settings[`${entity}_sync_schedule`] || 'off'} onChange={set(`${entity}_sync_schedule`)}>
                      <option value="off">Off (manual only)</option>
                      <option value="hourly">Every hour</option>
                      <option value="4hours">Every 4 hours</option>
                      <option value="daily">Daily at…</option>
                    </select>
                  </Field>
                  {settings[`${entity}_sync_schedule`] === 'daily' && (
                    <Field label="Time">
                      <input className="input" type="time" value={settings[`${entity}_sync_daily_time`] || '02:00'} onChange={set(`${entity}_sync_daily_time`)} />
                    </Field>
                  )}
                </div>
              ))}
              <button className="btn-secondary mt-3" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Saving…' : 'Save schedules'}
              </button>
              <div className="text-xs text-slate-500 mt-2">
                {settings.last_auto_sync_at
                  ? <>Last auto-sync: {fmtDateTime(settings.last_auto_sync_at)}<br />{settings.last_auto_sync_result}</>
                  : 'No automatic sync has run yet.'}
              </div>
            </div>
          </div>

          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <h3 className="font-medium text-sm mb-3">Automatic rep sync (match customers to sales reps)</h3>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Schedule">
                <select className="input" value={settings.rep_sync_schedule || 'off'} onChange={set('rep_sync_schedule')}>
                  <option value="off">Off (manual only)</option>
                  <option value="daily">Daily at…</option>
                </select>
              </Field>
              {settings.rep_sync_schedule === 'daily' && (
                <Field label="Time">
                  <input className="input" type="time" value={settings.rep_sync_daily_time || '03:00'} onChange={set('rep_sync_daily_time')} />
                </Field>
              )}
              <button className="btn-secondary" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Saving…' : 'Save schedule'}
              </button>
              <div className="text-xs text-slate-500">
                {settings.last_rep_sync_at
                  ? <>Last auto-sync: {fmtDateTime(settings.last_rep_sync_at)}<br />{settings.last_rep_sync_result}</>
                  : 'No automatic rep sync has run yet.'}
              </div>
            </div>
          </div>
          </>
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

      {isAdmin && settings && (
        <Card title="Rep daily digest email" actions={
          <button className="btn-primary text-xs" onClick={sendDigestNow} disabled={!!busy}>
            {busy === 'digest' ? 'Sending…' : '✉️ Send now'}
          </button>
        }>
          <p className="mb-3 text-sm text-slate-500">
            Each rep gets a morning email: yesterday's orders, today's planned customers, and any open tasks or Sales AI alerts on those customers.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Send daily digest">
                <select className="input" value={settings.rep_digest_enabled === '1' ? '1' : '0'} onChange={set('rep_digest_enabled')}>
                  <option value="0">Off</option>
                  <option value="1">On</option>
                </select>
              </Field>
              {settings.rep_digest_enabled === '1' && (
                <Field label="Time">
                  <input className="input" type="time" value={settings.rep_digest_time || '07:00'} onChange={set('rep_digest_time')} />
                </Field>
              )}
              <button className="btn-secondary" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Saving…' : 'Save schedule'}
              </button>
              <div className="text-xs text-slate-500">
                {settings.last_rep_digest_at
                  ? <>Last run: {fmtDateTime(settings.last_rep_digest_at)}<br />{settings.last_rep_digest_result}</>
                  : 'No digest has run yet.'}
              </div>
            </div>
          </div>
        </Card>
      )}

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
          <iframe
            title="Email preview"
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-[60vh] w-full rounded-lg border border-slate-200 bg-white"
            srcDoc={viewing.body_html}
          />
        </Modal>
      )}
    </div>
  );
}

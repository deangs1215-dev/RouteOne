// Email configuration: SMTP/Graph API, sender addresses, delivery options,
// and the configured recipient lists used for order/technical-form notices.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Field, ErrorNote, Spinner, Table, Modal } from '../components/ui';
import { useAuth } from '../auth';

export default function EmailSettings() {
  const { user } = useAuth();
  const canEdit = ['admin', 'manager'].includes(user.role);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [testTo, setTestTo] = useState('');

  const [recipients, setRecipients] = useState(null);
  const [editing, setEditing] = useState(null); // null | { category } | recipient

  const load = () => {
    api.get('/integration/settings').then(setSettings).catch((e) => setError(e.message));
  };
  const loadRecipients = () => {
    api.get('/email-recipients').then(setRecipients).catch(console.error);
  };
  useEffect(() => { load(); loadRecipients(); }, []);

  if (!settings) return <Spinner />;

  const ordersRecipients = recipients?.filter((r) => r.category === 'orders') ?? null;
  const technicalRecipients = recipients?.filter((r) => r.category === 'technical') ?? null;

  const set = (k) => (e) => setSettings({ ...settings, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value });

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      await api.put('/integration/settings', settings);
      setNotice('Email settings saved.');
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

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Email Settings</h1>

      <ErrorNote error={error} />
      {notice && <div className="rounded bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <Card title="Outgoing mail transport">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mail transport" span>
            <select className="input" value={settings.email_transport || 'smtp'} onChange={set('email_transport')}>
              <option value="smtp">SMTP (username/password)</option>
              <option value="graph">Microsoft 365 — Graph API (recommended for Exchange Online)</option>
            </select>
          </Field>

          {settings.email_transport === 'graph' ? (
            <>
              <div className="sm:col-span-2 text-xs text-slate-400">
                Requires an Azure AD app registration with Mail.Send application permission — see{' '}
                <span className="font-mono">docs/EMAIL-M365-SETUP.md</span> for the exact steps to hand your IT admin.
              </div>
              <Field label="Tenant ID"><input className="input" value={settings.graph_tenant_id || ''} onChange={set('graph_tenant_id')} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></Field>
              <Field label="Client (application) ID"><input className="input" value={settings.graph_client_id || ''} onChange={set('graph_client_id')} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></Field>
              <Field label={`Client secret${settings.graph_client_secret_set ? ' (saved — type to replace)' : ''}`}>
                <input className="input" type="password" onChange={set('graph_client_secret')} placeholder="••••••••" />
              </Field>
              <Field label="Sender mailbox">
                <input className="input" value={settings.graph_sender || ''} onChange={set('graph_sender')} placeholder="fieldsales@yourcompany.co.za" />
              </Field>
            </>
          ) : (
            <>
              <Field label="SMTP host"><input className="input" value={settings.smtp_host || ''} onChange={set('smtp_host')} placeholder="smtp.office365.com" /></Field>
              <Field label="SMTP port"><input className="input" value={settings.smtp_port || ''} onChange={set('smtp_port')} placeholder="587" /></Field>
              <Field label="SMTP user"><input className="input" value={settings.smtp_user || ''} onChange={set('smtp_user')} /></Field>
              <Field label={`SMTP password${settings.smtp_password_set ? ' (saved — type to replace)' : ''}`}>
                <input className="input" type="password" onChange={set('smtp_password')} placeholder="••••••••" />
              </Field>
              <Field label="From address"><input className="input" value={settings.smtp_from || ''} onChange={set('smtp_from')} placeholder="fieldsales@yourcompany.co.za" /></Field>
              <Field label="SSL/TLS">
                <label className="flex items-center gap-2 pt-2 text-sm">
                  <input type="checkbox" checked={settings.smtp_secure === '1'} onChange={set('smtp_secure')} /> Use SSL/TLS (port 465)
                </label>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.smtp_allow_invalid_cert === '1'} onChange={set('smtp_allow_invalid_cert')} />
                  Trust an internal certificate
                </label>
              </Field>
              <div className="sm:col-span-2 text-xs text-amber-600">
                Microsoft disabled Basic Auth for SMTP AUTH on most Exchange Online tenants — this will likely fail to authenticate unless your tenant has an Authentication Policy explicitly re-enabling it for this mailbox. Use the Microsoft 365 (Graph API) option above instead if you're on Exchange Online.
              </div>
            </>
          )}

          <Field label="Options" span>
            <div className="space-y-1 pt-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={(settings.email_auto_send ?? '1') === '1'} onChange={set('email_auto_send')} /> Auto-email orders on submit
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={(settings.email_confirm_customer ?? '1') === '1'} onChange={set('email_confirm_customer')} /> Also send customer a confirmation
              </label>
            </div>
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn-primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
          <input className="input w-56" type="email" placeholder="test@yourcompany.co.za" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button className="btn-secondary" onClick={sendTest} disabled={busy === 'test-email' || !testTo}>
            {busy === 'test-email' ? 'Sending…' : 'Send test email'}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-400">Quotes are emailed to customers. Order confirmation can optionally be sent to customers. If mail isn't configured (or fails), emails wait in the Integration log and can be resent later.</p>
      </Card>

      <Card title="Orders Email">
        <p className="text-sm text-slate-500 mb-4">
          Configured email addresses will appear as checkboxes when reps or managers confirm an order.
          The order PDF will be emailed to selected addresses.
        </p>
        {!ordersRecipients ? (
          <Spinner />
        ) : (
          <>
            <Table headers={['Name', 'Email', 'Description', '']}
              empty={ordersRecipients.length === 0 && 'No email recipients configured.'}>
              {ordersRecipients.map((r) => (
                <tr key={r.id} className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                  onClick={() => canEdit && setEditing(r)}>
                  <td className="td font-medium">{r.name}</td>
                  <td className="td text-slate-600">{r.email}</td>
                  <td className="td text-slate-500">{r.description || '—'}</td>
                  <td className="td text-right">
                    {canEdit && (
                      <button className="text-xs text-brand-600 hover:underline"
                        onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
                        edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {canEdit && (
              <button className="btn-primary mt-4" onClick={() => setEditing({ category: 'orders' })}>
                + Add recipient
              </button>
            )}
          </>
        )}
      </Card>

      <Card title="Technical">
        <p className="text-sm text-slate-500 mb-4">
          Configured email addresses will receive notifications when a form marked as Technical is completed in the field.
        </p>
        {!technicalRecipients ? (
          <Spinner />
        ) : (
          <>
            <Table headers={['Name', 'Email', 'Description', '']}
              empty={technicalRecipients.length === 0 && 'No email recipients configured.'}>
              {technicalRecipients.map((r) => (
                <tr key={r.id} className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                  onClick={() => canEdit && setEditing(r)}>
                  <td className="td font-medium">{r.name}</td>
                  <td className="td text-slate-600">{r.email}</td>
                  <td className="td text-slate-500">{r.description || '—'}</td>
                  <td className="td text-right">
                    {canEdit && (
                      <button className="text-xs text-brand-600 hover:underline"
                        onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
                        edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {canEdit && (
              <button className="btn-primary mt-4" onClick={() => setEditing({ category: 'technical' })}>
                + Add recipient
              </button>
            )}
          </>
        )}
      </Card>

      {editing && (
        <RecipientModal recipient={editing.id ? editing : null}
          category={editing.category}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadRecipients(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function RecipientModal({ recipient, category, onClose, onSaved, onError }) {
  const [name, setName] = useState(recipient?.name || '');
  const [email, setEmail] = useState(recipient?.email || '');
  const [description, setDescription] = useState(recipient?.description || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (!name.trim() || !email.trim()) {
      return setError('Name and email are required');
    }
    setBusy(true);
    try {
      if (recipient) {
        await api.put(`/email-recipients/${recipient.id}`, { name, email, description });
      } else {
        await api.post('/email-recipients', { name, email, description, category });
      }
      onSaved();
    } catch (e) {
      setError(e.message);
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteRecipient = async () => {
    if (!recipient) return;
    if (!confirm('Delete this recipient?')) return;
    setBusy(true);
    try {
      await api.del(`/email-recipients/${recipient.id}`);
      onSaved();
    } catch (e) {
      setError(e.message);
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={recipient ? 'Edit recipient' : `New ${category === 'technical' ? 'technical' : 'orders'} recipient`} onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        <Field label="Name *">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email *">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea className="input" rows="2" value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g., Finance department, Regional manager, etc." />
        </Field>
        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          {recipient && (
            <button className="text-red-600 hover:text-red-700 px-3 py-2 text-sm font-medium"
              onClick={deleteRecipient} disabled={busy}>
              Delete
            </button>
          )}
          <button className="btn-primary flex-1" onClick={submit} disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

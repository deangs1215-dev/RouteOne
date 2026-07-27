// Form templates (admin/manager builds them) + submitted field data.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge } from '../components/ui';
import { useAuth } from '../auth';

const FIELD_TYPES = ['heading', 'text', 'email', 'number', 'date', 'select', 'checkbox', 'photo', 'signature', 'product'];

export default function FormsAdmin() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState(null);
  const [submissions, setSubmissions] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | template
  const [viewing, setViewing] = useState(null); // submission being viewed
  const canEdit = ['admin', 'manager'].includes(user.role);

  const load = () => {
    api.get('/form-templates').then(setTemplates).catch(console.error);
    api.get('/form-submissions').then(setSubmissions).catch(console.error);
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Field forms</h1>
        {canEdit && <button className="btn-primary" onClick={() => setEditing('new')}>+ New form</button>}
      </div>

      <Card title="Form templates">
        {!templates ? <Spinner /> : (
          <Table headers={['Name', 'Category', 'Description', 'Fields', 'Submissions', 'Status']}
            empty={templates.length === 0 && 'No forms yet.'}>
            {templates.map((t) => (
              <tr key={t.id} className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                onClick={() => canEdit && setEditing(t)}>
                <td className="td font-medium">{t.name}</td>
                <td className="td">
                  <Badge color={t.category === 'technical' ? '#0ea5e9' : '#64748b'}>
                    {t.category === 'technical' ? 'Technical' : 'General'}
                  </Badge>
                </td>
                <td className="td text-slate-500">{t.description || '—'}</td>
                <td className="td text-slate-500">{t.fields.map((f) => f.label).join(', ')}</td>
                <td className="td">{t.submission_count}</td>
                <td className="td"><Badge color={t.active ? '#16a34a' : '#64748b'}>{t.active ? 'active' : 'inactive'}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Recent submissions">
        {!submissions ? <Spinner /> : (
          <Table headers={['Form', 'Customer', 'Submitted by', 'When', '']}
            empty={submissions.length === 0 && 'No submissions yet.'}>
            {submissions.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="td font-medium">{s.template_name}</td>
                <td className="td">
                  {s.customer_id
                    ? <Link className="hover:text-brand-600" to={`/customers/${s.customer_id}`}>{s.customer_name}</Link>
                    : '—'}
                </td>
                <td className="td text-slate-500">{s.user_name}</td>
                <td className="td text-slate-500">{fmtDateTime(s.created_at)}</td>
                <td className="td"><button className="text-xs text-brand-600 hover:underline" onClick={() => setViewing(s)}>view</button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <TemplateModal template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {viewing && <SubmissionModal submission={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function TemplateModal({ template, onClose, onSaved }) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [active, setActive] = useState(template?.active ?? 1);
  const [category, setCategory] = useState(template?.category || 'general');
  const [notifyEmail, setNotifyEmail] = useState(template?.notify_email || '');
  const [fields, setFields] = useState(template?.fields || [{ key: '', label: '', type: 'text', required: false }]);
  const [error, setError] = useState('');

  const setField = (i, patch) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const cleaned = fields
      .filter((f) => f.label)
      .map((f) => ({ ...f, key: f.key || slug(f.label), options: f.type === 'select' ? (f.options_raw ?? (f.options || []).join(', ')).split(',').map((o) => o.trim()).filter(Boolean) : undefined }));
    try {
      const body = { name, description, active: Number(active), category, notify_email: notifyEmail.trim(), fields: cleaned };
      if (template) await api.put(`/form-templates/${template.id}`, body);
      else await api.post('/form-templates', body);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  const remove = async () => {
    setError('');
    if (!window.confirm(`Delete "${template.name}"? This can't be undone.`)) return;
    try {
      await api.del(`/form-templates/${template.id}`);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  return (
    <Modal title={template ? `Edit ${template.name}` : 'New form'} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Form name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Status">
            <select className="input" value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="1">Active</option><option value="0">Inactive</option>
            </select>
          </Field>
          <Field label="Category">
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="general">General</option>
              <option value="technical">Technical</option>
            </select>
          </Field>
          <Field label="Description" span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Send to email address" span>
            <input type="email" className="input" placeholder="e.g. quality@bakels.co.za"
              value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} />
          </Field>
          <p className="text-xs text-slate-400 sm:col-span-2">
            {notifyEmail
              ? `Submissions of this form will be emailed to ${notifyEmail}.`
              : category === 'technical'
                ? 'No address set for this form — submissions fall back to the technical address set on Settings → Email → Technical.'
                : 'No address set — submissions of this form will not be emailed anywhere.'}
          </p>
        </div>

        <div>
          <div className="label">Fields</div>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2">
                <input className="input flex-1 min-w-[160px]" placeholder="Question / label" value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })} />
                <select className="input w-28" value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
                  {FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
                {f.type === 'select' && (
                  <input className="input w-52" placeholder="Options, comma separated"
                    value={f.options_raw ?? (f.options || []).join(', ')}
                    onChange={(e) => setField(i, { options_raw: e.target.value })} />
                )}
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                  required
                </label>
                <button type="button" className="text-slate-300 hover:text-red-500"
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn-secondary mt-2 text-xs"
            onClick={() => setFields([...fields, { key: '', label: '', type: 'text', required: false }])}>+ Add field</button>
        </div>

        <div className="flex items-center justify-between gap-2">
          {template
            ? <button type="button" className="text-xs text-red-500 hover:underline" onClick={remove}>Delete form</button>
            : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary">Save form</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function SubmissionModal({ submission, onClose }) {
  return (
    <Modal title={`${submission.template_name} — ${submission.customer_name || 'no customer'}`} onClose={onClose}>
      <div className="space-y-3">
        {submission.template_fields.map((f, i) => {
          // Headings are section dividers, not data.
          if (f.type === 'heading') {
            return (
              <div key={f.key || `h${i}`} className="pt-2">
                <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">{f.label}</h3>
                <div className="mt-1 border-b border-slate-200" />
              </div>
            );
          }
          const value = submission.data[f.key];
          const isImage = f.type === 'photo' || f.type === 'signature';
          return (
            <div key={f.key}>
              <div className="label">{f.label}</div>
              {isImage && value
                ? <img src={value} alt={f.label} className="max-h-64 rounded-lg border border-slate-200" />
                : f.type === 'checkbox'
                  ? <div className="text-sm">{value ? '✓ Yes' : '✗ No'}</div>
                  : <div className="text-sm">{value ?? <span className="text-slate-300">—</span>}</div>}
            </div>
          );
        })}
        <div className="text-xs text-slate-400">Submitted by {submission.user_name} · {fmtDateTime(submission.created_at)}</div>
      </div>
    </Modal>
  );
}

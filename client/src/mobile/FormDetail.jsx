import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import { MobileHeader } from './MobileApp';

export default function FormDetail({ base = '/mobile' }) {
  const { id } = useParams();
  const [submission, setSubmission] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/form-submissions/${id}`).then(setSubmission).catch((e) => setError(e.message));
  }, [id]);

  if (!submission) return (
    <>
      <MobileHeader title="Form" back={`${base}/customers`} />
      {error ? <div className="p-4"><ErrorNote error={error} /></div> : <Spinner />}
    </>
  );

  // Prefer the template's field definitions so we can show proper labels and
  // render each answer by its type; fall back to raw keys if a field is missing.
  const fields = submission.template_fields || [];
  const entries = fields.length
    ? fields.map((f) => ({ label: f.label || f.key, type: f.type, value: submission.data?.[f.key] }))
    : Object.entries(submission.data || {}).map(([key, value]) => ({ label: key, type: undefined, value }));

  const backTo = submission.customer_id ? `${base}/customers/${submission.customer_id}` : `${base}/customers`;

  return (
    <>
      <MobileHeader title={submission.template_name} back={backTo} />
      <div className="p-4 pb-6 space-y-4">
        <div className="card p-4 text-sm text-slate-600 space-y-1">
          <div><span className="font-semibold">Submitted:</span> {fmtDateTime(submission.created_at)}</div>
          <div><span className="font-semibold">Rep:</span> {submission.rep_name}</div>
          {submission.customer_name && <div><span className="font-semibold">Customer:</span> {submission.customer_name}</div>}
        </div>

        <div className="card p-4 space-y-4">
          {entries.map((e, i) => (
            e.type === 'heading' ? (
              <div key={i} className="pt-2 first:pt-0">
                <div className="text-sm font-bold uppercase tracking-wide text-slate-700">{e.label}</div>
                <div className="mt-1 border-b border-slate-200" />
              </div>
            ) : (
              <div key={i} className="border-b border-slate-100 last:border-b-0 pb-3 last:pb-0">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{e.label}</div>
                <div className="text-sm text-slate-800">
                  {renderAnswer(e)}
                </div>
              </div>
            )
          ))}
          {entries.length === 0 && <div className="text-sm text-slate-400">No data captured.</div>}
        </div>
      </div>
    </>
  );
}

function renderAnswer({ type, value }) {
  if (value === undefined || value === null || value === '') return <span className="text-slate-400">(empty)</span>;
  // Photos & signatures are stored as file paths (e.g. /uploads/…); data URLs may also appear.
  const isImage = type === 'photo' || type === 'signature' ||
    (typeof value === 'string' && (value.startsWith('data:image') || /\.(png|jpe?g|webp|gif)$/i.test(value)));
  if (isImage && typeof value === 'string') {
    return <img src={value} alt="" className="max-w-full h-auto rounded-lg border border-slate-200" />;
  }
  if (type === 'boolean' || typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    return <pre className="text-xs bg-slate-50 p-2 rounded overflow-auto">{JSON.stringify(value, null, 2)}</pre>;
  }
  return String(value);
}

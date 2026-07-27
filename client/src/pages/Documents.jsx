// Marketing documents (PDFs): admin/manager upload, everyone can browse.
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote } from '../components/ui';
import { useAuth } from '../auth';

export default function Documents() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState(null);
  const [uploading, setUploading] = useState(false);
  const canUpload = ['admin', 'manager'].includes(user.role);

  const load = () => api.get('/documents').then(setDocuments).catch(console.error);
  useEffect(() => {
    load();
    // Viewing this page clears the "new documents" badge in the mobile app.
    api.post('/documents/mark-viewed', {}).catch(() => {});
  }, []);

  const remove = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    try { await api.del(`/documents/${doc.id}`); load(); }
    catch (err) { window.alert(err.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Documents</h1>
        {canUpload && <button className="btn-primary" onClick={() => setUploading(true)}>+ Upload document</button>}
      </div>

      <Card title="Marketing">
        {!documents ? <Spinner /> : (
          <Table headers={['Title', 'Description', 'Uploaded by', 'Date', '']}
            empty={documents.length === 0 && 'No documents yet.'}>
            {documents.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="td font-medium">
                  <a href={d.file_path} target="_blank" rel="noreferrer" className="hover:text-brand-600">📄 {d.title}</a>
                </td>
                <td className="td text-slate-500">{d.description || '—'}</td>
                <td className="td text-slate-500">{d.uploaded_by_name || '—'}</td>
                <td className="td text-slate-500">{fmtDateTime(d.created_at)}</td>
                <td className="td">
                  {canUpload && <button className="text-xs text-red-500 hover:underline" onClick={() => remove(d)}>delete</button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {uploading && <UploadModal onClose={() => setUploading(false)} onSaved={() => { setUploading(false); load(); }} />}
    </div>
  );
}

function UploadModal({ onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== 'application/pdf') { setError('Please choose a PDF file.'); return; }
    if (f.size > 15 * 1024 * 1024) { setError('File too large — please use a PDF under 15MB.'); return; }
    setError('');
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setFile(reader.result);
    reader.readAsDataURL(f);
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    if (!file) { setError('Please choose a PDF to upload.'); return; }
    setBusy(true);
    try {
      await api.post('/documents', { title, description, file });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal title="Upload marketing document" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="Description"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="PDF file">
          <input type="file" accept="application/pdf" className="text-xs" onChange={pickFile} required />
          {fileName && <div className="mt-1 text-xs text-slate-500">{fileName}</div>}
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        </div>
      </form>
    </Modal>
  );
}

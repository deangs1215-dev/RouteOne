// Lets a rep log a potential new account while on-site: name + optional
// contact details, plus a GPS pin captured from the device. Kept local to
// RouteOne only - nothing here goes to SYSPRO.
import { useState } from 'react';
import { api } from '../api';
import { Modal, Field, ErrorNote } from './ui';
import LocationPicker from './LocationPicker';

export default function AddProspectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const [position, setPosition] = useState(null); // { lat, lng }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Business name is required');
    setBusy(true);
    setError('');
    try {
      const customer = await api.post('/customers/prospect', {
        name: name.trim(),
        contact_name: contactName || null,
        phone: phone || null,
        address: address || null,
        city: city || null,
        notes: notes || null,
        lat: position?.lat ?? null,
        lng: position?.lng ?? null
      });
      onCreated(customer);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New prospect" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        <p className="text-xs text-slate-400">
          Not yet a SYSPRO account - this is just kept in RouteOne so you can plan visits and follow up.
        </p>

        <Field label="Business name *">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Corner Bakery" required autoFocus />
        </Field>
        <Field label="Contact name">
          <input className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Address">
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address" />
        </Field>
        <Field label="City / suburb">
          <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Notes">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>

        <div>
          <label className="label">Location</label>
          <LocationPicker value={position} onChange={setPosition} />
          {position && (
            <p className="mt-2 text-sm text-emerald-700">
              📍 Location pinned ({position.lat.toFixed(5)}, {position.lng.toFixed(5)})
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add prospect'}</button>
        </div>
      </form>
    </Modal>
  );
}

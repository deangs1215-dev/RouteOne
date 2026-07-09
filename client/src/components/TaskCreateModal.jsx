import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, Field, ErrorNote, Spinner } from './ui';

const TASK_TYPES = ['Call Customer', 'Visit Customer', 'Follow Up Quote', 'Follow Up Order', 'Resolve Query', 'Collect Payment', 'Deliver Sample', 'Other'];

// Quick follow-up date options
const quickDates = () => {
  const today = new Date();
  return {
    Today: today.toISOString().slice(0, 10),
    Tomorrow: new Date(today.getTime() + 86400000).toISOString().slice(0, 10),
    '3 Days': new Date(today.getTime() + 3 * 86400000).toISOString().slice(0, 10),
    '7 Days': new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10)
  };
};

export default function TaskCreateModal({ customerId, onClose, onCreated }) {
  const [customers, setCustomers] = useState([]);
  const [selectedCustId, setSelectedCustId] = useState(customerId || '');
  const [taskType, setTaskType] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [note, setNote] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Load customer list if not pre-selected
  useEffect(() => {
    if (!customerId) {
      api.get('/customers').then(setCustomers).catch(() => {});
    }
  }, [customerId]);

  const [searchCust, setSearchCust] = useState('');
  const filtered = useMemo(() => {
    const s = searchCust.toLowerCase();
    return customers.filter((c) => c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s)).slice(0, 15);
  }, [customers, searchCust]);

  const submit = async () => {
    setError('');
    if (!selectedCustId && selectedCustId !== 0) {
      return setError('Customer is required');
    }
    if (!taskType) {
      return setError('Task type is required');
    }
    if (!followUpDate) {
      return setError('Follow-up date is required');
    }

    setBusy(true);
    try {
      await api.post('/tasks', {
        customer_id: Number(selectedCustId) || null,
        assigned_to: undefined, // auto-assigned to current user by server
        task_type: taskType,
        follow_up_date: followUpDate,
        notes: note || null
      });
      onCreated();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const dates = quickDates();

  return (
    <Modal title="New Task" onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        {/* Customer */}
        <Field label="Customer *">
          {customerId ? (
            <div className="px-3 py-2 rounded-lg bg-slate-50 text-sm font-medium text-slate-700">
              {customers.find((c) => c.id === customerId)?.name || 'Loading...'}
            </div>
          ) : selectedCustId ? (
            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 text-sm font-medium text-slate-700">
              <span>{customers.find((c) => c.id === selectedCustId)?.name}</span>
              <button
                type="button"
                onClick={() => { setSelectedCustId(''); setSearchCust(''); }}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="text"
                className="input"
                placeholder="Search by name or code..."
                value={searchCust}
                onChange={(e) => setSearchCust(e.target.value)}
                onFocus={() => setSearchCust('')}
              />
              {searchCust && filtered.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg z-10 max-h-48 overflow-y-auto">
                  {filtered.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelectedCustId(c.id);
                        setSearchCust('');
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
                    >
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-slate-400">{c.code}</div>
                    </button>
                  ))}
                </div>
              )}
              {searchCust && filtered.length === 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg z-10 px-3 py-2 text-sm text-slate-400">
                  No customers found
                </div>
              )}
            </div>
          )}
        </Field>

        {/* Task Type */}
        <Field label="Task Type *">
          <select
            className="input"
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
          >
            <option value="">Select task type...</option>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>

        {/* Follow-Up Date */}
        <Field label="Follow-Up Date *">
          {!showDatePicker ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(dates).map(([label, date]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setFollowUpDate(date)}
                    className={`py-2 rounded-lg font-medium text-sm transition ${
                      followUpDate === date
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowDatePicker(true)}
                className="w-full py-2 rounded-lg bg-slate-50 text-slate-700 font-medium text-sm hover:bg-slate-100"
              >
                📅 Pick date
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="date"
                className="input"
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowDatePicker(false)}
                className="w-full py-2 rounded-lg bg-slate-100 text-slate-700 font-medium text-sm hover:bg-slate-200"
              >
                Use quick options
              </button>
            </div>
          )}
        </Field>

        {/* Note */}
        <Field label="Note (optional)">
          <textarea
            className="input"
            rows="2"
            placeholder="e.g., Follow up on quote, discuss pricing..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {/* Buttons */}
        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button
            className="btn-secondary flex-1"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn-primary flex-1"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

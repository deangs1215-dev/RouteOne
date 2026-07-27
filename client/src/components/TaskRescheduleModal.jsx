import { useState } from 'react';
import { api, addDaysISO } from '../api';
import { Modal, Field, ErrorNote } from './ui';

// Quick follow-up date options (same set as TaskCreateModal)
const quickDates = () => ({
  Today: addDaysISO(0),
  Tomorrow: addDaysISO(1),
  '3 Days': addDaysISO(3),
  '7 Days': addDaysISO(7)
});

export default function TaskRescheduleModal({ task, onClose, onSaved }) {
  const [date, setDate] = useState(task.follow_up_date || '');
  const [pickCustom, setPickCustom] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dates = quickDates();

  const save = async () => {
    setError('');
    if (!date) return setError('Pick a new follow-up date');
    setBusy(true);
    try {
      await api.put(`/tasks/${task.id}`, { follow_up_date: date });
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Reschedule task" onClose={onClose}>
      <ErrorNote error={error} />
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-slate-700">{task.task_type}</div>
          {task.notes && <div className="mt-0.5 text-xs text-slate-400">{task.notes}</div>}
        </div>

        <Field label="New follow-up date">
          {!pickCustom ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(dates).map(([label, d]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setDate(d)}
                    className={`py-2 rounded-lg font-medium text-sm transition ${
                      date === d ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setPickCustom(true)}
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
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setPickCustom(false)}
                className="w-full py-2 rounded-lg bg-slate-100 text-slate-700 font-medium text-sm hover:bg-slate-200"
              >
                Use quick options
              </button>
            </div>
          )}
        </Field>

        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Reschedule'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

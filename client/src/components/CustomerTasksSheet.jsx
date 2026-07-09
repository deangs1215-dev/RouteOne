import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Modal, ErrorNote, Spinner } from './ui';
import TaskCreateModal from './TaskCreateModal';
import TaskRescheduleModal from './TaskRescheduleModal';

// Bottom-sheet-style list of a customer's open tasks with inline Done /
// Reschedule / add-new actions. Used from the Today call cycle so a rep can
// clear follow-ups without leaving the route.
export default function CustomerTasksSheet({ customerId, customerName, onClose, onChanged }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const [creating, setCreating] = useState(false);

  const today = new Date().toISOString().slice(0, 10);

  const load = () =>
    api.get(`/customers/${customerId}/tasks`)
      .then((rows) => setTasks(rows.filter((t) => t.status === 'open')))
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, [customerId]);

  const changed = () => { load(); onChanged?.(); };

  const markDone = async (id) => {
    setBusyId(id);
    try {
      await api.put(`/tasks/${id}`, { status: 'done' });
      changed();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Modal title={`Tasks · ${customerName}`} onClose={onClose}>
        <ErrorNote error={error} />
        {!tasks ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            {tasks.length === 0 && (
              <div className="rounded-lg bg-slate-50 py-6 text-center text-sm text-slate-400">
                No outstanding tasks.
              </div>
            )}
            {tasks.map((t) => {
              const isOverdue = t.follow_up_date < today;
              return (
                <div
                  key={t.id}
                  className={`rounded-lg border p-3 ${isOverdue ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}
                >
                  <div className="text-sm font-semibold text-slate-800">{t.task_type}</div>
                  {t.notes && <div className="mt-0.5 text-xs text-slate-500">{t.notes}</div>}
                  <div className={`mt-1 text-[11px] font-medium ${isOverdue ? 'text-red-600' : 'text-slate-400'}`}>
                    {isOverdue ? '⚠ Overdue · ' : 'Due '}{fmtDate(t.follow_up_date)}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => markDone(t.id)}
                      disabled={busyId === t.id}
                      className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      ✓ Done
                    </button>
                    <button
                      onClick={() => setRescheduling(t)}
                      className="flex-1 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                    >
                      📅 Reschedule
                    </button>
                  </div>
                </div>
              );
            })}

            <button onClick={() => setCreating(true)} className="btn-primary w-full text-sm">
              + New task
            </button>
          </div>
        )}
      </Modal>

      {rescheduling && (
        <TaskRescheduleModal
          task={rescheduling}
          onClose={() => setRescheduling(null)}
          onSaved={() => { setRescheduling(null); changed(); }}
        />
      )}

      {creating && (
        <TaskCreateModal
          customerId={customerId}
          customerName={customerName}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); changed(); }}
        />
      )}
    </>
  );
}

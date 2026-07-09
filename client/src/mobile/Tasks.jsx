import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import { MobileHeader } from './MobileApp';
import TaskCreateModal from '../components/TaskCreateModal';

const FILTERS = ['today', 'overdue', 'upcoming', 'done'];
const FILTER_LABELS = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', done: 'Done' };

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [filter, setFilter] = useState('today');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    try {
      const rows = await api.get(`/tasks?filter=${filter}`);
      setTasks(rows);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, [filter]);

  const taskColor = (taskFilter) => {
    if (taskFilter === 'today') return 'text-blue-600';
    if (taskFilter === 'overdue') return 'text-red-600';
    if (taskFilter === 'upcoming') return 'text-slate-600';
    if (taskFilter === 'done') return 'text-emerald-600';
  };

  const handleTaskDone = async (taskId) => {
    try {
      await api.put(`/tasks/${taskId}`, { status: 'done' });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <MobileHeader title="Tasks" />
      <div className="space-y-4 p-4">
        <ErrorNote error={error} />

        {/* Filter tabs */}
        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap ${
                filter === f
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}>
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {/* Create button */}
        <button onClick={() => setShowCreate(true)}
          className="btn-primary w-full">+ New Task</button>

        {/* Task list */}
        {!tasks ? <Spinner /> : tasks.length === 0 ? (
          <div className="card p-6 text-center text-sm text-slate-400">
            {filter === 'today' ? 'No tasks due today.' : filter === 'done' ? 'No completed tasks.' : 'No tasks.'}
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{t.task_type}</div>
                    {t.customer_name && (
                      <div className="text-xs text-slate-500 mt-0.5">{t.customer_name}</div>
                    )}
                    {t.notes && (
                      <div className="text-xs text-slate-400 mt-1">{t.notes}</div>
                    )}
                    <div className={`text-xs font-semibold mt-2 ${taskColor(filter)}`}>
                      {fmtDate(t.follow_up_date)}
                    </div>
                  </div>
                  {t.status === 'open' && (
                    <button onClick={() => handleTaskDone(t.id)}
                      className="flex-shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                      ✓ Done
                    </button>
                  )}
                  {t.status === 'done' && (
                    <span className="flex-shrink-0 text-xs font-semibold text-emerald-600">Done</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <TaskCreateModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}
    </>
  );
}

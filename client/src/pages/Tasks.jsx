import { useEffect, useState, useMemo } from 'react';
import { api, fmtDate } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import PageHeader from '../components/PageHeader';

const TASK_TYPES = ['Call Customer', 'Visit Customer', 'Follow Up Quote', 'Follow Up Order', 'Resolve Query', 'Collect Payment', 'Deliver Sample', 'Other'];
const STATUSES = ['open', 'done'];

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState({ rep: '', status: '', dueFrom: '', dueTo: '' });
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(new Set());

  // Load reps and tasks
  useEffect(() => {
    Promise.all([
      api.get('/users?role=rep'),
      loadTasks()
    ]).then(([reps]) => setUsers(reps)).catch(e => setError(e.message));
  }, []);

  const loadTasks = async () => {
    try {
      const rows = await api.get('/tasks/all');
      setTasks(rows);
    } catch (e) {
      setError(e.message);
    }
  };

  // Filter tasks
  const filtered = useMemo(() => {
    if (!tasks) return [];
    return tasks.filter(t => {
      if (filter.rep && t.assigned_to !== parseInt(filter.rep)) return false;
      if (filter.status && t.status !== filter.status) return false;
      if (filter.dueFrom && t.follow_up_date < filter.dueFrom) return false;
      if (filter.dueTo && t.follow_up_date > filter.dueTo) return false;
      return true;
    });
  }, [tasks, filter]);

  // Analytics
  const analytics = useMemo(() => {
    if (!tasks) return {};
    const byRep = {};
    const byType = {};
    const overdue = new Date().toISOString().slice(0, 10);

    tasks.forEach(t => {
      // By rep
      if (!byRep[t.assigned_to]) byRep[t.assigned_to] = { total: 0, done: 0, overdue: 0 };
      byRep[t.assigned_to].total++;
      if (t.status === 'done') byRep[t.assigned_to].done++;
      if (t.status === 'open' && t.follow_up_date < overdue) byRep[t.assigned_to].overdue++;

      // By type
      if (!byType[t.task_type]) byType[t.task_type] = 0;
      byType[t.task_type]++;
    });

    return { byRep, byType, overdueCount: tasks.filter(t => t.status === 'open' && t.follow_up_date < overdue).length };
  }, [tasks]);

  const handleReassign = async (taskIds, repId) => {
    try {
      await Promise.all(taskIds.map(id => api.put(`/tasks/${id}`, { assigned_to: repId })));
      setSelected(new Set());
      await loadTasks();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleBulkDone = async (taskIds) => {
    try {
      await Promise.all(taskIds.map(id => api.put(`/tasks/${id}`, { status: 'done' })));
      setSelected(new Set());
      await loadTasks();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleTaskDone = async (taskId) => {
    try {
      await api.put(`/tasks/${taskId}`, { status: 'done' });
      await loadTasks();
    } catch (e) {
      setError(e.message);
    }
  };

  const repName = (id) => users.find(u => u.id === id)?.name || 'Unknown';
  const selectedIds = Array.from(selected);

  return (
    <>
      <PageHeader title="Task Management" subtitle="Create, assign, and track tasks for your team" />
      <div className="space-y-6">
        <ErrorNote error={error} />

        {/* Quick Stats */}
        {tasks && (
          <div className="grid grid-cols-4 gap-4">
            <div className="card p-4">
              <div className="text-2xl font-bold text-brand-600">{tasks.length}</div>
              <div className="text-xs text-slate-500">Total Tasks</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-emerald-600">{tasks.filter(t => t.status === 'done').length}</div>
              <div className="text-xs text-slate-500">Completed</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-red-600">{analytics.overdueCount || 0}</div>
              <div className="text-xs text-slate-500">Overdue</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-blue-600">{((tasks.filter(t => t.status === 'done').length / tasks.length) * 100).toFixed(0)}%</div>
              <div className="text-xs text-slate-500">Completion Rate</div>
            </div>
          </div>
        )}

        {/* Filters & Actions */}
        <div className="card space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Filters</h3>
            {selectedIds.length > 0 && (
              <div className="flex gap-2">
                <select
                  className="input text-sm"
                  onChange={(e) => handleReassign(selectedIds, parseInt(e.target.value))}
                  defaultValue=""
                >
                  <option value="">Reassign to...</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <button
                  onClick={() => handleBulkDone(selectedIds)}
                  className="btn-primary text-sm px-3 py-1"
                >
                  Mark Done ({selectedIds.length})
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Rep</label>
              <select
                className="input"
                value={filter.rep}
                onChange={(e) => setFilter({ ...filter, rep: e.target.value })}
              >
                <option value="">All Reps</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Status</label>
              <select
                className="input"
                value={filter.status}
                onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              >
                <option value="">All Statuses</option>
                {STATUSES.map(s => <option key={s} value={s}>{s === 'open' ? 'Open' : 'Done'}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Due From</label>
              <input
                type="date"
                className="input"
                value={filter.dueFrom}
                onChange={(e) => setFilter({ ...filter, dueFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Due To</label>
              <input
                type="date"
                className="input"
                value={filter.dueTo}
                onChange={(e) => setFilter({ ...filter, dueTo: e.target.value })}
              />
            </div>
          </div>

          <button
            onClick={() => setShowCreate(true)}
            className="btn-primary w-full"
          >
            + Assign New Task
          </button>
        </div>

        {/* Task List */}
        {!tasks ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="card p-6 text-center text-sm text-slate-400">
            No tasks match your filters.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelected(new Set(filtered.map(t => t.id)));
                        } else {
                          setSelected(new Set());
                        }
                      }}
                      checked={selected.size === filtered.length && filtered.length > 0}
                    />
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">Customer</th>
                  <th className="px-4 py-3 text-left font-semibold">Task Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Assigned To</th>
                  <th className="px-4 py-3 text-left font-semibold">Due Date</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-left font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map(t => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={(e) => {
                          const newSelected = new Set(selected);
                          if (e.target.checked) {
                            newSelected.add(t.id);
                          } else {
                            newSelected.delete(t.id);
                          }
                          setSelected(newSelected);
                        }}
                      />
                    </td>
                    <td className="px-4 py-3">{t.customer_name}</td>
                    <td className="px-4 py-3 text-xs">{t.task_type}</td>
                    <td className="px-4 py-3 text-xs font-medium">{repName(t.assigned_to)}</td>
                    <td className="px-4 py-3 text-xs">{fmtDate(t.follow_up_date)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                        t.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                        {t.status === 'done' ? 'Done' : 'Open'}
                      </span>
                    </td>
                    <td className="px-4 py-3 space-x-2">
                      {t.status === 'open' && (
                        <button
                          onClick={() => handleTaskDone(t.id)}
                          className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                        >
                          Mark Done
                        </button>
                      )}
                      <button
                        onClick={() => {
                          // TODO: Edit task
                        }}
                        className="text-xs text-slate-600 hover:text-slate-700 font-medium"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create Task Modal */}
        {showCreate && (
          <CreateTaskModal
            users={users}
            onClose={() => setShowCreate(false)}
            onCreated={() => { setShowCreate(false); loadTasks(); }}
          />
        )}
      </div>
    </>
  );
}

function CreateTaskModal({ users, onClose, onCreated }) {
  const [customers, setCustomers] = useState([]);
  const [custId, setCustId] = useState('');
  const [repId, setRepId] = useState('');
  const [taskType, setTaskType] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/customers').then(setCustomers).catch(() => {});
  }, []);

  const submit = async () => {
    setError('');
    if (!custId) return setError('Customer is required');
    if (!repId) return setError('Rep is required');
    if (!taskType) return setError('Task type is required');
    if (!followUpDate) return setError('Follow-up date is required');

    setBusy(true);
    try {
      await api.post('/tasks', {
        customer_id: parseInt(custId),
        assigned_to: parseInt(repId),
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold">Assign New Task</h2>
        <ErrorNote error={error} />

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Customer *</label>
          <select className="input w-full" value={custId} onChange={(e) => setCustId(e.target.value)}>
            <option value="">Select customer...</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Assign To *</label>
          <select className="input w-full" value={repId} onChange={(e) => setRepId(e.target.value)}>
            <option value="">Select rep...</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Task Type *</label>
          <select className="input w-full" value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            <option value="">Select type...</option>
            {TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Follow-Up Date *</label>
          <input
            type="date"
            className="input w-full"
            value={followUpDate}
            onChange={(e) => setFollowUpDate(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Notes (optional)</label>
          <textarea
            className="input w-full"
            rows="3"
            placeholder="e.g., Follow up on quote..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex-1" onClick={submit} disabled={busy}>
            {busy ? 'Creating...' : 'Assign Task'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Modal, ErrorNote } from '../components/ui';

export default function BranchClockIn() {
  const [clockIns, setClockIns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadToday = () => {
    setLoading(true);
    api.get('/branch-clock-in/today')
      .then(setClockIns)
      .catch(() => setClockIns([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadToday(); }, []);

  const handleClockIn = async () => {
    if (!notes.trim()) {
      setError('Please add notes about why you\'re clocking in at the branch');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/branch-clock-in', { notes });
      setNotes('');
      setShowModal(false);
      loadToday();
    } catch (e) {
      setError(e.message || 'Failed to clock in');
    }
    setBusy(false);
  };

  const handleClockOut = async (id) => {
    try {
      await api.post(`/branch-clock-in/${id}/clock-out`, {});
      loadToday();
    } catch (e) {
      setError(e.message || 'Failed to clock out');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm">Branch Clock-in</h3>
        <button onClick={() => setShowModal(true)} className="btn-primary text-xs">
          ⏰ Clock in
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-slate-400">Loading...</div>
      ) : clockIns.length === 0 ? (
        <div className="text-xs text-slate-400">No clock-ins today</div>
      ) : (
        <div className="space-y-2">
          {clockIns.map((ci) => (
            <div key={ci.id} className="bg-slate-50 rounded p-2 text-xs">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <div className="font-medium">{fmtDateTime(ci.clock_in_at)}</div>
                  {ci.notes && <div className="text-slate-600 mt-1">{ci.notes}</div>}
                </div>
                {!ci.clock_out_at && (
                  <button
                    onClick={() => handleClockOut(ci.id)}
                    className="text-xs text-brand-600 hover:underline whitespace-nowrap"
                  >
                    Clock out
                  </button>
                )}
              </div>
              {ci.clock_out_at && (
                <div className="text-slate-500 text-[11px] mt-1">
                  Out: {fmtDateTime(ci.clock_out_at)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title="Clock in at branch" onClose={() => { setShowModal(false); setError(''); }}>
          <div className="space-y-3">
            <ErrorNote error={error} />
            <textarea
              className="w-full border rounded p-2 text-sm"
              placeholder="What are you handling at the branch? (e.g., stock check, admin work, training, etc.)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
            />
            <div className="flex gap-2">
              <button
                onClick={handleClockIn}
                disabled={busy}
                className="btn-primary flex-1 text-sm disabled:opacity-60"
              >
                {busy ? 'Clocking in...' : 'Clock in'}
              </button>
              <button onClick={() => setShowModal(false)} className="btn-secondary text-sm">
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Rep's own upcoming call cycle - real calendar dates, not the raw Week N
// template (see GET /route-cycles/upcoming). Reps always see their own; no
// rep picker needed here since a rep can never view anyone else's.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Spinner, VisitStatusBadge } from '../components/ui';
import { MobileHeader } from './MobileApp';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const DAY_LABEL = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri' };

export default function MyCycle() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/route-cycles/upcoming?weeks=6').then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <MobileHeader title="My call cycle" />
      <div className="space-y-4 p-4">
        {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
        {!data && !error && <Spinner />}
        {data && !data.has_cycle && (
          <div className="card p-4 text-center text-sm text-slate-500">
            No call cycle has been set up for you yet - check with your manager.
          </div>
        )}
        {data?.has_cycle && (
          <>
            <div className="text-xs text-slate-400">{data.cycle.name} · {data.cycle.cycle_weeks}-week cycle</div>
            {data.weeks.map((w) => (
              <div key={w.week_start} className="card p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Week {w.cycle_week} · {fmtDate(w.week_start)}
                </div>
                <div className="space-y-2">
                  {DAYS.map((d) => (
                    w.days[d].length > 0 && (
                      <div key={d} className="flex gap-2 text-sm">
                        <div className="w-9 shrink-0 font-medium text-slate-500">{DAY_LABEL[d]}</div>
                        <div className="flex-1 space-y-1">
                          {w.days[d].map((c) => (
                            <Link key={c.customer_id} to={`/mobile/customers/${c.customer_id}`}
                              className="flex items-center justify-between gap-2 truncate">
                              <span className="truncate">{c.name || c.code}<span className="ml-1 text-xs text-slate-400">{c.city}</span></span>
                              {c.status && <VisitStatusBadge status={c.status} />}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )
                  ))}
                  {DAYS.every((d) => w.days[d].length === 0) && (
                    <div className="text-xs text-slate-300">No stops this week</div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

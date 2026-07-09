import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtR } from '../api';
import { Card, Table, Spinner, Badge } from '../components/ui';

export default function Team() {
  const [reps, setReps] = useState(null);

  useEffect(() => { api.get('/reps').then(setReps).catch(console.error); }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Team</h1>
      <p className="text-sm text-slate-500">Open a rep to see their performance and call-cycle compliance — how many of their planned route customers they actually visited.</p>

      <Card>
        {!reps ? <Spinner /> : (
          <Table headers={['Rep', 'Territory', 'Customers', 'Target', 'Call cycle', '']} empty={reps.length === 0 && 'No reps.'}>
            {reps.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-slate-50">
                <td className="td font-medium"><Link to={`/team/${r.id}`} className="block">{r.name}</Link></td>
                <td className="td text-slate-500"><Link to={`/team/${r.id}`} className="block">{r.territory_name || '—'}</Link></td>
                <td className="td text-slate-500"><Link to={`/team/${r.id}`} className="block">{r.customers_assigned}</Link></td>
                <td className="td text-slate-500"><Link to={`/team/${r.id}`} className="block">{r.sales_target ? fmtR(r.sales_target) : '—'}</Link></td>
                <td className="td"><Link to={`/team/${r.id}`} className="block">
                  {r.has_cycle ? <Badge color="#16a34a">loaded</Badge> : <Badge color="#64748b">none</Badge>}
                </Link></td>
                <td className="td text-right"><Link to={`/team/${r.id}`} className="text-brand-600">View →</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

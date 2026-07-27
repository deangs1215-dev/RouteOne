// Simple calendar date picker modal
import { useState, useEffect } from 'react';
import { Modal } from './ui';

// value/onChange always use plain 'YYYY-MM-DD' strings, parsed and built
// manually (never via Date#toISOString or `new Date(dateString)`) - both of
// those convert through UTC, which silently shifts the date by a day in any
// timezone ahead of UTC (e.g. SAST, UTC+2) as local midnight crosses back to
// the previous day in UTC.
const parseISODate = (v) => {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  return { y, m: m - 1, d };
};

export default function DatePicker({ value, onChange, onClose, label = 'Select date' }) {
  const initial = parseISODate(value);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(initial ? initial.y : now.getFullYear(), initial ? initial.m : now.getMonth(), 1);
  });

  useEffect(() => {
    const parsed = parseISODate(value);
    if (parsed) setMonth(new Date(parsed.y, parsed.m, 1));
  }, [value]);

  const year = month.getFullYear();
  const monthNum = month.getMonth();
  const monthName = month.toLocaleString('default', { month: 'long' });

  // First day of month and number of days
  const firstDay = new Date(year, monthNum, 1).getDay();
  const daysInMonth = new Date(year, monthNum + 1, 0).getDate();

  const days = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const handleSelect = (day) => {
    if (day) {
      const iso = `${year}-${String(monthNum + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      onChange(iso);
      onClose();
    }
  };

  const prevMonth = () => setMonth(new Date(year, monthNum - 1));
  const nextMonth = () => setMonth(new Date(year, monthNum + 1));

  const selectedDate = parseISODate(value);
  const isSelectedMonth = selectedDate && selectedDate.y === year && selectedDate.m === monthNum;
  const selectedDay = selectedDate?.d;

  return (
    <Modal title={label} onClose={onClose}>
      <div className="space-y-4">
        {/* Month/year header */}
        <div className="flex items-center justify-between">
          <button onClick={prevMonth} className="px-3 py-1 text-sm font-medium hover:bg-slate-100 rounded">
            ‹
          </button>
          <div className="text-center font-semibold">
            {monthName} {year}
          </div>
          <button onClick={nextMonth} className="px-3 py-1 text-sm font-medium hover:bg-slate-100 rounded">
            ›
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-500">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {days.map((day, i) => (
            <button
              key={i}
              onClick={() => handleSelect(day)}
              disabled={day === null}
              className={`p-2 text-sm rounded font-medium transition ${
                day === null
                  ? 'text-transparent'
                  : isSelectedMonth && day === selectedDay
                  ? 'bg-brand-600 text-white'
                  : 'hover:bg-slate-100 text-slate-700'
              }`}
            >
              {day}
            </button>
          ))}
        </div>

        {/* Clear button */}
        {value && (
          <button
            onClick={() => {
              onChange(null);
              onClose();
            }}
            className="w-full py-2 text-sm text-red-600 hover:bg-red-50 rounded"
          >
            Clear date
          </button>
        )}
      </div>
    </Modal>
  );
}

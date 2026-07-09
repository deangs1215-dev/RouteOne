// Simple calendar date picker modal
import { useState, useEffect } from 'react';
import { Modal } from './ui';

export default function DatePicker({ value, onChange, onClose, label = 'Select date' }) {
  const [month, setMonth] = useState(value ? new Date(value) : new Date());

  useEffect(() => {
    if (value) setMonth(new Date(value));
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
      const selected = new Date(year, monthNum, day);
      const iso = selected.toISOString().slice(0, 10);
      onChange(iso);
      onClose();
    }
  };

  const prevMonth = () => setMonth(new Date(year, monthNum - 1));
  const nextMonth = () => setMonth(new Date(year, monthNum + 1));

  const selectedDate = value ? new Date(value) : null;
  const isSelectedMonth = selectedDate && selectedDate.getFullYear() === year && selectedDate.getMonth() === monthNum;
  const selectedDay = selectedDate?.getDate();

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

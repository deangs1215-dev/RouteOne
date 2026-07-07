// Shows a clear warning when the API server can't be reached, instead of
// leaving data pages spinning silently. Only fires when the device has a
// network connection (true "server is down" case) - genuine offline on the
// mobile app is handled by its own offline banner.
import { useEffect, useState } from 'react';

export default function ConnectionBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    const onErr = () => { if (navigator.onLine) setDown(true); };
    const onOk = () => setDown(false);
    window.addEventListener('fsp-neterror', onErr);
    window.addEventListener('fsp-netok', onOk);
    return () => {
      window.removeEventListener('fsp-neterror', onErr);
      window.removeEventListener('fsp-netok', onOk);
    };
  }, []);

  if (!down) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white shadow">
      <span>⚠ Can't reach the server. Make sure it's running (Start Field Sales.cmd), then</span>
      <button className="font-semibold underline" onClick={() => window.location.reload()}>reload</button>
    </div>
  );
}

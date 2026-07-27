import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, downloadFile } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function OrderDetail({ base = '/mobile' }) {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get(`/orders/${id}`).then(setOrder).catch((e) => setError(e.message));
  }, [id]);

  const download = async () => {
    setDownloading(true);
    setError('');
    try {
      await downloadFile(`/orders/${id}/pdf`, `Order-${order.number}.pdf`);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  if (!order) return (
    <>
      <MobileHeader title="Order" back={`${base}/customers`} />
      {error ? <div className="p-4"><ErrorNote error={error} /></div> : <Spinner />}
    </>
  );

  const backTo = order.customer_id ? `${base}/customers/${order.customer_id}` : `${base}/customers`;

  // The /orders/:id endpoint embeds items and flattens customer fields onto the order.
  const customer = {
    name: order.customer_name,
    address: order.address,
    city: order.city,
    warehouse_code: order.warehouse_code,
    warehouse_name: order.warehouse_name
  };

  return (
    <>
      <MobileHeader title={order.number} back={backTo} />
      <div className="p-4 pb-6 space-y-4">
        <ErrorNote error={error} />
        <button className="btn-secondary w-full py-2.5" onClick={download} disabled={downloading}>
          {downloading ? 'Downloading…' : '⬇ Download order'}
        </button>
        <div className="card p-4">
          <OrderSummary
            order={order}
            items={order.items || []}
            customer={customer}
            type="order"
            showSignature={false}
          />
        </div>
      </div>
    </>
  );
}

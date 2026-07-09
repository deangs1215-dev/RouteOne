import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function OrderDetail() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/orders/${id}`).then(setOrder).catch((e) => setError(e.message));
  }, [id]);

  if (!order) return (
    <>
      <MobileHeader title="Order" back="/mobile/customers" />
      {error ? <div className="p-4"><ErrorNote error={error} /></div> : <Spinner />}
    </>
  );

  const backTo = order.customer_id ? `/mobile/customers/${order.customer_id}` : '/mobile/customers';

  // The /orders/:id endpoint embeds items and flattens customer fields onto the order.
  const customer = {
    name: order.customer_name,
    address: order.address,
    city: order.city
  };

  return (
    <>
      <MobileHeader title={order.number} back={backTo} />
      <div className="p-4 pb-6 space-y-4">
        <ErrorNote error={error} />
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

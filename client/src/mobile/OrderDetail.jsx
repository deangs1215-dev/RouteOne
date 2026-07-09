import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [items, setItems] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const o = await api.get(`/orders/${id}`);
        setOrder(o);
        setCustomer(o.customer);

        // Fetch order items
        const its = await api.get(`/orders/${id}/items`);
        setItems(its);
      } catch (e) {
        setError(e.message);
      }
    };
    load();
  }, [id]);

  if (!order || !items) return <><MobileHeader title="Order" back="/mobile/customers" /><Spinner /></>;

  return (
    <>
      <MobileHeader title={order.number} back="/mobile/customers" />
      <div className="p-4 pb-6 space-y-4">
        <ErrorNote error={error} />
        {order && items && customer && (
          <OrderSummary
            order={order}
            items={items}
            customer={customer}
            type="order"
            showSignature={false}
          />
        )}
      </div>
    </>
  );
}

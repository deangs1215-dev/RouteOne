import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function QuoteDetail() {
  const { id } = useParams();
  const [quote, setQuote] = useState(null);
  const [items, setItems] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const q = await api.get(`/quotes/${id}`);
        setQuote(q);
        setCustomer(q.customer);

        // Fetch quote items
        const its = await api.get(`/quotes/${id}/items`);
        setItems(its);
      } catch (e) {
        setError(e.message);
      }
    };
    load();
  }, [id]);

  if (!quote || !items) return <><MobileHeader title="Quote" back="/mobile/customers" /><Spinner /></>;

  return (
    <>
      <MobileHeader title={quote.number} back="/mobile/customers" />
      <div className="p-4 pb-6 space-y-4">
        <ErrorNote error={error} />
        {quote && items && customer && (
          <OrderSummary
            order={quote}
            items={items}
            customer={customer}
            type="quote"
            showSignature={false}
          />
        )}
      </div>
    </>
  );
}

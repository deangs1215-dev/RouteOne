import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function QuoteDetail() {
  const { id } = useParams();
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/quotes/${id}`).then(setQuote).catch((e) => setError(e.message));
  }, [id]);

  if (!quote) return (
    <>
      <MobileHeader title="Quote" back="/mobile/customers" />
      {error ? <div className="p-4"><ErrorNote error={error} /></div> : <Spinner />}
    </>
  );

  const backTo = quote.customer_id ? `/mobile/customers/${quote.customer_id}` : '/mobile/customers';

  // The /quotes/:id endpoint embeds items and flattens customer fields onto the quote.
  const customer = {
    name: quote.customer_name,
    address: quote.address,
    city: quote.city
  };

  return (
    <>
      <MobileHeader title={quote.number} back={backTo} />
      <div className="p-4 pb-6 space-y-4">
        <ErrorNote error={error} />
        <div className="card p-4">
          <OrderSummary
            order={quote}
            items={quote.items || []}
            customer={customer}
            type="quote"
            showSignature={false}
          />
        </div>
      </div>
    </>
  );
}

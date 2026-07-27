import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, downloadFile } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { MobileHeader } from './MobileApp';

export default function QuoteDetail({ base = '/mobile' }) {
  const { id } = useParams();
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get(`/quotes/${id}`).then(setQuote).catch((e) => setError(e.message));
  }, [id]);

  const download = async () => {
    setDownloading(true);
    setError('');
    try {
      await downloadFile(`/quotes/${id}/pdf`, `Quotation-${quote.number}.pdf`);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  if (!quote) return (
    <>
      <MobileHeader title="Quote" back={`${base}/customers`} />
      {error ? <div className="p-4"><ErrorNote error={error} /></div> : <Spinner />}
    </>
  );

  const backTo = quote.customer_id ? `${base}/customers/${quote.customer_id}` : `${base}/customers`;

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
        <button className="btn-secondary w-full py-2.5" onClick={download} disabled={downloading}>
          {downloading ? 'Downloading…' : '⬇ Download quote'}
        </button>
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

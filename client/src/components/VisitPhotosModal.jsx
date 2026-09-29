import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, Spinner, ErrorNote } from './ui';

export default function VisitPhotosModal({ visitId, visitCustomerName, onClose }) {
  const [photos, setPhotos] = useState(null);
  const [error, setError] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState(null);

  useEffect(() => {
    if (!visitId) return;
    api.get(`/visits/${visitId}/photos`)
      .then(setPhotos)
      .catch((err) => setError(err.message));
  }, [visitId]);

  if (!photos) {
    return (
      <Modal title={`Photos — ${visitCustomerName}`} onClose={onClose}>
        <div className="flex justify-center py-8">
          {error ? <ErrorNote error={error} /> : <Spinner />}
        </div>
      </Modal>
    );
  }

  if (photos.length === 0) {
    return (
      <Modal title={`Photos — ${visitCustomerName}`} onClose={onClose}>
        <div className="py-8 text-center text-slate-400">
          No photos attached to this visit.
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Modal title={`Photos — ${visitCustomerName}`} onClose={onClose} wide>
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
          {photos.map((photo) => (
            <button
              key={photo.id}
              onClick={() => setSelectedPhoto(photo)}
              className="relative overflow-hidden rounded-lg border border-slate-200 hover:border-brand-400 hover:shadow-md transition"
            >
              <img
                src={photo.path}
                alt="Visit photo"
                className="h-24 w-24 object-cover hover:scale-105 transition"
              />
            </button>
          ))}
        </div>
      </Modal>

      {selectedPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setSelectedPhoto(null)}
              className="absolute -right-10 -top-10 text-white hover:text-slate-200 text-2xl font-bold"
            >
              ✕
            </button>
            <img
              src={selectedPhoto.path}
              alt="Visit photo full size"
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            />
            {selectedPhoto.caption && (
              <div className="mt-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100">
                {selectedPhoto.caption}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

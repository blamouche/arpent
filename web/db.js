// Stockage local (IndexedDB) :
// - sequences : { id, name, createdAt, uploadSetId, uploadInstance, uploadCompleted }
// - photos    : métadonnées { id, sequenceId, fileName, latitude, longitude, altitude, accuracy,
//               heading, capturedAt, uploaded, fileDeleted }
// - blobs     : { id (= id photo), jpeg?, thumb }
// Les métadonnées restent légères ; les images ne sont lues qu'à la demande.
// Le mode démo utilise une base séparée.

import { DEMO } from './sensors.js';

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DEMO ? 'arpent-demo' : 'arpent', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('sequences', { keyPath: 'id' });
      db.createObjectStore('photos', { keyPath: 'id' }).createIndex('sequenceId', 'sequenceId');
      db.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function run(stores, mode, fn) {
  const db = await open();
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const result = await fn(tx);
  await done;
  return result;
}

export const listSequences = () =>
  run(['sequences'], 'readonly', (tx) => req(tx.objectStore('sequences').getAll()))
    .then((all) => all.sort((a, b) => b.createdAt - a.createdAt));

export const getSequence = (id) =>
  run(['sequences'], 'readonly', (tx) => req(tx.objectStore('sequences').get(id)));

export const putSequence = (seq) =>
  run(['sequences'], 'readwrite', (tx) => req(tx.objectStore('sequences').put(seq)));

export const allPhotos = () =>
  run(['photos'], 'readonly', (tx) => req(tx.objectStore('photos').getAll()));

export const photosOf = (sequenceId) =>
  run(['photos'], 'readonly', (tx) => req(tx.objectStore('photos').index('sequenceId').getAll(sequenceId)))
    .then((all) => all.sort((a, b) => a.capturedAt - b.capturedAt));

export const putPhoto = (photo) =>
  run(['photos'], 'readwrite', (tx) => req(tx.objectStore('photos').put(photo)));

export const addPhoto = (photo, jpeg, thumb) =>
  run(['photos', 'blobs'], 'readwrite', (tx) => {
    tx.objectStore('photos').put(photo);
    return req(tx.objectStore('blobs').put({ id: photo.id, jpeg, thumb }));
  });

export const getBlobs = (id) =>
  run(['blobs'], 'readonly', (tx) => req(tx.objectStore('blobs').get(id)));

/** Supprime le JPEG d'une photo envoyée mais garde la vignette et l'historique. */
export const dropJpeg = (photo) =>
  run(['photos', 'blobs'], 'readwrite', async (tx) => {
    const blobs = tx.objectStore('blobs');
    const b = await req(blobs.get(photo.id));
    if (b) blobs.put({ id: b.id, thumb: b.thumb });
    return req(tx.objectStore('photos').put({ ...photo, fileDeleted: true }));
  });

export const deletePhoto = (id) =>
  run(['photos', 'blobs'], 'readwrite', (tx) => {
    tx.objectStore('photos').delete(id);
    return req(tx.objectStore('blobs').delete(id));
  });

export const deleteSequence = (id) =>
  run(['sequences', 'photos', 'blobs'], 'readwrite', async (tx) => {
    const ids = await req(tx.objectStore('photos').index('sequenceId').getAllKeys(id));
    for (const pid of ids) {
      tx.objectStore('photos').delete(pid);
      tx.objectStore('blobs').delete(pid);
    }
    return req(tx.objectStore('sequences').delete(id));
  });

// Données de démo : une vraie séquence publiée sur Panoramax (photos iPhone, Paris centre, 2017),
// téléchargée au premier lancement du mode démo et rangée dans la base de démo.
// Licence CC-BY-SA 4.0 : l'auteur et la source sont affichés dans le détail de la séquence.
// Rien n'est copié dans ce dépôt : les images viennent de l'instance, à la demande.

import * as db from './db.js';

const INSTANCE = 'https://panoramax.openstreetmap.fr';
const COLLECTION = 'ccf52904-a232-4a57-8e30-1174e920b4df';
const SEQUENCE_ID = 'demo-panoramax';
const SEEDED_KEY = 'arpent.demoSeeded';
const EVERY = 2; // une photo sur deux : 14 photos, ~5 Mo

let running = null;

export const progress = { done: 0, total: 0, error: null };

export function isSeeded() {
  try { return localStorage.getItem(SEEDED_KEY) === '1'; } catch { return true; }
}

function markSeeded(on) {
  try { on ? localStorage.setItem(SEEDED_KEY, '1') : localStorage.removeItem(SEEDED_KEY); } catch { /* stockage indisponible */ }
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Panoramax indisponible (${r.status}).`);
  return r.json();
}

async function getBlob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Photo indisponible (${r.status}).`);
  return r.blob();
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function fileName(d) {
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}.jpg`;
}

/** Télécharge la séquence de démo une seule fois (appel répétable sans effet). */
export function seedDemo(onProgress = () => {}) {
  if (isSeeded()) return Promise.resolve(false);
  running ??= (async () => {
    progress.error = null;
    const [collection, items] = await Promise.all([
      getJSON(`${INSTANCE}/api/collections/${COLLECTION}`),
      getJSON(`${INSTANCE}/api/collections/${COLLECTION}/items?limit=100`),
    ]);
    const features = items.features
      .sort((a, b) => a.properties['geovisio:rank_in_collection'] - b.properties['geovisio:rank_in_collection'])
      .filter((_, i) => i % EVERY === 0);
    progress.total = features.length;
    progress.done = 0;
    onProgress();

    // Photos téléchargées 4 par 4.
    const photos = new Array(features.length);
    let next = 0;
    const worker = async () => {
      while (next < features.length) {
        const i = next++;
        const f = features[i];
        const [jpeg, thumb] = await Promise.all([getBlob(f.assets.sd.href), getBlob(f.assets.thumb.href)]);
        const date = new Date(f.properties.datetime);
        photos[i] = {
          meta: {
            id: `demo-${f.id}`,
            sequenceId: SEQUENCE_ID,
            fileName: fileName(date),
            latitude: f.geometry.coordinates[1],
            longitude: f.geometry.coordinates[0],
            altitude: null,
            accuracy: f.properties['quality:horizontal_accuracy'] ?? 5,
            heading: f.properties['view:azimuth'] ?? null,
            capturedAt: date.getTime(),
            uploaded: i < features.length / 2, // la moitié « déjà envoyée », pour montrer les deux états
            fileDeleted: false,
          },
          jpeg,
          thumb,
        };
        progress.done += 1;
        onProgress();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    const first = new Date(features[0].properties.datetime);
    await db.putSequence({
      id: SEQUENCE_ID,
      name: `Démo · Paris, ${first.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      createdAt: Date.now(),
      uploadSetId: null,
      uploadInstance: null,
      uploadCompleted: false,
      source: {
        author: collection.providers?.map((p) => p.name).join(', ') || 'contributeur Panoramax',
        license: (collection.license || 'CC-BY-SA-4.0').replace(/^CC-/, 'CC ').replace(/-(\d)/, ' $1'), // « CC BY-SA 4.0 »
        licenseURL: collection.links?.find((l) => l.rel === 'license')?.href ?? 'https://creativecommons.org/licenses/by-sa/4.0/',
        url: `${INSTANCE}/?pic=${features[0].id}&focus=pic`,
      },
    });
    for (const p of photos) await db.addPhoto(p.meta, p.jpeg, p.thumb);
    markSeeded(true);
    return true;
  })().catch((e) => {
    progress.error = e.message || 'Téléchargement impossible.';
    throw e;
  }).finally(() => {
    running = null;
  });
  return running;
}

/** Efface toutes les séquences de démo ; la séquence Panoramax sera retéléchargée. */
export async function resetDemo() {
  for (const seq of await db.listSequences()) await db.deleteSequence(seq.id);
  markSeeded(false);
}

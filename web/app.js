// Arpent Web : interface (4 écrans), réglages, connexion et envoi.
import * as db from './db.js';
import { buildExifSegment, withExif } from './exif.js';
import * as demoData from './demo-data.js';
import { Client, NotLoggedIn, SimulatedClient, normalizeInstance, sequencePageURL } from './panoramax.js';
import {
  DEMO, LocationService, CompassService, CameraService, distance, keepAwake, pitchLabel, wakeState, requestCompassPermission, setMode,
} from './sensors.js';

const app = document.getElementById('app');
// Version publiée, à changer avec le nom du cache dans sw.js : affichée dans le diagnostic et
// les réglages, pour vérifier qu'un téléphone a bien chargé la dernière version.
const APP_VERSION = 'v29';

// ---------- Outils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};

const uuid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 5000);
}

const pad = (n) => String(n).padStart(2, '0');
function fileName(d) {
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, '0')}.jpg`;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

// ---------- Réglages ----------

const DEFAULTS = {
  instance: 'https://panoramax.openstreetmap.fr',
  interval: 2,        // secondes
  minDistance: 4,     // mètres
  maxAccuracy: 20,    // mètres
  tiltWarning: true,  // signaler les photos trop inclinées (pieds, ciel)
  maxPitchUp: 15,     // degrés au-dessus de l'horizon
  maxPitchDown: 15,   // degrés sous l'horizon
  skipTiltedAuto: true, // mode auto : ne pas prendre les photos trop inclinées
  keepScreenOn: true, // écran toujours allumé pendant la prise de vue
  walkCalibration: false, // caler la boussole sur la direction de marche (caméra dans le sens de la marche)
  autoOnNewSequence: false, // démarrer la capture auto dès la création d'une séquence
  deleteAfterUpload: true, // libère la place une fois la séquence validée par Panoramax
  privateUpload: false, // envoi privé (owner-only) pour tester sans publier
};

// Version 2 : suppression après envoi activée par défaut, y compris sur les appareils
// qui avaient déjà enregistré leurs réglages (l'option reste décochable).
// Version 4 : seuils d'inclinaison à 15° ; les anciennes valeurs par défaut (30°, puis 10°)
// sont remplacées, une valeur modifiée à la main est gardée.
const SETTINGS_VERSION = 4;
const storedSettings = store.get('arpent.settings', {});
if ((storedSettings.version ?? 1) < 2) storedSettings.deleteAfterUpload = true;
if ((storedSettings.version ?? 1) < 4) {
  for (const key of ['maxPitchUp', 'maxPitchDown']) if ([30, 10].includes(storedSettings[key])) delete storedSettings[key];
}

const settings = {
  ...DEFAULTS,
  ...storedSettings,
  version: SETTINGS_VERSION,
  save() {
    const { save, ...values } = this;
    store.set('arpent.settings', values);
  },
};

/** 'sky', 'ground' ou null : la photo dépasse-t-elle l'inclinaison autorisée dans les réglages ? */
function tiltOf(pitch) {
  if (!settings.tiltWarning || pitch == null) return null;
  if (pitch > settings.maxPitchUp) return 'sky';
  if (pitch < -settings.maxPitchDown) return 'ground';
  return null;
}
const TILT_TEXT = { sky: 'trop vers le ciel', ground: 'trop vers le sol' };

// ---------- Connexion (jeton « réclamé ») ----------

const auth = {
  get current() {
    const a = store.get('arpent.auth', null);
    return a && a.instance === settings.instance ? a : null; // jeton lié à une instance
  },
  get pending() { return store.get('arpent.pendingAuth', null); },

  async login() {
    const client = new Client(settings.instance);
    const { jwt, claimURL } = await client.generateToken('Arpent Web');
    store.set('arpent.pendingAuth', { jwt, instance: settings.instance });
    const url = new URL(claimURL);
    url.searchParams.set('next_url', `${location.origin}${location.pathname}${location.search}#/settings`);
    location.href = url.toString();
  },

  /** Au retour du site de l'instance (redirection ou retour manuel) : le jeton a-t-il été réclamé ? */
  async checkPending({ silent = true } = {}) {
    const p = this.pending;
    if (!p) return;
    try {
      const me = await new Client(p.instance, p.jwt).me();
      store.set('arpent.auth', { instance: p.instance, jwt: p.jwt, userName: me.name });
      store.set('arpent.pendingAuth', null);
      toast(`Connecté à Panoramax : ${me.name}`);
      refresh();
    } catch (e) {
      if (!silent) {
        toast(e.status === 401 || e.status === 403
          ? 'Connexion non finalisée : connectez-vous sur la page Panoramax puis réessayez.'
          : e.message);
      }
    }
  },

  logout() {
    store.set('arpent.auth', null);
    store.set('arpent.pendingAuth', null);
  },
};

// ---------- Envoi (reprenable) ----------

// id séquence → état de l'envoi, affiché en direct (panneau, ligne de liste, vignettes).
// phase : queued (en file), prepare, files, complete, puis done, error ou stopped.
const uploads = new Map();
const ACTIVE = new Set(['queued', 'prepare', 'files', 'complete']);
const isActive = (u) => !!u && ACTIVE.has(u.phase);
const anyActive = () => [...uploads.values()].some(isActive);

function newUpload(phase, total = 0) {
  return {
    phase, total, sent: 0, ids: new Set(), sentIds: new Set(), current: null, currentSize: 0, fileFraction: 0,
    bytesTotal: 0, bytesDone: 0, freed: 0, startedAt: Date.now(), filesStartedAt: 0, endedAt: 0,
    host: '', private: false, failedPhase: null, error: null, controller: new AbortController(),
  };
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const mo = (bytes) => `${(bytes / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: bytes < 1e7 ? 1 : 0 })} Mo`;
function duration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${pad(s % 60)}`;
}
const sentBytes = (u) => u.bytesDone + u.fileFraction * u.currentSize;

async function sendSequence(id, client, u) {
  const seq = await db.getSequence(id);
  const photos = await db.photosOf(id);
  const pending = photos.filter((p) => !p.uploaded);
  const visibility = settings.privateUpload ? 'owner-only' : null;
  Object.assign(u, {
    phase: 'prepare', total: pending.length, sent: 0, ids: new Set(pending.map((p) => p.id)), sentIds: new Set(),
    host: DEMO ? '' : new URL(client.base).host, private: !!visibility,
  });
  showProgress();

  // Toutes les photos déjà parties mais séquence pas finalisée (coupure pendant la finalisation).
  if (!pending.length) {
    if (!seq.uploadSetId || seq.uploadCompleted) return;
    u.phase = 'complete';
    showProgress();
    await client.completeUploadSet(seq.uploadSetId);
    await db.putSequence({ ...seq, uploadCompleted: true });
    await freeSpace(id, u);
    return;
  }

  const files = new Map();
  for (const p of pending) files.set(p.id, (await db.getBlobs(p.id))?.jpeg ?? null);
  u.bytesTotal = [...files.values()].reduce((sum, b) => sum + (b?.size ?? 0), 0);
  u.bytesDone = 0;

  // Nouvel upload set si aucun, si l'instance ou la visibilité a changé, ou si le précédent est terminé.
  if (!seq.uploadSetId || seq.uploadInstance !== client.base || seq.uploadCompleted
      || (seq.uploadVisibility ?? null) !== visibility) {
    const set = await client.createUploadSet(seq.name, pending.length, visibility);
    Object.assign(seq, { uploadSetId: set.id, uploadInstance: client.base, uploadCompleted: false, uploadVisibility: visibility });
    await db.putSequence(seq);
  }
  u.controller.signal.throwIfAborted();

  u.phase = 'files';
  u.filesStartedAt = Date.now();
  for (const photo of pending) {
    const jpeg = files.get(photo.id);
    Object.assign(u, { current: photo.id, currentSize: jpeg?.size ?? 0, fileFraction: 0 });
    showProgress();
    if (jpeg) {
      await client.uploadFile(seq.uploadSetId, jpeg, photo.fileName, {
        signal: u.controller.signal,
        onProgress: (f) => { u.fileFraction = f; showProgress(); },
      });
      await db.putPhoto({ ...photo, uploaded: true });
      u.bytesDone += jpeg.size;
    }
    u.sent += 1;
    u.sentIds.add(photo.id);
    Object.assign(u, { current: null, currentSize: 0, fileFraction: 0 });
  }

  u.phase = 'complete';
  showProgress();
  await client.completeUploadSet(seq.uploadSetId);
  await db.putSequence({ ...seq, uploadCompleted: true });
  await freeSpace(id, u);
}

/**
 * Réglage « Supprimer les photos du téléphone après envoi » : une fois la séquence validée,
 * on efface les JPEG pleine taille des photos envoyées ; vignette, position et cap restent.
 */
async function freeSpace(id, u) {
  if (!settings.deleteAfterUpload) return;
  for (const p of await db.photosOf(id)) {
    if (!p.uploaded || p.fileDeleted) continue;
    u.freed += (await db.getBlobs(p.id))?.jpeg?.size ?? 0;
    await db.dropJpeg(p);
  }
}

/** Renvoie false en cas d'échec ou d'arrêt. */
async function uploadSequence(id) {
  const prev = uploads.get(id);
  if (isActive(prev) && prev.phase !== 'queued') return true;
  let client;
  if (DEMO) {
    client = new SimulatedClient(); // démo : déroulé simulé, aucune photo ne part sur Panoramax
  } else {
    const a = auth.current;
    if (!a) {
      uploads.delete(id);
      paintUploads();
      toast(new NotLoggedIn().message);
      return false;
    }
    client = new Client(a.instance, a.jwt);
  }
  const u = newUpload('prepare');
  uploads.set(id, u);
  showProgress();
  keepAwake(true); // l'écran qui s'éteint suspendrait l'envoi
  try {
    try {
      await sendSequence(id, client, u);
    } catch (e) {
      if (e.status !== 404) throw e;
      // Upload set supprimé côté serveur : on repart d'un nouveau, une seule fois.
      const seq = await db.getSequence(id);
      await db.putSequence({ ...seq, uploadSetId: null });
      await sendSequence(id, client, u);
    }
    u.phase = 'done';
    return true;
  } catch (e) {
    u.failedPhase = u.phase;
    if (e.name === 'AbortError') {
      u.phase = 'stopped';
    } else {
      u.phase = 'error';
      u.error = e.status === 401 ? 'Session Panoramax expirée : reconnectez-vous dans les réglages.' : e.message;
      toast(u.error);
    }
    return false;
  } finally {
    u.endedAt = Date.now();
    Object.assign(u, { current: null, fileFraction: 0 });
    if (!anyActive() && !location.hash.startsWith('#/capture/')) keepAwake(false);
    refresh();
  }
}

/** Envoie les séquences l'une après l'autre ; les suivantes s'affichent « en attente ». */
async function uploadAll(entries) {
  for (const { id, pending } of entries) if (!isActive(uploads.get(id))) uploads.set(id, newUpload('queued', pending));
  paintUploads();
  for (const { id } of entries) if (!(await uploadSequence(id))) break;
  for (const { id } of entries) if (uploads.get(id)?.phase === 'queued') uploads.delete(id);
  refresh();
}

// ----- Affichage de l'avancement -----

const STEP_PHASES = ['prepare', 'files', 'complete'];
const UPLOAD_TITLES = {
  queued: 'En attente', prepare: 'Envoi en cours', files: 'Envoi en cours', complete: 'Envoi en cours',
  done: 'Envoi terminé', error: 'Envoi interrompu', stopped: 'Envoi arrêté',
};

/** État d'une étape : done, active, pending, error ou stopped. */
function stepState(u, i) {
  if (u.phase === 'done') return 'done';
  if (u.phase === 'error' || u.phase === 'stopped') {
    const f = STEP_PHASES.indexOf(u.failedPhase);
    return i < f ? 'done' : i === f ? u.phase : 'pending';
  }
  const p = STEP_PHASES.indexOf(u.phase);
  return i < p ? 'done' : i === p ? 'active' : 'pending';
}

function stepDetail(u, i, state) {
  if (i === 0) {
    if (state === 'active') return DEMO ? 'Simulation : rien ne part sur Panoramax' : `Connexion à ${u.host}…`;
    if (state === 'done') return DEMO ? 'Simulation : rien ne part sur Panoramax' : `${u.host}${u.private ? ' · envoi privé' : ''}`;
    return '';
  }
  if (i === 1) {
    if (state === 'pending') return u.total ? plural(u.total, 'photo') : '';
    return `${u.sent} / ${u.total}`;
  }
  if (state === 'active') return 'Validation de la séquence…';
  if (state === 'done') return DEMO ? 'Simulée' : 'Séquence reçue, traitement en cours sur Panoramax';
  return '';
}

/** Avancement global 0…1 (au poids des fichiers). */
function uploadFraction(u) {
  if (u.phase === 'done' || u.phase === 'complete') return 1;
  if (!u.total) return 0;
  if (u.bytesTotal) return sentBytes(u) / u.bytesTotal;
  return (u.sent + u.fileFraction) / u.total;
}

const UPLOAD_PANEL = `
  <div class="up-head">
    <p class="up-title" aria-live="polite"></p>
    <button class="secondary up-stop" type="button">Arrêter</button>
  </div>
  <p class="up-count"></p>
  <div class="up-bar" role="progressbar" aria-label="Avancement de l’envoi" aria-valuemin="0" aria-valuemax="100"><span></span></div>
  <p class="up-sub"></p>
  <p class="up-error error"></p>
  <ol class="up-steps">${['Préparation', 'Envoi des photos', 'Finalisation'].map((label) => `
    <li><span class="up-icon" aria-hidden="true"></span><span class="up-label">${label}</span><span class="up-detail"></span></li>`).join('')}
  </ol>`;

function paintPanel(el, u) {
  el.hidden = !u;
  if (!u) return;
  if (!el.firstElementChild) {
    el.innerHTML = UPLOAD_PANEL;
    el.querySelector('.up-stop').onclick = () => uploads.get(el.dataset.upload)?.controller.abort();
  }
  const q = (s) => el.querySelector(s);
  const remaining = u.total - u.sent;
  const fraction = uploadFraction(u);
  el.dataset.phase = u.phase;
  q('.up-title').textContent = `${UPLOAD_TITLES[u.phase]}${DEMO ? ' (simulé)' : ''}`;
  q('.up-stop').hidden = !(u.phase === 'prepare' || u.phase === 'files');
  q('.up-error').hidden = u.phase !== 'error';
  q('.up-error').textContent = u.error ?? '';

  let count;
  if (u.phase === 'queued') count = 'Démarre après la séquence en cours.';
  else if (u.phase === 'done') count = u.total ? `${plural(u.total, 'photo')} envoyée${u.total > 1 ? 's' : ''} en ${duration((u.endedAt - u.startedAt) / 1000)}` : 'Séquence finalisée';
  else if (u.phase === 'complete') count = 'Toutes les photos sont parties.';
  else if (u.phase === 'prepare' && !u.total) count = 'Préparation…';
  else count = `<b>${remaining}</b> photo${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''} sur ${u.total}`;
  q('.up-count').innerHTML = count;

  const bar = q('.up-bar');
  bar.style.setProperty('--p', fraction.toFixed(4));
  bar.setAttribute('aria-valuenow', Math.round(fraction * 100));
  bar.classList.toggle('busy', u.phase === 'prepare' || u.phase === 'complete');

  let sub = '';
  if (u.phase === 'files' && u.bytesTotal) {
    sub = `${mo(sentBytes(u))} sur ${mo(u.bytesTotal)}`;
    const elapsed = (Date.now() - u.filesStartedAt) / 1000;
    const rate = sentBytes(u) / elapsed;
    if (elapsed > 1.5 && rate > 0) sub += ` · ${mo(rate)}/s · encore ≈ ${duration((u.bytesTotal - sentBytes(u)) / rate)}`;
  } else if (u.phase === 'done' && u.bytesTotal) {
    sub = `${mo(u.bytesTotal)} envoyés${u.freed ? ` · ${mo(u.freed)} libérés sur le téléphone` : ''}`;
  } else if (u.phase === 'done' && u.freed) {
    sub = `${mo(u.freed)} libérés sur le téléphone`;
  } else if (u.phase === 'stopped') {
    sub = 'Les photos déjà envoyées sont conservées : l’envoi repartira de là où il s’est arrêté.';
  }
  q('.up-sub').textContent = sub;

  el.querySelectorAll('.up-steps li').forEach((li, i) => {
    const state = stepState(u, i);
    li.dataset.state = state;
    li.querySelector('.up-detail').textContent = stepDetail(u, i, state);
  });
}

const INLINE_TEXT = {
  queued: () => 'En attente',
  prepare: () => 'Préparation…',
  files: (u) => `${u.sent} / ${u.total} envoyée${u.sent > 1 ? 's' : ''}`,
  complete: () => 'Finalisation…',
  error: () => 'Envoi interrompu',
  stopped: () => 'Envoi arrêté',
};

function paintInline(el, u) {
  el.hidden = !u || u.phase === 'done';
  if (el.hidden) return;
  el.dataset.state = u.phase === 'queued' ? 'pending' : isActive(u) ? 'active' : u.phase;
  el.querySelector('.up-inline-text').textContent = INLINE_TEXT[u.phase](u);
  el.querySelector('.up-bar').style.setProperty('--p', uploadFraction(u).toFixed(4));
}

/** Vignettes : en attente (estompées), en cours (anneau d'avancement), envoyées (pastille). */
function paintThumbs(grid, u) {
  const live = isActive(u);
  for (const el of grid.children) {
    const pid = el.dataset.id;
    const sending = live && u.current === pid;
    el.classList.toggle('waiting', live && u.ids.has(pid) && !u.sentIds.has(pid) && !sending);
    el.classList.toggle('sending', sending);
    if (sending) el.style.setProperty('--p', u.fileFraction.toFixed(3));
    if (u?.sentIds.has(pid) && !el.classList.contains('uploaded')) el.classList.add('uploaded', 'just');
  }
}

function paintUploads() {
  const busy = anyActive();
  document.querySelectorAll('[data-upload-btn]').forEach((el) => { el.disabled = busy; });
  document.querySelectorAll('[data-upload]').forEach((el) => paintPanel(el, uploads.get(el.dataset.upload)));
  document.querySelectorAll('[data-upload-inline]').forEach((el) => paintInline(el, uploads.get(el.dataset.uploadInline)));
  document.querySelectorAll('[data-upload-thumbs]').forEach((el) => paintThumbs(el, uploads.get(el.dataset.uploadThumbs)));
  // Nombre de photos restantes, en direct.
  document.querySelectorAll('[data-status]').forEach((el) => {
    const u = uploads.get(el.dataset.status);
    if (!u || u.phase === 'queued' || u.phase === 'done' || !u.total) return;
    const remaining = u.total - u.sent;
    el.textContent = remaining ? `${remaining} à envoyer` : 'finalisation';
  });
}

// Les mises à jour (jusqu'à plusieurs dizaines par seconde) sont regroupées par image affichée.
let paintPending = false;
function showProgress() {
  if (paintPending) return;
  paintPending = true;
  requestAnimationFrame(() => { paintPending = false; paintUploads(); });
}

// ---------- Routeur ----------

let cleanup = null;

async function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [, view, id] = (location.hash || '#/').split('/');
  try {
    if (view === 'capture' && id) cleanup = await renderCapture(id);
    else if (view === 'seq' && id) await renderDetail(id);
    else if (view === 'settings') await renderSettings();
    else await renderList();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<main class="page"><p class="error">${esc(e.message)}</p><a href="#/">Retour</a></main>`;
  }
  paintUploads();
}

/** Re-dessine l'écran courant, sauf la capture (qui redémarrerait la caméra). */
function refresh() {
  if (!location.hash.startsWith('#/capture/')) render();
}

window.addEventListener('hashchange', () => {
  for (const [id, u] of uploads) if (!isActive(u)) uploads.delete(id); // bilans affichés jusqu'au changement d'écran
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') auth.checkPending();
});

// ---------- Écran : liste ----------

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** « Continuer l'envoi » après une coupure ou un arrêt, sinon null. */
const resumeLabel = (id) => (['error', 'stopped'].includes(uploads.get(id)?.phase) ? 'Continuer l’envoi' : null);
const sendSuffix = () => (DEMO ? ' (simulé)' : settings.privateUpload ? ' (privé)' : '');

function statusLabel(seq, total, pending) {
  if (!total) return 'vide';
  if (pending) return `${pending} à envoyer`;
  if (!seq.uploadCompleted) return 'à envoyer';
  return seq.uploadVisibility === 'owner-only' ? 'envoyée (privée)' : 'envoyée';
}

async function renderList() {
  const [sequences, photos] = await Promise.all([db.listSequences(), db.allPhotos()]);
  const stats = new Map();
  for (const p of photos) {
    const s = stats.get(p.sequenceId) ?? { total: 0, pending: 0, tilted: 0 };
    s.total += 1;
    if (!p.uploaded) s.pending += 1;
    if (tiltOf(p.pitch)) s.tilted += 1;
    stats.set(p.sequenceId, s);
  }
  const anyPending = [...stats.values()].some((s) => s.pending > 0);

  app.innerHTML = `
    <header class="bar">
      <h1>Arpent</h1>
      <div class="mode" role="radiogroup" aria-label="Mode">
        <button role="radio" aria-checked="${DEMO}" data-demo="true">Démo</button>
        <button role="radio" aria-checked="${!DEMO}" data-demo="false">${DEMO ? '' : '<span class="rec" aria-hidden="true"></span>'}Live</button>
      </div>
      <a href="#/settings" class="icon-btn" aria-label="Réglages">${ICON_GEAR}</a>
    </header>
    <main class="page">
      ${DEMO ? '<p class="banner">Mode démo : position, caméra et envoi simulés, rien ne part sur Panoramax. Passez en <b>Live</b> pour utiliser la caméra, le GPS et l’envoi réel.</p>' : ''}
      ${DEMO && !demoData.isSeeded() ? '<p class="banner subtle" id="demo-seed">Téléchargement d’une séquence d’exemple depuis Panoramax…</p>' : ''}
      ${isIOS() && !isStandalone() && !DEMO ? '<p class="banner">Pour garder vos photos, ajoutez Arpent à l’écran d’accueil : <b>Partager → Sur l’écran d’accueil</b>.</p>' : ''}
      ${!auth.current && !DEMO ? '<p class="banner subtle">Pas encore connecté à Panoramax : <a href="#/settings">se connecter</a> (nécessaire seulement pour l’envoi).</p>' : ''}
      ${sequences.length ? `<ul class="sequences">${sequences.map((seq) => {
        const s = stats.get(seq.id) ?? { total: 0, pending: 0, tilted: 0 };
        return `<li><a href="#/seq/${seq.id}">
          <span class="seq-map" data-seq-map="${seq.id}" aria-hidden="true"></span>
          <span class="name">${esc(seq.name)}</span>
          <span class="meta">${s.total} photo${s.total > 1 ? 's' : ''} · <span class="${s.pending ? 'pending' : 'done'}" data-status="${seq.id}">${statusLabel(seq, s.total, s.pending)}</span>${s.tilted ? ` · <span class="tilt-text">⚠ ${s.tilted} inclinée${s.tilted > 1 ? 's' : ''}</span>` : ''}</span>
          <span class="up-inline" data-upload-inline="${seq.id}" hidden><span class="up-icon" aria-hidden="true"></span><span class="up-inline-text"></span><span class="up-bar"><span></span></span></span>
        </a></li>`;
      }).join('')}</ul>` : `<div class="empty">
          <p><b>Aucune séquence.</b></p>
          <p>Démarrez une séquence, activez le mode auto et marchez : une photo est prise régulièrement, seulement quand vous avancez.</p>
        </div>`}
    </main>
    <footer class="actions">
      ${anyPending ? `<button class="secondary" id="sendAll" data-upload-btn>Tout envoyer${sendSuffix()}</button>` : ''}
      <button class="primary" id="new">Nouvelle séquence</button>
    </footer>`;

  app.querySelectorAll('.mode button').forEach((btn) => {
    btn.onclick = () => {
      const demo = btn.dataset.demo === 'true';
      if (demo !== DEMO) setMode(demo);
    };
  });
  document.getElementById('new').onclick = async () => {
    requestCompassPermission(); // pendant le geste (iOS)
    navigator.storage?.persist?.().catch(() => {});
    const seq = { id: uuid(), name: `Séquence du ${dateFmt.format(new Date())}`, createdAt: Date.now(), uploadSetId: null, uploadInstance: null, uploadCompleted: false };
    await db.putSequence(seq);
    autoStartFor = seq.id; // nouvelle séquence : mode auto selon le réglage (pas en reprise)
    location.hash = `#/capture/${seq.id}`;
  };
  if (DEMO && !demoData.isSeeded()) seedDemoSequence();
  fillSequenceMaps(photos);
  const sendAll = document.getElementById('sendAll');
  if (sendAll) {
    sendAll.onclick = () => uploadAll(sequences
      .map((seq) => ({ id: seq.id, pending: stats.get(seq.id)?.pending ?? 0 }))
      .filter((e) => e.pending > 0));
  }
}

/** Mode démo : au premier lancement, télécharge une vraie séquence publiée sur Panoramax. */
function seedDemoSequence() {
  const show = () => {
    const el = document.getElementById('demo-seed');
    if (!el) return;
    const { done, total, error } = demoData.progress;
    if (error) {
      el.innerHTML = `Séquence d’exemple indisponible (${esc(error)}). <a href="#/" id="demo-retry">Réessayer</a>`;
      document.getElementById('demo-retry').onclick = (e) => { e.preventDefault(); demoData.progress.error = null; render(); };
    } else {
      el.textContent = total
        ? `Téléchargement d’une séquence d’exemple depuis Panoramax… ${done}/${total} photos`
        : 'Téléchargement d’une séquence d’exemple depuis Panoramax…';
    }
  };
  show();
  if (demoData.progress.error) return;
  demoData.seedDemo(show).then((added) => { if (added) refresh(); }).catch(show);
}

// ---------- Écran : capture ----------

// Séquence tout juste créée : la capture démarre en mode auto si le réglage est activé.
let autoStartFor = null;

async function renderCapture(id) {
  const seq = await db.getSequence(id);
  if (!seq) { location.hash = '#/'; return null; }
  const startAuto = autoStartFor === id && settings.autoOnNewSequence;
  autoStartFor = null;
  const existing = await db.photosOf(id);

  app.innerHTML = `
    <div class="capture">
      <video playsinline muted autoplay></video>
      <div class="flash"></div>
      <div class="top">
        ${modeBadge()}
        <span class="gps none">GPS…</span>
        <span class="count"></span>
        <button class="end" id="close">Terminer</button>
      </div>
      <p class="msg" hidden></p>
      <div class="aim" aria-live="off">
        <svg class="dial" viewBox="-22 -22 44 44" aria-hidden="true">
          <circle r="20" />
          <text y="-12.5">N</text>
          <path class="needle" d="M0,-15 L5.5,5 L0,1.5 L-5.5,5 Z" />
        </svg>
        <span class="aim-text"><b class="aim-heading">Cap —</b><span class="aim-orientation"></span><span class="aim-debug" hidden></span></span>
      </div>
      <div class="bottom">
        <div class="bottom-left">
          <button class="auto" id="auto">Auto</button>
          <span class="status-row">
            ${settings.keepScreenOn ? `<button class="awake" id="awake" type="button" aria-label="Écran toujours allumé">${ICON_SUN}</button>` : ''}
            <span class="res"></span>
          </span>
        </div>
        <button class="shutter" id="shutter" aria-label="Prendre une photo"></button>
        <div class="minimap" role="button" tabindex="0" aria-expanded="false" aria-label="Carte : position, direction de la caméra et trace en cours. Toucher pour agrandir."></div>
      </div>
    </div>`;

  const $ = (s) => app.querySelector(s);
  const video = $('video');
  const camera = new CameraService(video);
  const location_ = new LocationService();
  const compass = new CompassService();
  compass.useWalk = settings.walkCalibration;

  let count = existing.length;
  let isAuto = false, capturing = false, timer = null, closed = false;
  const last = existing.at(-1);
  let lastShot = last ? { latitude: last.latitude, longitude: last.longitude } : null;

  const setMessage = (m) => { $('.msg').textContent = m ?? ''; $('.msg').hidden = !m; };
  // Compteur compact (icône + nombre) pour laisser la place au bouton Terminer.
  const updateCount = () => {
    $('.count').innerHTML = `${ICON_CAMERA}<span>${count}</span>`;
    $('.count').setAttribute('aria-label', `${count} photo${count > 1 ? 's' : ''}`);
  };
  updateCount();

  function usablePosition() {
    const p = location_.position;
    if (!p || p.accuracy > settings.maxAccuracy || Date.now() - p.timestamp > 10_000) return null;
    return p;
  }

  // Mini-carte : trace en cours (positions GPS assez précises), photos prises, position et direction.
  const trail = existing.map((p) => [p.longitude, p.latitude]);
  const shots = existing.map((p) => [p.longitude, p.latitude]);
  let mini = null;
  const updateMini = () => mini?.update({
    position: location_.position, heading: compass.best(location_.position)?.value ?? null, trail, shots,
  });
  // Toucher la mini-carte l'agrandit ; un second toucher la réduit.
  const miniEl = $('.minimap');
  const toggleMini = (e) => {
    if (e.target.closest('.maplibregl-ctrl')) return; // bouton d'attribution ⓘ
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const big = miniEl.classList.toggle('big');
    miniEl.setAttribute('aria-expanded', big);
    miniEl.setAttribute('aria-label', `Carte : position, direction de la caméra et trace en cours. Toucher pour ${big ? 'réduire' : 'agrandir'}.`);
  };
  miniEl.addEventListener('click', toggleMini);
  miniEl.addEventListener('keydown', toggleMini);
  liveMap(miniEl)
    .then((m) => { if (closed) m.remove(); else { mini = m; updateMini(); } })
    .catch(() => $('.minimap')?.remove());

  location_.onchange = () => {
    const p = location_.position;
    compass.walkSample(p); // sans effet si l'option est désactivée
    if (p && p.accuracy <= settings.maxAccuracy) {
      const lastPoint = trail.at(-1);
      if (!lastPoint || distance({ longitude: lastPoint[0], latitude: lastPoint[1] }, p) >= 2) trail.push([p.longitude, p.latitude]);
    }
    updateMini();
    const el = $('.gps');
    if (!el) return;
    if (location_.error) { el.className = 'gps none'; el.textContent = 'GPS refusé'; setMessage(location_.error); return; }
    if (!p) return;
    const q = p.accuracy <= 10 ? 'good' : p.accuracy <= settings.maxAccuracy ? 'ok' : 'poor';
    el.className = `gps ${q}`;
    el.textContent = `GPS ±${Math.round(p.accuracy)} m`;
  };

  async function take(pos) {
    capturing = true;
    try {
      const date = new Date();
      const heading = compass.best(pos);
      const pitch = compass.pitch;
      const { jpeg, thumb } = await camera.capture();
      const segment = buildExifSegment({
        latitude: pos.latitude, longitude: pos.longitude, altitude: pos.altitude, accuracy: pos.accuracy,
        speed: pos.speed, course: pos.course, heading: heading?.value, headingRef: heading?.ref, date,
      });
      const file = await withExif(jpeg, segment);
      if (closed) return;
      await db.addPhoto({
        id: uuid(), sequenceId: id, fileName: fileName(date),
        latitude: pos.latitude, longitude: pos.longitude, altitude: pos.altitude ?? null, accuracy: pos.accuracy,
        heading: heading?.value ?? null, pitch: pitch == null ? null : Math.round(pitch * 10) / 10,
        capturedAt: date.getTime(), uploaded: false, fileDeleted: false,
      }, file, thumb);
      lastShot = pos;
      shots.push([pos.longitude, pos.latitude]);
      updateMini();
      count += 1;
      updateCount();
      setMessage(null);
      const flash = $('.flash');
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
      navigator.vibrate?.(30);
    } catch (e) {
      setMessage(e.message);
    } finally {
      capturing = false;
    }
  }

  // Règle du mode auto : toutes les N s, photo seulement si on s'est déplacé d'au moins D m.
  // Réglage : pas de photo auto tant que la caméra regarde les pieds ou le ciel.
  let tiltPaused = false;
  function tick() {
    if (!isAuto || capturing) return;
    const pos = usablePosition();
    if (!pos) return;
    if (lastShot && distance(lastShot, pos) < settings.minDistance) return; // immobile
    const tilt = settings.skipTiltedAuto ? tiltOf(compass.pitch) : null;
    if (tilt) {
      tiltPaused = true;
      setMessage(`Mode auto en pause : caméra ${TILT_TEXT[tilt]}. Redressez le téléphone.`);
      return;
    }
    if (tiltPaused) { tiltPaused = false; setMessage(null); }
    take(pos);
  }

  function setAuto(on) {
    isAuto = on;
    $('#auto').classList.toggle('on', on);
    $('#auto').textContent = on ? 'Auto ●' : 'Auto';
    clearInterval(timer);
    timer = on ? setInterval(tick, Math.max(0.5, settings.interval) * 1000) : null;
    if (on) { setMessage(null); tick(); }
  }

  $('#auto').onclick = () => setAuto(!isAuto);
  $('#shutter').onclick = () => {
    if (capturing) return;
    const pos = usablePosition();
    if (!pos) { setMessage('Position GPS pas encore assez précise.'); return; }
    take(pos);
  };
  $('#close').onclick = () => { location.hash = `#/seq/${id}`; };

  // Indicateur de prise : direction de la caméra arrière (aiguille, cap, point cardinal)
  // et orientation physique du téléphone. C'est la valeur enregistrée dans la photo.
  const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const updateAim = () => {
    const h = compass.best(location_.position);
    const aim = $('.aim');
    if (!aim) return;
    aim.classList.toggle('unknown', !h);
    if (h) $('.needle').setAttribute('transform', `rotate(${h.value.toFixed(1)})`);
    $('.aim-heading').textContent = h
      ? `Cap ${Math.round(h.value) % 360}° ${CARDINALS[Math.round(h.value / 45) % 8]}`
      : 'Cap inconnu';
    const pitch = compass.pitch;
    const tilt = tiltOf(pitch);
    aim.classList.toggle('warn', !!tilt);
    $('.aim-orientation').textContent = tilt
      ? `⚠ ${TILT_TEXT[tilt]} : ${Math.round(Math.abs(pitch))}°`
      : [compass.orientationLabel, pitch != null ? pitchLabel(pitch) : null, h?.source === 'gps' ? 'selon la marche' : null,
        h?.source === 'compass+walk' ? 'calé sur la marche' : null,
        // iPhone : tant que la boussole n'a pas été calée en portrait, le cap en paysage est approximatif.
        compass.debug?.raw != null && !compass.calibrated && compass.walkCorrection == null && compass.orientation !== 'portrait' ? 'calez en portrait' : null]
        .filter(Boolean).join(' · ');
    // Diagnostic (toucher la pastille) : valeurs brutes des capteurs, pour vérifier le cap.
    const dbg = $('.aim-debug');
    if (dbg && !dbg.hidden) {
      const d = compass.debug, n = (v) => (v == null ? '—' : Math.round(v));
      const w = compass.walkCorrection;
      const walk = settings.walkCalibration ? ` · marche ${w == null ? 'en attente' : `${w >= 0 ? '+' : ''}${n(w)}°`}` : '';
      dbg.textContent = !d ? 'aucune donnée de boussole'
        : d.method === 'android'
          ? `${APP_VERSION} · Android · α ${n(d.alpha)} β ${n(d.beta)} γ ${n(d.gamma)} · écran ${d.screen}°${walk}`
          : `${APP_VERSION} · iOS ${n(d.raw)}° · gyro ${n(d.gyro)}°${d.offset != null ? ` ${d.offset >= 0 ? '+' : ''}${n(d.offset)}°` : ''} · β ${n(d.beta)} γ ${n(d.gamma)} · écran ${d.screen}° · calcul ${d.method}${walk}`;
    }
    updateMini(); // direction de la caméra sur la mini-carte
    const awake = $('#awake');
    if (awake) {
      const state = wakeState();
      awake.classList.toggle('off', state === 'off');
      awake.setAttribute('aria-label', state === 'off' ? 'Écran : mise en veille possible' : 'Écran toujours allumé');
    }
  };
  updateAim();
  const aimTimer = setInterval(updateAim, 250);
  $('.aim').addEventListener('click', () => { const d = $('.aim-debug'); d.hidden = !d.hidden; updateAim(); });

  location_.start();
  compass.start();
  if (settings.keepScreenOn) keepAwake(true);
  $('#awake')?.addEventListener('click', () => {
    keepAwake(true); // un toucher débloque la vidéo de secours si besoin
    toast(wakeState() === 'off'
      ? 'Ce navigateur refuse de garder l’écran allumé : réglez la mise en veille automatique du téléphone sur « Jamais » pendant la prise de vue.'
      : 'Écran toujours allumé pendant la prise de vue (réglable dans les réglages).');
  });
  camera.start()
    .then(() => {
      if (closed) return;
      $('.res').textContent = camera.resolution;
      if (startAuto) setAuto(true); // une fois la caméra prête
    })
    .catch((e) => setMessage(`Caméra indisponible : ${e.message}`));

  return () => {
    closed = true;
    clearInterval(timer);
    clearInterval(aimTimer);
    camera.stop();
    location_.stop();
    compass.stop();
    mini?.remove();
    keepAwake(anyActive());
  };
}

// ---------- Écran : détail d'une séquence ----------

let mapLibrePromise = null;

/** MapLibre GL (embarqué dans vendor/) chargé à la première carte affichée. */
function loadMapLibre() {
  mapLibrePromise ??= new Promise((resolve, reject) => {
    if (window.maplibregl) { resolve(window.maplibregl); return; }
    const script = document.createElement('script');
    script.src = 'vendor/maplibre/maplibre-gl.js';
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => { mapLibrePromise = null; reject(new Error('Carte indisponible.')); };
    document.head.append(script);
  });
  return mapLibrePromise;
}

/** Cône de champ de vision (60°) pointant vers le haut, sommet au centre de l'image. */
function viewConeImage(hex) {
  const size = 128, c = size / 2, r = 60, half = (30 * Math.PI) / 180;
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const rgba = (a) => `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(c, c, 0, c, c, r);
  grad.addColorStop(0, rgba(0.8));
  grad.addColorStop(1, rgba(0.1));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, r, -Math.PI / 2 - half, -Math.PI / 2 + half);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Carte de la séquence : fond OpenStreetMap sobre et sans points d'intérêt
 * (OpenFreeMap « positron », ou « dark » en mode sombre), trace, et un point par photo
 * (départ vert, arrivée rouge), avec un cône qui montre la direction de prise de vue.
 * Toucher un point ouvre la photo.
 */
async function trackMap(container, photos, onPick) {
  const maplibregl = await loadMapLibre();
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const coords = photos.map((p) => [p.longitude, p.latitude]);
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  const last = photos.length - 1;
  const time = (p) => new Date(p.capturedAt).toLocaleTimeString('fr-FR');

  const map = new maplibregl.Map({
    container,
    style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
    bounds,
    fitBoundsOptions: { padding: 28, maxZoom: 18 },
    attributionControl: false,
    scrollZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  const attribution = new maplibregl.AttributionControl({ compact: true });
  map.addControl(attribution, 'bottom-right');

  map.on('load', () => {
    // Attribution repliée (bouton ⓘ) pour ne pas masquer la trace.
    attribution._container?.classList.remove('maplibregl-compact-show');
    map.addImage('view-cone', viewConeImage(color('--accent')), { pixelRatio: 2 });
    map.addSource('track', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
    map.addLayer({
      id: 'track', type: 'line', source: 'track',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color('--accent'), 'line-width': 4, 'line-opacity': 0.8 },
    });
    map.addSource('photos', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: photos.map((p, i) => ({
          type: 'Feature',
          properties: {
            i,
            role: i === 0 ? 'start' : i === last ? 'end' : 'mid',
            label: `Photo ${i + 1}/${photos.length} · ${time(p)}${p.heading != null ? ` · cap ${Math.round(p.heading)}°` : ''}`,
            ...(p.heading != null ? { heading: p.heading } : {}),
          },
          geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
        })),
      },
    });
    // Cône de prise de vue orienté selon le cap de chaque photo, sous les points.
    map.addLayer({
      id: 'view-cones', type: 'symbol', source: 'photos',
      filter: ['has', 'heading'],
      layout: {
        'icon-image': 'view-cone',
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: 'photos', type: 'circle', source: 'photos',
      paint: {
        'circle-radius': ['match', ['get', 'role'], 'mid', 5, 7],
        'circle-color': ['match', ['get', 'role'], 'start', color('--done'), 'end', color('--danger'), color('--accent')],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });

    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    map.on('click', 'photos', (e) => onPick(photos[e.features[0].properties.i]));
    map.on('mouseenter', 'photos', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      tip.setLngLat(e.features[0].geometry.coordinates).setText(e.features[0].properties.label).addTo(map);
    });
    map.on('mouseleave', 'photos', () => { map.getCanvas().style.cursor = ''; tip.remove(); });
  });
  return map;
}

// ---------- Vignettes de carte de la liste ----------
// Une seule carte cachée dessine la trace de chaque séquence puis en fait une image (JPEG),
// gardée sur l'appareil et refaite seulement quand la séquence change. En attendant, ou sans
// réseau, la trace est dessinée seule (SVG).

const MAP_THUMBS_KEY = 'arpent.mapThumbs';
const MAP_THUMB_SIZE = 64; // px CSS, rendu en x2
const mapThumbs = new Map(Object.entries(store.get(MAP_THUMBS_KEY, {})));
const thumbsInProgress = new Set();
let thumbQueue = Promise.resolve();
let thumbRendererPromise = null;

function saveMapThumb(id, key, url) {
  mapThumbs.delete(id);
  mapThumbs.set(id, { key, url });
  while (mapThumbs.size > 60) mapThumbs.delete(mapThumbs.keys().next().value); // les plus anciennes partent
  store.set(MAP_THUMBS_KEY, Object.fromEntries(mapThumbs));
}

/** Trace seule, projetée simplement dans le carré (sans fond de carte). */
function trackSVG(coords, color) {
  const k = Math.cos((coords[0][1] * Math.PI) / 180);
  const xs = coords.map((c) => c[0] * k), ys = coords.map((c) => -c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0) || 1, pad = 10, size = 64 - 2 * pad;
  const px = (i) => [pad + ((xs[i] - x0) / span) * size + (size - ((x1 - x0) / span) * size) / 2,
    pad + ((ys[i] - y0) / span) * size + (size - ((y1 - y0) / span) * size) / 2];
  const pts = coords.map((_, i) => px(i).map((v) => v.toFixed(1)).join(',')).join(' ');
  const [sx, sy] = px(0), [ex, ey] = px(coords.length - 1);
  return `<svg viewBox="0 0 64 64" width="100%" height="100%"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${sx}" cy="${sy}" r="3.5" fill="var(--done)" stroke="#fff" stroke-width="1.5"/><circle cx="${ex}" cy="${ey}" r="3.5" fill="var(--danger)" stroke="#fff" stroke-width="1.5"/></svg>`;
}

/** Carte hors écran partagée, prête à dessiner une trace (abandonne au bout de 15 s). */
function thumbRenderer() {
  thumbRendererPromise ??= (async () => {
    const maplibregl = await loadMapLibre();
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:-10000px;top:0;width:${MAP_THUMB_SIZE}px;height:${MAP_THUMB_SIZE}px`;
    document.body.append(el);
    const map = new maplibregl.Map({
      container: el,
      style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
      center: [2.35, 48.85], zoom: 12, interactive: false, attributionControl: false,
      preserveDrawingBuffer: true, pixelRatio: 2, fadeDuration: 0,
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Carte indisponible.')), 15_000);
      map.once('load', () => { clearTimeout(t); resolve(); });
    });
    const empty = { type: 'FeatureCollection', features: [] };
    map.addSource('track', { type: 'geojson', data: empty });
    map.addSource('ends', { type: 'geojson', data: empty });
    map.addLayer({
      id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color('--accent'), 'line-width': 3 },
    });
    map.addLayer({
      id: 'ends', type: 'circle', source: 'ends',
      paint: {
        'circle-radius': 3.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        'circle-color': ['match', ['get', 'role'], 'start', color('--done'), color('--danger')],
      },
    });
    return { map, dark };
  })().catch((e) => { thumbRendererPromise = null; throw e; });
  return thumbRendererPromise;
}

async function renderMapThumb(coords) {
  const { map } = await thumbRenderer();
  const point = (c, role) => ({ type: 'Feature', properties: { role }, geometry: { type: 'Point', coordinates: c } });
  map.getSource('track').setData(coords.length > 1
    ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
    : { type: 'FeatureCollection', features: [] });
  map.getSource('ends').setData({ type: 'FeatureCollection', features: [point(coords[0], 'start'), point(coords.at(-1), 'end')] });
  if (coords.length === 1) {
    map.jumpTo({ center: coords[0], zoom: 16 });
  } else {
    const bounds = coords.reduce((b, c) => b.extend(c), new window.maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 9, maxZoom: 17, animate: false });
  }
  // « idle » : tuiles chargées et image dessinée.
  const complete = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10_000);
    map.once('idle', () => { clearTimeout(t); resolve(true); });
    map.triggerRepaint();
  });
  if (!complete) throw new Error('Tuiles trop lentes.');
  return map.getCanvas().toDataURL('image/jpeg', 0.85);
}

/** Remplit les vignettes de la liste : image en cache, sinon trace seule puis carte dessinée. */
function fillSequenceMaps(photos) {
  const bySeq = new Map();
  for (const p of photos) (bySeq.get(p.sequenceId) ?? bySeq.set(p.sequenceId, []).get(p.sequenceId)).push(p);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const show = (el, url) => { el.innerHTML = ''; el.style.backgroundImage = `url("${url}")`; };

  for (const el of document.querySelectorAll('[data-seq-map]')) {
    const id = el.dataset.seqMap;
    const list = (bySeq.get(id) ?? []).sort((a, b) => a.capturedAt - b.capturedAt);
    if (!list.length) { el.classList.add('empty'); continue; }
    const coords = list.map((p) => [p.longitude, p.latitude]);
    const key = `${list.length}:${list.at(-1).id}:${dark ? 'dark' : 'light'}:${accent}`;
    const cached = mapThumbs.get(id);
    if (cached?.key === key) { show(el, cached.url); continue; }
    el.innerHTML = trackSVG(coords, accent);
    if (thumbsInProgress.has(id + key)) continue;
    thumbsInProgress.add(id + key);
    thumbQueue = thumbQueue
      .then(() => renderMapThumb(coords))
      .then((url) => {
        saveMapThumb(id, key, url);
        const target = document.querySelector(`[data-seq-map="${id}"]`);
        if (target) show(target, url);
      })
      .catch(() => { /* hors ligne : la trace seule reste affichée */ })
      .finally(() => thumbsInProgress.delete(id + key));
  }
}

/**
 * Mini-carte de la vue caméra (non interactive, nord en haut) : suit la position, avec un
 * cône dans la direction de la caméra, la trace en cours et un point par photo prise.
 */
async function liveMap(container) {
  const maplibregl = await loadMapLibre();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const map = new maplibregl.Map({
    container,
    style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
    center: [2.35, 48.85],
    zoom: 16.5,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    maxTileCacheSize: 60, // mémoire limitée sur iPhone, la caméra tourne en même temps
  });
  // Réseau lent ou absent : la case affiche « Carte… » jusqu'au chargement du style.
  await new Promise((resolve) => map.once('load', resolve));
  // Attribution ajoutée une fois la carte prête, directement repliée (bouton ⓘ).
  const attribution = new maplibregl.AttributionControl({ compact: true });
  map.addControl(attribution, 'bottom-right');
  attribution._container?.classList.remove('maplibregl-compact-show');

  const ME = '#1a73e8';
  const empty = { type: 'FeatureCollection', features: [] };
  map.addImage('me-cone', viewConeImage(ME), { pixelRatio: 2 });
  map.addSource('trail', { type: 'geojson', data: empty });
  map.addSource('shots', { type: 'geojson', data: empty });
  map.addSource('me', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'trail', type: 'line', source: 'trail',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': accent, 'line-width': 3, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'shots', type: 'circle', source: 'shots',
    paint: { 'circle-radius': 3, 'circle-color': accent, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
  });
  map.addLayer({
    id: 'me-cone', type: 'symbol', source: 'me', filter: ['has', 'heading'],
    layout: {
      'icon-image': 'me-cone', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'me', type: 'circle', source: 'me',
    paint: { 'circle-radius': 6, 'circle-color': ME, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });

  // Agrandie ou réduite : la carte suit la taille de sa case et reste centrée sur la position.
  const resizer = new ResizeObserver(() => {
    const center = map.getCenter();
    map.resize();
    map.jumpTo({ center });
  });
  resizer.observe(container);

  // Mises à jour fréquentes (4 par seconde) : on ne pousse que ce qui a changé.
  let seen = { trail: -1, shots: -1, at: null, heading: null };
  return {
    remove: () => { resizer.disconnect(); map.remove(); },
    update({ position, heading, trail, shots }) {
      if (trail.length !== seen.trail) {
        seen.trail = trail.length;
        map.getSource('trail').setData(trail.length > 1
          ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trail } } : empty);
      }
      if (shots.length !== seen.shots) {
        seen.shots = shots.length;
        map.getSource('shots').setData({ type: 'MultiPoint', coordinates: shots });
      }
      if (!position) return;
      const moved = position.timestamp !== seen.at;
      const turned = heading != null && (seen.heading == null || Math.abs(heading - seen.heading) > 1);
      if (!moved && !turned && (heading == null) === (seen.heading == null)) return;
      const center = [position.longitude, position.latitude];
      map.getSource('me').setData({
        type: 'Feature', properties: heading != null ? { heading } : {}, geometry: { type: 'Point', coordinates: center },
      });
      if (moved) {
        if (seen.at == null) map.jumpTo({ center, zoom: 17 });
        else map.easeTo({ center, duration: 500 });
      }
      seen = { ...seen, at: position.timestamp, heading };
    },
  };
}

async function renderDetail(id) {
  const seq = await db.getSequence(id);
  if (!seq) { location.hash = '#/'; return; }
  const photos = await db.photosOf(id);
  const pending = photos.filter((p) => !p.uploaded).length;
  const tilted = photos.filter((p) => tiltOf(p.pitch));
  const tiltedLocal = tilted.filter((p) => !p.uploaded); // seules celles-ci peuvent encore être écartées avant l'envoi
  const unfinished = !pending && photos.length > 0 && seq.uploadSetId && !seq.uploadCompleted; // finalisation interrompue
  let meters = 0;
  for (let i = 1; i < photos.length; i++) meters += distance(photos[i - 1], photos[i]);
  const minutes = photos.length > 1 ? Math.round((photos.at(-1).capturedAt - photos[0].capturedAt) / 60000) : 0;

  app.innerHTML = `
    <header class="bar">
      <a href="#/" class="back">‹ Séquences</a>
      ${modeBadge()}
    </header>
    <main class="page">
      <input class="title" id="name" value="${esc(seq.name)}" aria-label="Nom de la séquence">
      ${photos.length ? '<div class="map" id="map" role="region" aria-label="Carte du parcours"></div>' : ''}
      <p class="meta">${photos.length} photo${photos.length > 1 ? 's' : ''} · ${(meters / 1000).toFixed(2)} km · ${minutes} min ·
        <span class="${pending ? 'pending' : 'done'}" data-status="${id}">${statusLabel(seq, photos.length, pending)}</span></p>
      ${tilted.length ? `<div class="banner warn tilt-banner">
        <p>⚠ ${tilted.length} photo${tilted.length > 1 ? 's' : ''} trop inclinée${tilted.length > 1 ? 's' : ''} (pieds ou ciel), marquée${tilted.length > 1 ? 's' : ''} ⚠ ci-dessous.${tiltedLocal.length < tilted.length ? ` ${tilted.length - tiltedLocal.length} déjà envoyée${tilted.length - tiltedLocal.length > 1 ? 's' : ''}.` : ''}</p>
        ${tiltedLocal.length ? `<button class="secondary" id="dropTilted" data-upload-btn>Écarter ${tiltedLocal.length > 1 ? `les ${tiltedLocal.length} photos non envoyées` : 'la photo non envoyée'}</button>` : ''}
      </div>` : ''}
      <section class="upload" data-upload="${id}" aria-label="Envoi sur Panoramax" hidden></section>
      ${seq.uploadCompleted && seq.uploadSetId && !DEMO ? '<p class="hint" id="pmx-link">Recherche de la séquence sur Panoramax…</p>' : ''}
      ${seq.source ? `<p class="hint">Photos : ${esc(seq.source.author)}, licence <a href="${esc(seq.source.licenseURL)}" target="_blank" rel="noopener">${esc(seq.source.license)}</a>, <a href="${esc(seq.source.url)}" target="_blank" rel="noopener">voir sur Panoramax</a>.</p>` : ''}
      <div class="grid" data-upload-thumbs="${id}">${photos.map((p) => `<button class="thumb ${p.uploaded ? 'uploaded' : ''}" data-id="${p.id}" aria-label="Photo ${esc(p.fileName)}${tiltOf(p.pitch) ? `, ${TILT_TEXT[tiltOf(p.pitch)]}` : ''}">${tiltOf(p.pitch) ? `<span class="tilt-badge" title="${TILT_TEXT[tiltOf(p.pitch)]} : ${Math.round(Math.abs(p.pitch))}°">⚠</span>` : ''}</button>`).join('')}</div>
    </main>
    <footer class="actions">
      <button class="danger" id="delete">Supprimer</button>
      <button class="secondary" id="resume">Reprendre</button>
      ${pending || unfinished ? `<button class="primary" id="send" data-upload-btn>${resumeLabel(id) ?? (pending ? 'Envoyer' : 'Finaliser')}${sendSuffix()}</button>` : ''}
    </footer>`;

  // Vignettes chargées à la demande.
  const urls = [];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      db.getBlobs(e.target.dataset.id).then((b) => {
        if (!b?.thumb) return;
        const u = URL.createObjectURL(b.thumb);
        urls.push(u);
        e.target.style.backgroundImage = `url("${u}")`;
      });
    }
  });
  app.querySelectorAll('.thumb').forEach((el) => io.observe(el));
  // Carte chargée sans bloquer l'affichage ; retirée en quittant l'écran.
  let map = null, closed = false;
  const mapEl = app.querySelector('#map');
  if (mapEl) {
    trackMap(mapEl, photos, openViewer)
      .then((m) => { if (closed) m.remove(); else map = m; })
      .catch((e) => { mapEl.classList.add('map-error'); mapEl.textContent = e.message; });
  }
  cleanup = () => { closed = true; map?.remove(); io.disconnect(); urls.forEach(URL.revokeObjectURL); };

  app.querySelector('#name').onchange = async (e) => {
    const name = e.target.value.trim();
    if (name) await db.putSequence({ ...(await db.getSequence(id)), name });
  };
  app.querySelector('#resume').onclick = () => {
    requestCompassPermission();
    location.hash = `#/capture/${id}`;
  };
  const dropTilted = app.querySelector('#dropTilted');
  if (dropTilted) {
    dropTilted.onclick = async () => {
      const n = tiltedLocal.length;
      if (!confirm(`Supprimer de ce téléphone ${n > 1 ? `les ${n} photos trop inclinées non envoyées` : 'la photo trop inclinée non envoyée'} ? Elles ne seront pas envoyées sur Panoramax.`)) return;
      for (const p of tiltedLocal) await db.deletePhoto(p.id);
      toast(`${n} photo${n > 1 ? 's' : ''} écartée${n > 1 ? 's' : ''}.`);
      render();
    };
  }
  app.querySelector('#delete').onclick = async () => {
    if (!confirm(`Supprimer « ${seq.name} » et ses ${photos.length} photos de ce téléphone ?`)) return;
    await db.deleteSequence(id);
    location.hash = '#/';
  };
  if (seq.uploadCompleted && seq.uploadSetId && !DEMO) showPanoramaxLink(seq);
  const send = app.querySelector('#send');
  if (send) {
    send.onclick = () => {
      uploadSequence(id);
      requestAnimationFrame(() => app.querySelector('.upload')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    };
  }

  app.querySelector('.grid').onclick = (e) => {
    const btn = e.target.closest('.thumb');
    if (btn) openViewer(photos.find((p) => p.id === btn.dataset.id));
  };
}

/**
 * Lien vers la séquence publiée. Le serveur crée la ou les séquences (collections) après l'envoi,
 * parfois avec un délai : on interroge l'upload set et on garde le résultat une fois connu.
 */
async function showPanoramaxLink(seq) {
  const el = document.getElementById('pmx-link');
  if (!el) return;
  const instance = seq.uploadInstance;
  const privateNote = seq.uploadVisibility === 'owner-only' ? ' (privée : visible une fois connecté sur le site)' : '';
  const render = (collections) => {
    const links = collections.map((c, i) => `<a href="${esc(sequencePageURL(instance, c.id))}" target="_blank" rel="noopener">${
      collections.length > 1 ? `séquence ${i + 1} (${c.nb_items} photo${c.nb_items > 1 ? 's' : ''})` : 'Voir la séquence sur Panoramax'}</a>`);
    el.innerHTML = collections.length > 1
      ? `Sur Panoramax, découpée en ${collections.length} séquences : ${links.join(', ')}${esc(privateNote)}.`
      : `${links[0]}${esc(privateNote)}.`;
  };
  if (seq.collections?.length) { render(seq.collections); return; }

  try {
    const a = store.get('arpent.auth', null);
    const token = a && a.instance === instance ? a.jwt : null;
    const set = await new Client(instance, token).getUploadSet(seq.uploadSetId);
    const collections = (set.associated_collections ?? []).map((c) => ({ id: c.id, nb_items: c.nb_items }));
    if (!document.body.contains(el)) return;
    if (collections.length) {
      await db.putSequence({ ...(await db.getSequence(seq.id)), collections });
      render(collections);
    } else {
      el.innerHTML = 'Séquence en cours de traitement sur Panoramax. <a href="#" id="pmx-retry">Actualiser</a>';
      document.getElementById('pmx-retry').onclick = (e) => { e.preventDefault(); el.textContent = 'Recherche de la séquence sur Panoramax…'; showPanoramaxLink(seq); };
    }
  } catch (e) {
    if (!document.body.contains(el)) return;
    el.textContent = e.status === 401 || e.status === 403 || e instanceof NotLoggedIn
      ? 'Connectez-vous à l’instance dans les réglages pour afficher le lien vers la séquence.'
      : `Lien vers Panoramax indisponible (${e.message}).`;
  }
}

async function openViewer(photo) {
  const b = await db.getBlobs(photo.id);
  const url = URL.createObjectURL(b?.jpeg ?? b?.thumb ?? new Blob());
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <img src="${url}" alt="">
    <div class="info">
      <span>${new Date(photo.capturedAt).toLocaleString('fr-FR')} · ±${Math.round(photo.accuracy)} m${photo.heading != null ? ` · cap ${Math.round(photo.heading)}°` : ''}${photo.pitch != null ? ` · ${tiltOf(photo.pitch) ? `<b class="tilt-text">⚠ ${TILT_TEXT[tiltOf(photo.pitch)]} : ${Math.round(Math.abs(photo.pitch))}°</b>` : `inclinaison ${pitchLabel(photo.pitch)}`}` : ''}${photo.uploaded ? ' · envoyée' : ''}${photo.fileDeleted ? ' (fichier supprimé du téléphone)' : ''}</span>
      <div class="row">
        <button class="danger" id="vdel">Supprimer la photo</button>
        <button class="primary" id="vclose">Fermer</button>
      </div>
    </div>`;
  document.body.append(el);
  const close = () => { el.remove(); URL.revokeObjectURL(url); };
  el.querySelector('#vclose').onclick = close;
  el.querySelector('#vdel').onclick = async () => {
    if (!confirm('Supprimer cette photo ?')) return;
    await db.deletePhoto(photo.id);
    close();
    render();
  };
}

// ---------- Écran : réglages ----------

async function renderSettings() {
  const a = auth.current;
  const pending = auth.pending;
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mb = (n) => `${Math.round(n / 1e6)} Mo`;

  app.innerHTML = `
    <header class="bar">
      <a href="#/" class="back">‹ Séquences</a>
      <h1>Réglages</h1>
      ${modeBadge()}
    </header>
    <main class="page form">
      <section>
        <h2>Panoramax</h2>
        <label>Instance<input id="instance" inputmode="url" autocapitalize="off" autocorrect="off" value="${esc(settings.instance)}"></label>
        ${a ? `<p>Connecté : <b>${esc(a.userName)}</b></p><button class="secondary" id="logout">Se déconnecter</button>`
          : pending ? `<p>Connexion en cours sur le site de l’instance.</p>
              <div class="row"><button class="primary" id="check">J’ai terminé, vérifier</button><button class="secondary" id="cancel">Annuler</button></div>`
          : `<p class="hint">La connexion se fait sur le site de l’instance (compte OpenStreetMap ou autre). Aucun mot de passe n’est saisi ici.</p>
              <button class="primary" id="login">Se connecter</button>`}
        <label class="check"><input id="privateUpload" type="checkbox" ${settings.privateUpload ? 'checked' : ''}>Envoi privé (test)</label>
        <p class="hint">Les séquences envoyées ne sont visibles que par vous sur Panoramax : pratique pour tester sans rien publier. Supprimez-les ensuite depuis votre compte sur le site de l’instance.</p>
      </section>
      <section>
        <h2>Écran</h2>
        <label class="check"><input id="keepScreenOn" type="checkbox" ${settings.keepScreenOn ? 'checked' : ''}>Écran toujours allumé pendant la prise de vue</label>
        <p class="hint">Empêche la mise en veille tant que la caméra est ouverte, pour que le mode auto continue. Le témoin ☀ en bas à gauche de l’écran de capture devient orange si le téléphone le refuse. Verrouiller le téléphone ou changer d’app arrête toujours la capture.</p>
      </section>
      <section>
        <h2>Boussole</h2>
        <label class="check"><input id="walkCalibration" type="checkbox" ${settings.walkCalibration ? 'checked' : ''}>Caler la boussole sur la direction de marche</label>
        <p class="hint">À activer si la caméra vise dans le sens de la marche. En marchant droit, la direction donnée par le GPS est précise : Arpent corrige la boussole avec, ce qui rattrape une boussole faussée (aimant, métal, calibration) sur tous les téléphones. Les photos prises sur le côté (façades) sont ignorées pour ce calage ; ne l’activez pas si vous photographiez surtout sur le côté. Le cap enregistré est alors rapporté au nord géographique.</p>
      </section>
      <section>
        <h2>Mode auto</h2>
        <label class="check"><input id="autoOnNewSequence" type="checkbox" ${settings.autoOnNewSequence ? 'checked' : ''}>Activer le mode auto à la création d’une séquence</label>
        <p class="hint">« Nouvelle séquence » ouvre la caméra avec le mode auto déjà en marche : il suffit de marcher. « Reprendre » une séquence ne le relance pas.</p>
        <label>Intervalle (s)<input id="interval" type="number" min="0.5" step="0.5" value="${settings.interval}"></label>
        <label>Distance minimale (m)<input id="minDistance" type="number" min="0" step="1" value="${settings.minDistance}"></label>
        <label>Précision GPS maximale (m)<input id="maxAccuracy" type="number" min="1" step="1" value="${settings.maxAccuracy}"></label>
      </section>
      <section>
        <h2>Angle de la caméra</h2>
        <label class="check"><input id="tiltWarning" type="checkbox" ${settings.tiltWarning ? 'checked' : ''}>Signaler les photos trop inclinées</label>
        <label class="check"><input id="skipTiltedAuto" type="checkbox" ${settings.skipTiltedAuto ? 'checked' : ''}>En mode auto, ne pas prendre les photos trop inclinées</label>
        <label>Vers le ciel, au maximum (°)<input id="maxPitchUp" type="number" min="0" max="90" step="5" value="${settings.maxPitchUp}"></label>
        <label>Vers le sol, au maximum (°)<input id="maxPitchDown" type="number" min="0" max="90" step="5" value="${settings.maxPitchDown}"></label>
        <p class="hint">0° = caméra vers l’horizon, téléphone tenu droit. Au-delà de ces angles, l’écran de prise de vue prévient en direct ; en mode auto, la photo n’est pas prise (si l’option est cochée), sinon elle est marquée ⚠. Le déclencheur manuel prend toujours la photo. L’angle est mesuré au moment de la prise ; valeurs par défaut : ${DEFAULTS.maxPitchUp}° et ${DEFAULTS.maxPitchDown}°.</p>
      </section>
      <section>
        <h2>Stockage</h2>
        <label class="check"><input id="deleteAfterUpload" type="checkbox" ${settings.deleteAfterUpload ? 'checked' : ''}>Supprimer les photos du téléphone après envoi</label>
        <p class="hint">Une fois la séquence envoyée et validée par Panoramax, les photos en pleine taille sont effacées de ce téléphone pour libérer de la place. La vignette, la position et la carte restent ; la photo reste consultable sur Panoramax.</p>
        ${estimate ? `<p class="hint">Utilisé : ${mb(estimate.usage)} sur ${mb(estimate.quota)} disponibles${persisted ? ' · stockage persistant' : ''}.</p>` : ''}
      </section>
      <section>
        <h2>À propos</h2>
        <p class="hint">Arpent Web ${APP_VERSION}. Mode actuel : ${DEMO ? 'démo (position et caméra simulées)' : 'live'}, modifiable en haut de la liste des séquences.</p>
        ${DEMO ? '<button class="secondary" id="resetDemo">Réinitialiser la démo</button><p class="hint">Efface les séquences de démo et retélécharge la séquence d’exemple Panoramax.</p>' : ''}
        <p class="hint">Code source et suivi des problèmes : <a href="https://github.com/blamouche/arpent" target="_blank" rel="noopener">github.com/blamouche/arpent</a></p>
      </section>
    </main>`;

  const $ = (s) => app.querySelector(s);
  $('#instance').onchange = (e) => {
    const url = normalizeInstance(e.target.value);
    if (!url) { toast('Adresse d’instance invalide.'); e.target.value = settings.instance; return; }
    settings.instance = url;
    settings.save();
    render();
  };
  for (const key of ['interval', 'minDistance', 'maxAccuracy', 'maxPitchUp', 'maxPitchDown']) {
    $(`#${key}`).onchange = (e) => {
      const v = Number(e.target.value);
      const ok = Number.isFinite(v) && v >= 0 && (!key.startsWith('maxPitch') || v <= 90);
      if (ok) { settings[key] = v; settings.save(); } else e.target.value = settings[key];
    };
  }
  $('#skipTiltedAuto').onchange = (e) => { settings.skipTiltedAuto = e.target.checked; settings.save(); };
  $('#tiltWarning').onchange = (e) => { settings.tiltWarning = e.target.checked; settings.save(); };
  $('#walkCalibration').onchange = (e) => { settings.walkCalibration = e.target.checked; settings.save(); };
  $('#keepScreenOn').onchange = (e) => { settings.keepScreenOn = e.target.checked; settings.save(); };
  $('#autoOnNewSequence').onchange = (e) => { settings.autoOnNewSequence = e.target.checked; settings.save(); };
  $('#deleteAfterUpload').onchange = (e) => { settings.deleteAfterUpload = e.target.checked; settings.save(); };
  $('#privateUpload').onchange = (e) => { settings.privateUpload = e.target.checked; settings.save(); };
  $('#resetDemo')?.addEventListener('click', async () => {
    if (!DEMO || !confirm('Effacer toutes les séquences de démo et recharger la séquence d’exemple ?')) return;
    await demoData.resetDemo();
    location.hash = '#/';
  });

  $('#login')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await auth.login(); } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $('#check')?.addEventListener('click', () => auth.checkPending({ silent: false }));
  $('#cancel')?.addEventListener('click', () => { store.set('arpent.pendingAuth', null); render(); });
  $('#logout')?.addEventListener('click', () => { auth.logout(); render(); });
}

/** Pastille de mode en haut des écrans : point rouge « record » animé en live. */
function modeBadge() {
  return DEMO
    ? '<span class="mode-badge demo">Démo</span>'
    : '<span class="mode-badge live" role="status" aria-label="Mode live"><span class="rec" aria-hidden="true"></span>Live</span>';
}

const ICON_CAMERA = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 4h6l1.5 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5zm3 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.4h-4L10.7 6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';

// ---------- Démarrage ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
auth.checkPending();
render();

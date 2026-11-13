// Arpent Web : interface (4 écrans), réglages, connexion et envoi.
import * as db from './db.js';
import { buildExifSegment, withExif } from './exif.js';
import * as demoData from './demo-data.js';
import { Client, NotLoggedIn, normalizeInstance } from './panoramax.js';
import {
  DEMO, LocationService, CompassService, CameraService, distance, keepAwake, requestCompassPermission, setMode,
} from './sensors.js';

const app = document.getElementById('app');

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
  deleteAfterUpload: false,
};

const settings = {
  ...DEFAULTS,
  ...store.get('arpent.settings', {}),
  save() {
    const { save, ...values } = this;
    store.set('arpent.settings', values);
  },
};

// ---------- Connexion (jeton « réclamé », comme sur iOS) ----------

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

const uploads = new Map(); // id séquence → avancement 0…1

function showProgress() {
  document.querySelectorAll('[data-progress]').forEach((el) => {
    const p = uploads.get(el.dataset.progress);
    el.hidden = p == null;
    if (p != null) el.value = p;
  });
  document.querySelectorAll('[data-upload-btn]').forEach((el) => {
    el.disabled = uploads.size > 0;
  });
}

async function sendSequence(id, client) {
  const seq = await db.getSequence(id);
  const photos = await db.photosOf(id);
  const pending = photos.filter((p) => !p.uploaded);
  if (!pending.length) return;

  // Nouvel upload set si aucun, si l'instance a changé ou si le précédent est déjà terminé.
  if (!seq.uploadSetId || seq.uploadInstance !== client.base || seq.uploadCompleted) {
    const set = await client.createUploadSet(seq.name, pending.length);
    Object.assign(seq, { uploadSetId: set.id, uploadInstance: client.base, uploadCompleted: false });
    await db.putSequence(seq);
  }

  for (const [i, photo] of pending.entries()) {
    const blobs = await db.getBlobs(photo.id);
    if (blobs?.jpeg) {
      await client.uploadFile(seq.uploadSetId, blobs.jpeg, photo.fileName);
      await db.putPhoto({ ...photo, uploaded: true });
    }
    uploads.set(id, (i + 1) / pending.length);
    showProgress();
  }

  await client.completeUploadSet(seq.uploadSetId);
  await db.putSequence({ ...seq, uploadCompleted: true });

  if (settings.deleteAfterUpload) {
    for (const p of await db.photosOf(id)) if (p.uploaded && !p.fileDeleted) await db.dropJpeg(p);
  }
}

/** Renvoie false en cas d'échec. */
async function uploadSequence(id) {
  if (DEMO) {
    toast('Envoi désactivé en mode démo : les photos de démo ne doivent pas partir sur Panoramax.');
    return false;
  }
  if (uploads.has(id)) return true;
  const a = auth.current;
  if (!a) {
    toast(new NotLoggedIn().message);
    return false;
  }
  const client = new Client(a.instance, a.jwt);
  uploads.set(id, 0);
  showProgress();
  try {
    try {
      await sendSequence(id, client);
    } catch (e) {
      if (e.status !== 404) throw e;
      // Upload set supprimé côté serveur : on repart d'un nouveau, une seule fois.
      const seq = await db.getSequence(id);
      await db.putSequence({ ...seq, uploadSetId: null });
      await sendSequence(id, client);
    }
    return true;
  } catch (e) {
    toast(e.status === 401 ? 'Session Panoramax expirée : reconnectez-vous dans les réglages.' : e.message);
    return false;
  } finally {
    uploads.delete(id);
    refresh();
  }
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
  showProgress();
}

/** Re-dessine l'écran courant, sauf la capture (qui redémarrerait la caméra). */
function refresh() {
  if (!location.hash.startsWith('#/capture/')) render();
}

window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') auth.checkPending();
});

// ---------- Écran : liste ----------

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function statusLabel(seq, total, pending) {
  if (!total) return 'vide';
  if (pending) return `${pending} à envoyer`;
  return seq.uploadCompleted ? 'envoyée' : 'à envoyer';
}

async function renderList() {
  const [sequences, photos] = await Promise.all([db.listSequences(), db.allPhotos()]);
  const stats = new Map();
  for (const p of photos) {
    const s = stats.get(p.sequenceId) ?? { total: 0, pending: 0 };
    s.total += 1;
    if (!p.uploaded) s.pending += 1;
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
      ${DEMO ? '<p class="banner">Mode démo : position et caméra simulées, envoi désactivé. Passez en <b>Live</b> pour utiliser la caméra, le GPS et l’envoi sur Panoramax.</p>' : ''}
      ${DEMO && !demoData.isSeeded() ? '<p class="banner subtle" id="demo-seed">Téléchargement d’une séquence d’exemple depuis Panoramax…</p>' : ''}
      ${isIOS() && !isStandalone() && !DEMO ? '<p class="banner">Pour garder vos photos, ajoutez Arpent à l’écran d’accueil : <b>Partager → Sur l’écran d’accueil</b>.</p>' : ''}
      ${!auth.current && !DEMO ? '<p class="banner subtle">Pas encore connecté à Panoramax : <a href="#/settings">se connecter</a> (nécessaire seulement pour l’envoi).</p>' : ''}
      ${sequences.length ? `<ul class="sequences">${sequences.map((seq) => {
        const s = stats.get(seq.id) ?? { total: 0, pending: 0 };
        return `<li><a href="#/seq/${seq.id}">
          <span class="name">${esc(seq.name)}</span>
          <span class="meta">${s.total} photo${s.total > 1 ? 's' : ''} · <span class="${s.pending ? 'pending' : 'done'}">${statusLabel(seq, s.total, s.pending)}</span></span>
          <progress data-progress="${seq.id}" max="1" hidden></progress>
        </a></li>`;
      }).join('')}</ul>` : `<div class="empty">
          <p><b>Aucune séquence.</b></p>
          <p>Démarrez une séquence, activez le mode auto et marchez : une photo est prise régulièrement, seulement quand vous avancez.</p>
        </div>`}
    </main>
    <footer class="actions">
      ${anyPending ? '<button class="secondary" id="sendAll" data-upload-btn>Tout envoyer</button>' : ''}
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
    location.hash = `#/capture/${seq.id}`;
  };
  if (DEMO && !demoData.isSeeded()) seedDemoSequence();
  const sendAll = document.getElementById('sendAll');
  if (sendAll) {
    sendAll.onclick = async () => {
      for (const seq of sequences) {
        if ((stats.get(seq.id)?.pending ?? 0) > 0 && !(await uploadSequence(seq.id))) break;
      }
    };
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

async function renderCapture(id) {
  const seq = await db.getSequence(id);
  if (!seq) { location.hash = '#/'; return null; }
  const existing = await db.photosOf(id);

  app.innerHTML = `
    <div class="capture">
      <video playsinline muted autoplay></video>
      <div class="flash"></div>
      <div class="top">
        ${modeBadge()}
        <span class="gps none">GPS…</span>
        <span class="count"></span>
        <button class="pill" id="close">Terminer</button>
      </div>
      <p class="msg" hidden></p>
      <div class="bottom">
        <button class="auto" id="auto">Auto</button>
        <button class="shutter" id="shutter" aria-label="Prendre une photo"></button>
        <span class="res"></span>
      </div>
    </div>`;

  const $ = (s) => app.querySelector(s);
  const video = $('video');
  const camera = new CameraService(video);
  const location_ = new LocationService();
  const compass = new CompassService();

  let count = existing.length;
  let isAuto = false, capturing = false, timer = null, closed = false;
  const last = existing.at(-1);
  let lastShot = last ? { latitude: last.latitude, longitude: last.longitude } : null;

  const setMessage = (m) => { $('.msg').textContent = m ?? ''; $('.msg').hidden = !m; };
  const updateCount = () => { $('.count').textContent = `${count} photo${count > 1 ? 's' : ''}`; };
  updateCount();

  function usablePosition() {
    const p = location_.position;
    if (!p || p.accuracy > settings.maxAccuracy || Date.now() - p.timestamp > 10_000) return null;
    return p;
  }

  location_.onchange = () => {
    const p = location_.position;
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
        heading: heading?.value ?? null, capturedAt: date.getTime(), uploaded: false, fileDeleted: false,
      }, file, thumb);
      lastShot = pos;
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
  function tick() {
    if (!isAuto || capturing) return;
    const pos = usablePosition();
    if (!pos) return;
    if (lastShot && distance(lastShot, pos) < settings.minDistance) return; // immobile
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

  location_.start();
  compass.start();
  keepAwake(true);
  camera.start()
    .then(() => { if (!closed) $('.res').textContent = camera.resolution; })
    .catch((e) => setMessage(`Caméra indisponible : ${e.message}`));

  return () => {
    closed = true;
    clearInterval(timer);
    camera.stop();
    location_.stop();
    compass.stop();
    keepAwake(false);
  };
}

// ---------- Écran : détail d'une séquence ----------

function trackSVG(photos) {
  if (!photos.length) return '';
  const lat0 = photos.reduce((s, p) => s + p.latitude, 0) / photos.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = photos.map((p) => [p.longitude * k, p.latitude]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 320, H = 160, P = 14;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const s = Math.min((W - 2 * P) / Math.max(maxX - minX, span * 0.01), (H - 2 * P) / Math.max(maxY - minY, span * 0.01));
  const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
  const xy = pts.map(([x, y]) => [ox + (x - minX) * s, H - (oy + (y - minY) * s)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [sx, sy] = xy[0], [ex, ey] = xy.at(-1);
  return `<svg class="track" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tracé du parcours">
    <polyline points="${line}" />
    <circle cx="${sx}" cy="${sy}" r="5" class="start" />
    <circle cx="${ex}" cy="${ey}" r="5" class="end" />
  </svg>`;
}

async function renderDetail(id) {
  const seq = await db.getSequence(id);
  if (!seq) { location.hash = '#/'; return; }
  const photos = await db.photosOf(id);
  const pending = photos.filter((p) => !p.uploaded).length;
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
      ${trackSVG(photos)}
      <p class="meta">${photos.length} photo${photos.length > 1 ? 's' : ''} · ${(meters / 1000).toFixed(2)} km · ${minutes} min ·
        <span class="${pending ? 'pending' : 'done'}">${statusLabel(seq, photos.length, pending)}</span></p>
      <progress data-progress="${id}" max="1" hidden></progress>
      ${seq.source ? `<p class="hint">Photos : ${esc(seq.source.author)}, licence <a href="${esc(seq.source.licenseURL)}" target="_blank" rel="noopener">${esc(seq.source.license)}</a>, <a href="${esc(seq.source.url)}" target="_blank" rel="noopener">voir sur Panoramax</a>.</p>` : ''}
      <div class="grid">${photos.map((p) => `<button class="thumb ${p.uploaded ? 'uploaded' : ''}" data-id="${p.id}" aria-label="Photo ${esc(p.fileName)}"></button>`).join('')}</div>
    </main>
    <footer class="actions">
      <button class="danger" id="delete">Supprimer</button>
      <button class="secondary" id="resume">Reprendre</button>
      ${pending ? '<button class="primary" id="send" data-upload-btn>Envoyer</button>' : ''}
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
  cleanup = () => { io.disconnect(); urls.forEach(URL.revokeObjectURL); };

  app.querySelector('#name').onchange = async (e) => {
    const name = e.target.value.trim();
    if (name) await db.putSequence({ ...(await db.getSequence(id)), name });
  };
  app.querySelector('#resume').onclick = () => {
    requestCompassPermission();
    location.hash = `#/capture/${id}`;
  };
  app.querySelector('#delete').onclick = async () => {
    if (!confirm(`Supprimer « ${seq.name} » et ses ${photos.length} photos de ce téléphone ?`)) return;
    await db.deleteSequence(id);
    location.hash = '#/';
  };
  const send = app.querySelector('#send');
  if (send) send.onclick = () => uploadSequence(id);

  app.querySelector('.grid').onclick = (e) => {
    const btn = e.target.closest('.thumb');
    if (btn) openViewer(photos.find((p) => p.id === btn.dataset.id));
  };
}

async function openViewer(photo) {
  const b = await db.getBlobs(photo.id);
  const url = URL.createObjectURL(b?.jpeg ?? b?.thumb ?? new Blob());
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <img src="${url}" alt="">
    <div class="info">
      <span>${new Date(photo.capturedAt).toLocaleString('fr-FR')} · ±${Math.round(photo.accuracy)} m${photo.heading != null ? ` · cap ${Math.round(photo.heading)}°` : ''}${photo.uploaded ? ' · envoyée' : ''}${photo.fileDeleted ? ' (fichier supprimé du téléphone)' : ''}</span>
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
      </section>
      <section>
        <h2>Mode auto</h2>
        <label>Intervalle (s)<input id="interval" type="number" min="0.5" step="0.5" value="${settings.interval}"></label>
        <label>Distance minimale (m)<input id="minDistance" type="number" min="0" step="1" value="${settings.minDistance}"></label>
        <label>Précision GPS maximale (m)<input id="maxAccuracy" type="number" min="1" step="1" value="${settings.maxAccuracy}"></label>
      </section>
      <section>
        <h2>Stockage</h2>
        <label class="check"><input id="deleteAfterUpload" type="checkbox" ${settings.deleteAfterUpload ? 'checked' : ''}>Supprimer les photos du téléphone après envoi</label>
        ${estimate ? `<p class="hint">Utilisé : ${mb(estimate.usage)} sur ${mb(estimate.quota)} disponibles${persisted ? ' · stockage persistant' : ''}.</p>` : ''}
      </section>
      <section>
        <h2>À propos</h2>
        <p class="hint">Arpent Web, prototype. Mode actuel : ${DEMO ? 'démo (position et caméra simulées)' : 'live'}, modifiable en haut de la liste des séquences.</p>
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
  for (const key of ['interval', 'minDistance', 'maxAccuracy']) {
    $(`#${key}`).onchange = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 0) { settings[key] = v; settings.save(); } else e.target.value = settings[key];
    };
  }
  $('#deleteAfterUpload').onchange = (e) => { settings.deleteAfterUpload = e.target.checked; settings.save(); };
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

const ICON_GEAR = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.4h-4L10.7 6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';

// ---------- Démarrage ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
auth.checkPending();
render();

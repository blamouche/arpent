// Capteurs : GPS, boussole, caméra, écran allumé.
// Mode démo (par défaut) : position simulée qui marche avec des arrêts, caméra remplacée par une mire.
// Mode live : vrais capteurs. Le choix est gardé sur l'appareil ; ?demo ou ?live dans l'URL le force.

const MODE_KEY = 'arpent.mode';

function initialMode() {
  const params = new URLSearchParams(location.search);
  const forced = params.has('live') ? 'live' : params.has('demo') ? 'demo' : null;
  try {
    if (forced) localStorage.setItem(MODE_KEY, forced);
    return forced ?? (localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'demo');
  } catch {
    return forced ?? 'demo';
  }
}

export const DEMO = initialMode() === 'demo';

/** Change de mode : capteurs et base de données changent, donc on recharge sur la liste. */
export function setMode(demo) {
  try { localStorage.setItem(MODE_KEY, demo ? 'demo' : 'live'); } catch { /* stockage indisponible */ }
  history.replaceState(null, '', `${location.pathname}#/`);
  location.reload();
}

// ---------- Position ----------

export class LocationService {
  position = null; // { latitude, longitude, altitude, accuracy, speed, course, timestamp }
  error = null;
  #watch = null;
  #demoTimer = null;
  onchange = () => {};

  start() {
    if (DEMO) return this.#startDemo();
    if (!('geolocation' in navigator)) {
      this.error = 'Géolocalisation indisponible sur ce navigateur.';
      return;
    }
    this.#watch = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        this.position = {
          latitude: c.latitude,
          longitude: c.longitude,
          altitude: c.altitude ?? undefined,
          accuracy: c.accuracy,
          speed: c.speed ?? undefined,
          course: Number.isFinite(c.heading) ? c.heading : undefined,
          timestamp: p.timestamp,
        };
        this.error = null;
        this.onchange();
      },
      (e) => {
        this.error = e.code === e.PERMISSION_DENIED
          ? 'Accès à la position refusé : autorisez-le dans les réglages du navigateur.'
          : null; // erreurs transitoires : on attend la prochaine mise à jour
        this.onchange();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.#watch != null) navigator.geolocation.clearWatch(this.#watch);
    clearInterval(this.#demoTimer);
    this.#watch = this.#demoTimer = null;
  }

  /** Marche à 1,4 m/s vers le nord-est, avec une pause de 6 s toutes les 20 s. */
  #startDemo() {
    let lat = 48.8566, lon = 2.3522, t = 0;
    const course = 60;
    this.#demoTimer = setInterval(() => {
      t += 1;
      const moving = t % 20 < 14;
      const speed = moving ? 1.4 : 0;
      const rad = (course * Math.PI) / 180;
      lat += (speed * Math.cos(rad)) / 111_320;
      lon += (speed * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
      this.position = {
        latitude: lat, longitude: lon, altitude: 35, accuracy: 4 + Math.random() * 4,
        speed, course: moving ? course : undefined, timestamp: Date.now(),
      };
      this.onchange();
    }, 1000);
  }
}

/** Distance en mètres (haversine). */
export function distance(a, b) {
  const R = 6_371_000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Boussole ----------

/** Doit être appelé pendant un geste de l'utilisateur (exigence iOS). */
export function requestCompassPermission() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') {
    return D.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

/** Cap de la caméra arrière (axe -Z de l'appareil) à partir des angles absolus (W3C, Android). */
function headingFromEuler(alpha, beta, gamma) {
  const r = Math.PI / 180;
  const [a, b, g] = [alpha * r, beta * r, gamma * r];
  const east = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const north = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  return ((Math.atan2(east, north) / r) + 360) % 360;
}

/**
 * Orientation physique du téléphone d'après la gravité (beta, gamma), indépendante du
 * verrouillage de rotation de l'écran. « landscape-left » : haut du téléphone à gauche.
 */
export function physicalOrientation(beta, gamma) {
  const r = Math.PI / 180, b = beta * r, g = gamma * r;
  // Direction « vers le haut » exprimée dans le repère de l'appareil.
  const x = -Math.cos(b) * Math.sin(g), y = Math.sin(b), z = Math.cos(b) * Math.cos(g);
  const [ax, ay, az] = [Math.abs(x), Math.abs(y), Math.abs(z)];
  if (az > ax && az > ay) return 'flat';
  if (ax > ay) return x > 0 ? 'landscape-left' : 'landscape-right';
  return y > 0 ? 'portrait' : 'portrait-inverse';
}

/**
 * iOS : webkitCompassHeading donne la direction du haut de l'appareil. Téléphone debout en
 * portrait, iOS la ramène vers le dos ; en paysage, le haut pointe sur le côté, à ±90° de la
 * caméra. On corrige pour obtenir la direction du dos (caméra arrière).
 */
export function cameraHeadingFromIOS(compassHeading, orientation) {
  const fix = orientation === 'landscape-left' ? 90 : orientation === 'landscape-right' ? -90 : 0;
  return (compassHeading + fix + 360) % 360;
}

/**
 * Inclinaison de la caméra arrière par rapport à l'horizon, en degrés, d'après la gravité :
 * 0 = vers l'horizon, positif = vers le ciel, négatif = vers le sol (-90 : téléphone à plat,
 * écran vers le haut). Valable en portrait comme en paysage.
 */
export function cameraPitch(beta, gamma) {
  const r = Math.PI / 180;
  const sinElevation = -Math.cos(beta * r) * Math.cos(gamma * r); // -Z de l'appareil · verticale
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / r;
}

/** Libellé court d'une inclinaison : « 12° vers le sol », « horizontale ». */
export function pitchLabel(pitch) {
  const a = Math.round(Math.abs(pitch));
  if (a < 3) return 'horizontale';
  return `${a}° vers ${pitch > 0 ? 'le ciel' : 'le sol'}`;
}

const ORIENTATION_LABELS = {
  portrait: 'portrait',
  'portrait-inverse': 'portrait inversé',
  'landscape-left': 'paysage',
  'landscape-right': 'paysage',
  flat: 'à plat',
};

export class CompassService {
  heading = null;
  orientation = null; // portrait, landscape-left, landscape-right, portrait-inverse, flat
  #pitch = null;
  #pitchAt = 0;
  #at = 0;
  #demoStart = Date.now();
  #handler = (e) => {
    if (e.beta != null && e.gamma != null) {
      this.orientation = physicalOrientation(e.beta, e.gamma);
      this.#pitch = cameraPitch(e.beta, e.gamma);
      this.#pitchAt = Date.now();
    }
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      this.heading = cameraHeadingFromIOS(e.webkitCompassHeading, this.orientation); // iOS
    } else if (e.absolute && e.alpha != null && e.beta != null && e.gamma != null) {
      this.heading = headingFromEuler(e.alpha, e.beta, e.gamma); // Android
    } else {
      return;
    }
    this.#at = Date.now();
  };

  start() {
    window.addEventListener('deviceorientationabsolute', this.#handler);
    window.addEventListener('deviceorientation', this.#handler);
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this.#handler);
    window.removeEventListener('deviceorientation', this.#handler);
  }

  /** Cap boussole récent (dos du téléphone), sinon direction du déplacement, sinon null. */
  best(position) {
    if (this.heading != null && Date.now() - this.#at < 2000) return { value: this.heading, ref: 'M', source: 'compass' };
    if (position?.course != null && position.speed > 0.5) return { value: position.course, ref: 'T', source: 'gps' };
    return null;
  }

  /**
   * Inclinaison actuelle de la caméra (degrés), ou null si inconnue. En démo, sans capteur,
   * elle est simulée : tenue droite, avec de temps en temps un regard vers les pieds ou le ciel.
   */
  get pitch() {
    if (this.#pitch != null && Date.now() - this.#pitchAt < 2000) return this.#pitch;
    if (!DEMO) return null;
    const t = (Date.now() - this.#demoStart) / 1000;
    const cycle = Math.floor(t / 40), inCycle = t % 40;
    if (inCycle >= 26 && inCycle < 32) return cycle % 2 ? 48 : -58;
    return 4 * Math.sin(t / 3) - 2;
  }

  /** Libellé de l'orientation de prise : capteurs si disponibles, sinon forme de l'écran. */
  get orientationLabel() {
    if (this.orientation) return ORIENTATION_LABELS[this.orientation];
    return matchMedia('(orientation: landscape)').matches ? 'paysage' : 'portrait';
  }
}

// ---------- Caméra ----------

export class CameraService {
  stream = null;
  #frame = document.createElement('canvas');
  #thumb = document.createElement('canvas');
  #demoTimer = null;

  constructor(video) {
    this.video = video;
  }

  async start() {
    this.stream = DEMO ? this.#demoStream() : await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    clearInterval(this.#demoTimer);
  }

  get resolution() {
    return `${this.video.videoWidth}×${this.video.videoHeight}`;
  }

  /** Image du flux vidéo en JPEG + vignette. Les canvas sont réutilisés (mémoire limitée sur iOS). */
  async capture() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) throw new Error('Caméra pas encore prête.');
    this.#frame.width = w;
    this.#frame.height = h;
    this.#frame.getContext('2d').drawImage(this.video, 0, 0, w, h);
    const jpeg = await toBlob(this.#frame, 0.92);

    const tw = 240, th = Math.round((h / w) * tw);
    this.#thumb.width = tw;
    this.#thumb.height = th;
    this.#thumb.getContext('2d').drawImage(this.#frame, 0, 0, tw, th);
    const thumb = await toBlob(this.#thumb, 0.7);
    return { jpeg, thumb };
  }

  #demoStream() {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1200;
    const ctx = c.getContext('2d');
    let hue = 0;
    const draw = () => {
      hue = (hue + 2) % 360;
      const g = ctx.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, `hsl(${hue} 60% 45%)`);
      g.addColorStop(1, `hsl(${(hue + 120) % 360} 60% 30%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.fillText('Arpent — démo', 80, 200);
      ctx.font = '64px ui-monospace, monospace';
      ctx.fillText(new Date().toLocaleTimeString('fr-FR'), 80, 320);
    };
    draw();
    this.#demoTimer = setInterval(draw, 100);
    return c.captureStream(15);
  }
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage JPEG impossible.'))), 'image/jpeg', quality));
}

// ---------- Écran allumé ----------

let wakeLock = null;
let wantAwake = false;

export async function keepAwake(on) {
  wantAwake = on;
  if (on && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* refusé (batterie faible, onglet masqué…) */ }
  } else if (!on && wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantAwake) keepAwake(true);
});

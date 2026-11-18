// Client minimal de l'API Panoramax (routes utilisées : voir docs/API-PANORAMAX.md).
// L'API autorise les appels depuis un navigateur (CORS), aucun serveur intermédiaire n'est nécessaire.

export class APIError extends Error {
  constructor(status, message) {
    super(message ? `Erreur serveur (${status}) : ${message}` : `Erreur serveur (${status}).`);
    this.status = status;
  }
}

export class NotLoggedIn extends Error {
  constructor() {
    super('Connectez-vous à Panoramax dans les réglages.');
  }
}

export class AbortError extends Error {
  name = 'AbortError';
  constructor() {
    super('Envoi arrêté.');
  }
}

/** URL d'instance normalisée (https par défaut, sans slash final), ou null. */
export function normalizeInstance(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  try {
    return new URL(s).toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function errorMessage(response) {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      if (typeof json.message === 'string') return json.message;
    } catch { /* pas du JSON */ }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

export class Client {
  constructor(baseURL, token) {
    this.base = baseURL;
    this.token = token;
  }

  url(path) {
    return `${this.base}/${path}`;
  }

  headers(extra = {}) {
    if (!this.token) throw new NotLoggedIn();
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...extra };
  }

  async json(path, init = {}) {
    const response = await fetch(this.url(path), init);
    if (!response.ok) throw new APIError(response.status, await errorMessage(response));
    return response.json();
  }

  /** Jeton inutilisable tant qu'il n'est pas « réclamé » dans le navigateur. */
  async generateToken(description = 'Arpent Web') {
    const r = await this.json(`api/auth/tokens/generate?description=${encodeURIComponent(description)}`, { method: 'POST' });
    const claim = r.links?.find((l) => l.rel === 'claim')?.href;
    if (!r.jwt_token || !claim) throw new Error('Réponse inattendue du serveur.');
    return { jwt: r.jwt_token, claimURL: new URL(claim, this.base + '/').toString() };
  }

  me() {
    return this.json('api/users/me', { headers: this.headers() });
  }

  /**
   * visibility : `owner-only` pour un envoi privé (test), sinon visibilité par défaut du compte.
   * semantics : [{ key, value }], tags recopiés par le serveur sur toutes les séquences créées.
   */
  createUploadSet(title, estimatedFiles, visibility = null, semantics = []) {
    return this.json('api/upload_sets', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        title, estimated_nb_files: estimatedFiles, sort_method: 'time-asc',
        ...(visibility ? { visibility } : {}),
        ...(semantics.length ? { semantics } : {}),
      }),
    });
  }

  /**
   * Un 409 (photo déjà envoyée) compte comme un succès. XHR plutôt que fetch : seul XHR donne
   * l'avancement de l'envoi (onProgress reçoit 0…1). signal permet d'interrompre.
   */
  uploadFile(uploadSetId, blob, fileName, { onProgress, signal } = {}) {
    const headers = this.headers();
    const form = new FormData();
    form.append('file', blob, fileName);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortError());
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url(`api/upload_sets/${uploadSetId}/files`));
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) return resolve();
        let message = xhr.responseText.slice(0, 200);
        try { const j = JSON.parse(xhr.responseText); if (typeof j.message === 'string') message = j.message; } catch { /* pas du JSON */ }
        reject(new APIError(xhr.status, message));
      };
      xhr.onerror = () => reject(new Error('Connexion perdue pendant l’envoi.'));
      xhr.onabort = () => reject(new AbortError());
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  }

  completeUploadSet(uploadSetId) {
    return this.json(`api/upload_sets/${uploadSetId}/complete`, { method: 'POST', headers: this.headers() });
  }

  /** État d'un upload set, dont `associated_collections` (séquences créées par le serveur). */
  getUploadSet(uploadSetId) {
    const headers = this.token ? this.headers() : { Accept: 'application/json' };
    return this.json(`api/upload_sets/${uploadSetId}`, { headers });
  }
}

/** Page publique d'une séquence sur le site de l'instance. */
export const sequencePageURL = (instance, collectionId) => `${instance}/sequence/${collectionId}`;

/**
 * Mode démo : mêmes méthodes que Client, sans aucun appel réseau. Simule le délai et un débit
 * d'environ 600 ko/s pour montrer le déroulé de l'envoi. Rien ne part sur Panoramax.
 */
export class SimulatedClient {
  base = 'demo';

  async createUploadSet() {
    await wait(700);
    return { id: `demo-${Date.now()}` };
  }

  async uploadFile(_set, blob, _name, { onProgress, signal } = {}) {
    const total = Math.max(blob.size, 50_000);
    let sent = 0;
    await wait(150, signal);
    while (sent < total) {
      await wait(100, signal);
      sent = Math.min(total, sent + 60_000 * (0.6 + Math.random() * 0.8));
      onProgress?.(sent / total);
    }
  }

  async completeUploadSet() {
    await wait(900);
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AbortError()); }, { once: true });
  });
}

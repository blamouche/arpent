// Client minimal de l'API Panoramax (mêmes routes qu'Arpent iOS, voir docs/API-PANORAMAX.md).
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

  createUploadSet(title, estimatedFiles) {
    return this.json('api/upload_sets', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, estimated_nb_files: estimatedFiles, sort_method: 'time-asc' }),
    });
  }

  /** Un 409 (photo déjà envoyée) compte comme un succès. */
  async uploadFile(uploadSetId, blob, fileName) {
    const form = new FormData();
    form.append('file', blob, fileName);
    const response = await fetch(this.url(`api/upload_sets/${uploadSetId}/files`), {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (response.ok || response.status === 409) return;
    throw new APIError(response.status, await errorMessage(response));
  }

  completeUploadSet(uploadSetId) {
    return this.json(`api/upload_sets/${uploadSetId}/complete`, { method: 'POST', headers: this.headers() });
  }
}

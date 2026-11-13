# Notes API Panoramax utilisées par Arpent

Source : spécification OpenAPI d'une instance (`/api/docs/specs.json`), version 2.17, consultée le 13/11/2026.
Swagger de chaque instance : `https://<instance>/api/docs/swagger`.

Toutes les routes protégées acceptent `Authorization: Bearer <JWT>`.

## Authentification

| Étape | Requête | Réponse |
|---|---|---|
| Générer un jeton | `POST /api/auth/tokens/generate?description=Arpent iOS` | `{ id, jwt_token, links: [{rel: "claim", href}] }`. Le jeton est inutilisable tant qu'il n'est pas réclamé. |
| Réclamer le jeton (navigateur) | `GET /api/auth/tokens/{id}/claim?next_url=arpent://auth-done` | Connexion de l'utilisateur, puis redirection vers `next_url` (ou 200). |
| Vérifier | `GET /api/users/me` | `{ id, name, links, tos_accepted, … }` |
| Révoquer | `DELETE /api/users/me/tokens/{id}` | — (non utilisé : la déconnexion oublie seulement le jeton localement) |

Alternative (non utilisée) : `POST /api/users/me/tokens` crée un jeton directement utilisable, mais demande déjà une session authentifiée.

## Upload

### 1. Créer l'upload set
`POST /api/upload_sets` en JSON :
```json
{ "title": "Séquence du 13 nov. 2026", "estimated_nb_files": 42, "sort_method": "time-asc" }
```
Arpent Web envoie `"visibility": "owner-only"` quand l'option *Envoi privé (test)* est cochée ; sinon le champ est omis (visibilité par défaut du compte). Les valeurs acceptées par une instance sont dans `GET /api/configuration` → `visibility.possible_values` (OSM France : `anyone`, `owner-only`).

Champs optionnels utiles : `split_distance`, `split_time`, `no_split`, `duplicate_distance`, `duplicate_rotation`, `no_deduplication`, `relative_heading` (0 = vers l'avant, -90 = gauche, 90 = droite), `visibility` (`anyone`, `logged-only`, `owner-only`), `semantics`, `metadata`.
Réponse 200 : `{ id, completed, dispatched, ready, nb_items, links, … }`.

### 2. Envoyer les fichiers
`POST /api/upload_sets/{id}/files` en `multipart/form-data` :
- `file` (obligatoire) : le JPEG ;
- options : `isBlurred`, `override_capture_time`, `override_latitude`, `override_longitude`, `override_Exif.*` (balises exiv2), `annotations`.

| Code | Sens | Traitement Arpent |
|---|---|---|
| 202 | Accepté | `uploaded = true` |
| 400 | Requête invalide | erreur affichée |
| 401 / 403 | Non connecté / non autorisé (ou CGU non acceptées) | erreur affichée |
| 404 | Upload set inexistant | nouvel upload set, un seul nouvel essai |
| 409 | Photo déjà envoyée | traité comme un succès |
| 415 | Pas en multipart | — |

Les noms de fichiers doivent être uniques dans un upload set.

### 3. Terminer
`POST /api/upload_sets/{id}/complete`. Sans cet appel, les photos ne deviennent pas publiques.

### 4. Suivi (pas encore dans l'UI)
- `GET /api/upload_sets/{id}` → `ready`, `items_status`, `associated_collections`
- `GET /api/upload_sets/{id}/files` → statut par fichier, champ `rejected` avec la raison
- `GET /api/users/me/upload_sets`

## Métadonnées lues par Panoramax (posées par Arpent)

| EXIF | Contenu |
|---|---|
| `GPSLatitude` / `GPSLatitudeRef`, `GPSLongitude` / `GPSLongitudeRef` | position |
| `GPSAltitude` / `GPSAltitudeRef` | altitude (si connue) |
| `GPSHPositioningError` | précision horizontale (m) |
| `GPSImgDirection` / `GPSImgDirectionRef = T` | cap de prise de vue (nord vrai) |
| `GPSSpeed` (km/h), `GPSTrack` | vitesse et direction du déplacement |
| `GPSDateStamp` / `GPSTimeStamp` | horodatage UTC |
| `DateTimeOriginal` + `SubsecTimeOriginal` + `OffsetTimeOriginal` | date locale avec millisecondes et fuseau |
| `Make` / `Model` | posés par iOS (Apple / iPhone …) |

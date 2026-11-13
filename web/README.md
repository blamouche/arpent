# Arpent Web (prototype)

Version web (PWA) d'Arpent : on ouvre une URL sur iPhone ou Android, on capture une séquence, puis on l'envoie sur Panoramax. Même parcours et mêmes règles que l'app iOS, sans App Store.

- HTML/CSS/JS statiques, **aucune dépendance**, aucun build, aucun serveur à soi : l'API Panoramax accepte les appels depuis un navigateur (CORS).
- Mode auto temps + distance, déclencheur manuel, indicateur GPS, écran maintenu allumé.
- EXIF complet écrit dans le JPEG (GPS, altitude, précision, cap, vitesse, date avec millisecondes et fuseau).
- Photos stockées sur le téléphone (IndexedDB), l'app s'ouvre hors ligne (service worker).
- Connexion par « jeton réclamé » sur le site de l'instance, envoi reprenable.

## Lancer en local

```bash
python3 -m http.server 8137 --directory web
```

Puis ouvrir <http://localhost:8137/?demo> : en **mode démo**, la position (marche avec des arrêts) et la caméra (mire) sont simulées, les données vont dans une base séparée et l'envoi est bloqué.

## Tester sur un téléphone

Version en ligne : <https://blamouche.github.io/arpent/> (démo : <https://blamouche.github.io/arpent/?demo>), publiée automatiquement depuis `web/` à chaque push sur `main`.

La caméra et le GPS exigent **HTTPS**. Deux options :

- **Hébergement statique** (GitHub Pages, Netlify, Cloudflare Pages…) : publier le dossier `web/` tel quel.
- **Tunnel** vers le serveur local, par exemple `cloudflared tunnel --url http://localhost:8137`, puis ouvrir l'URL https affichée sur le téléphone.

Sur iPhone, **ajouter à l'écran d'accueil** (Partager → Sur l'écran d'accueil) : sinon Safari peut effacer les photos après 7 jours sans visite.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | page unique, 4 écrans (liste, capture, détail, réglages) |
| `app.js` | écrans, réglages, connexion, envoi reprenable |
| `sensors.js` | GPS, boussole, caméra, écran allumé, mode démo |
| `exif.js` | segment EXIF/GPS inséré dans le JPEG sans recompression |
| `db.js` | IndexedDB : séquences, métadonnées des photos, images |
| `panoramax.js` | client API (routes identiques à l'app iOS) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA installable et hors ligne |

## Ce qui a été vérifié

- Capture auto en mode démo : une photo toutes les ~4 s en marche, aucune pendant les arrêts.
- EXIF relu avec Pillow : position, altitude, précision, cap, vitesse, dates UTC et locale avec millisecondes.
- Connexion et envoi contre un faux serveur Panoramax local (appels cross-origin) : panne au 3e fichier, puis reprise sur le même upload set avec seulement les photos manquantes, puis `complete`.
- En-têtes CORS de `panoramax.openstreetmap.fr` (préflight `POST` avec `Authorization`).

**Pas encore testé** : sur un vrai iPhone / Android (caméra réelle, boussole, wake lock), et la connexion + l'envoi sur une vraie instance Panoramax.

## Limites connues

- **Qualité photo** : l'image vient du flux vidéo de la caméra (souvent 1920×1080 à 4K), sans le traitement photo natif. La résolution obtenue s'affiche en bas à droite de l'écran de capture. Piste Android : `ImageCapture.takePhoto()` (pleine résolution), à condition de gérer l'orientation.
- **Orientation** : l'image suit l'orientation de l'écran. En paysage, désactiver le verrouillage de rotation.
- **Cap** : boussole magnétique (`GPSImgDirectionRef = M`), sinon direction du déplacement. Sur iPhone, l'accès à la boussole est demandé au démarrage d'une séquence.
- **Premier plan** : écran verrouillé ou autre app, la capture et l'envoi s'arrêtent (comme la v0.1 iOS).
- **Redirection après connexion** : si l'instance refuse `next_url`, revenir manuellement dans Arpent puis toucher « J'ai terminé, vérifier » dans les réglages.

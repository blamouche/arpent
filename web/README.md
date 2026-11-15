# Arpent Web : notes techniques

La présentation complète (fonctionnalités, captures d'écran, réglages, utilisation) est dans le [README du projet](../README.md). Cette page rassemble les détails d'implémentation.

## Lancer

```bash
python3 -m http.server 8137 --directory web
```

Puis ouvrir <http://localhost:8137/>. Sans build, sans dépendance : il n'y a rien à installer.

## Choix techniques

- **Aucun serveur à soi** : l'API Panoramax accepte les appels cross-origin (CORS), y compris le préflight `POST` avec `Authorization`.
- **Envoi avec progression** : `XMLHttpRequest` plutôt que `fetch`, seul moyen d'avoir l'avancement d'un envoi (`upload.onprogress`). Un `409` (photo déjà reçue) compte comme un succès, ce qui rend l'envoi reprenable.
- **Upload set** :
  - un nouveau est créé si l'instance ou la visibilité change, ou si le précédent est terminé ;
  - un `404` (upload set supprimé côté serveur) en recrée un, une seule fois.
- **Cap** :
  - Android : l'événement `deviceorientationabsolute` donne les angles, et l'app calcule directement la direction de l'axe −Z de l'appareil (le dos) ;
  - iPhone : `webkitCompassHeading` n'est sans ambiguïté que téléphone droit en portrait (direction du dos). Dans cette position, Arpent mesure le décalage entre ce cap et le cap gyroscopique tiré de `alpha`, `beta`, `gamma` (référence arbitraire sur iOS), puis utilise gyroscope + décalage dans toutes les positions. Le décalage est lissé et remesuré à chaque passage en portrait.
  - iPhone, avant tout passage en portrait : `webkitCompassHeading` corrigé de ±90° en paysage selon l'orientation physique (gravité), moins la rotation de l'écran (`window.orientation`), au cas où iOS l'aurait déjà compensée.
  - Diagnostic : toucher la pastille de cap dans la vue caméra affiche les valeurs brutes (cap iOS, cap gyroscopique et décalage, beta, gamma, rotation de l'écran, méthode).
- **Inclinaison de la caméra** : `asin(−cos β · cos γ)`, en degrés au-dessus de l'horizon. Elle vaut pour le portrait comme pour le paysage et est enregistrée avec chaque photo (`pitch`). Les avertissements sont calculés à l'affichage selon les seuils du moment.
- **Écran allumé** :
  - l'API Wake Lock en premier, redemandée si le verrou est relâché et au retour au premier plan ;
  - en secours, `vendor/keep-awake.mp4` (vidéo noire de 64×64 px, 2 s, muette) jouée en boucle et invisible.
- **Cartes** : MapLibre GL JS 4.7.1, embarqué pour fonctionner hors ligne, avec les styles OpenFreeMap `positron` et `dark` (sans clé, sans points d'intérêt).
  - **Détail d'une séquence** : une carte interactive.
  - **Vue caméra** : une mini-carte non interactive, qui ne pousse à la carte que ce qui a changé.
  - **Liste** : une seule carte hors écran (`preserveDrawingBuffer`) dessine les vignettes une à une en JPEG.
    - Le cache est dans `localStorage` (`arpent.mapThumbs`, 60 séquences au plus).
    - La clé est le nombre de photos, la dernière photo, le thème et la couleur.
    - En attendant, la trace s'affiche seule en SVG.
- **Stockage** : IndexedDB, avec une base `arpent` (Live) et une base `arpent-demo` (Démo), et trois magasins : `sequences`, `photos` (métadonnées) et `blobs` (JPEG et vignette). « Supprimer après envoi » efface le JPEG et garde la vignette.
- **Réglages** :
  - ils sont dans `localStorage` (`arpent.settings`), avec un numéro de version pour faire évoluer les valeurs par défaut sans écraser un choix de l'utilisateur ;
  - version 2 : suppression après envoi activée par défaut ;
  - version 4 : seuils d'inclinaison à 15°.
- **Démo** :
  - `SimulatedClient` reproduit les méthodes du client Panoramax sans réseau (débit d'environ 600 ko/s) ;
  - la position est une marche simulée à 1,4 m/s, avec une pause de 6 s toutes les 20 s ;
  - l'inclinaison est simulée en l'absence de capteur.
- **Service worker** : le réseau d'abord (pour toujours avoir la dernière version), le cache en secours. Le nom du cache (`arpent-vNN`) change à chaque version publiée.

## Tests manuels utiles

- **Faux serveur Panoramax** : un petit serveur Python local qui répond aux routes `upload_sets`, `files` et `complete` avec des en-têtes CORS. Il suffit pour tester l'envoi, la reprise après panne et l'arrêt. Pointer l'instance des réglages dessus et enregistrer un jeton de test dans `arpent.auth`.
- **Connaître les visibilités acceptées par une instance** : `GET /api/configuration` → `visibility.possible_values` (OSM France : `anyone`, `owner-only`).

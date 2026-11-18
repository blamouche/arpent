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
  - iPhone : `webkitCompassHeading` (mesures sur iPhone) donne la direction du dos téléphone droit en portrait ; en paysage, celle du haut de l'appareil, **même quand l'écran tourne**, et faussée de 5 à 26° ; pendant une rotation, il glisse de l'un à l'autre. Arpent utilise donc le cap gyroscopique tiré de `alpha`, `beta`, `gamma` (référence arbitraire sur iOS), plus un décalage mesuré **uniquement téléphone droit en portrait** (roulis à moins de 10°, caméra à moins de 30° de l'horizon, depuis 0,4 s), puis lissé. En paysage, le gyroscope seul fait foi. Avant le premier recalage, c'est le cap brut (+90° en paysage) qui est affiché, avec la mention « calez en portrait ».
  - Calage sur la direction de marche (option `walkCalibration`, désactivée par défaut), tous téléphones : à chaque position GPS, si la marche est régulière (≥ 1 m/s, précision ≤ 15 m) et droite depuis 4 s (direction GPS et cap stables à 10° près), caméra à moins de 30° de l'horizon, l'écart direction GPS − cap devient un échantillon. Un échantillon à plus de 45° de la correction en cours (60° pour le premier) est ignoré : la caméra ne vise pas dans le sens de la marche. Correction lissée (0,15 par seconde au plus), ajoutée au cap ; le cap est alors enregistré avec la référence `T` (nord géographique) au lieu de `M`. Sur iPhone, la correction repart de zéro au premier calage en portrait, qui change la base du cap.
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
- **Service worker** : le réseau d'abord (pour toujours avoir la dernière version), le cache en secours. La version publiée (`?v=NN`) se change uniquement dans `index.html` : elle est dans l'URL de chaque fichier de l'app, et donne le nom du cache (`arpent-vNN`).

## Tests manuels utiles

- **Faux serveur Panoramax** : un petit serveur Python local qui répond aux routes `upload_sets`, `files` et `complete` avec des en-têtes CORS. Il suffit pour tester l'envoi, la reprise après panne et l'arrêt. Pointer l'instance des réglages dessus et enregistrer un jeton de test dans `arpent.auth`.
- **Connaître les visibilités acceptées par une instance** : `GET /api/configuration` → `visibility.possible_values` (OSM France : `anyone`, `owner-only`).

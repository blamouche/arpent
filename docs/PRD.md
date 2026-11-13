# PRD — Arpent

> Application iOS minimaliste pour capturer des séquences de photos géolocalisées et les publier sur Panoramax.

| | |
|---|---|
| Statut | v0.1 — MVP en développement |
| Plateforme | iPhone, iOS 17+ |
| Référence | [Baba](https://wiki.openstreetmap.org/wiki/Baba) (Android) |
| Dernière mise à jour | 13/11/2026 |

## 1. Contexte et problème

[Panoramax](https://panoramax.fr) est la base libre et décentralisée de photos de terrain (type « street view ») utilisée notamment par la communauté OpenStreetMap. Pour y contribuer, il faut des photos **géolocalisées, horodatées et prises en séquence** le long d'un parcours.

Sur Android, l'app **Baba** permet de le faire simplement. Sur iPhone, les contributeurs n'ont pas d'équivalent simple :
- l'appareil photo natif ne prend pas de photos en rafale espacées selon le déplacement ;
- il faut ensuite trier et exporter les photos, puis passer par le site web ou l'outil en ligne de commande pour les envoyer.

## 2. Objectif

Permettre à un contributeur iPhone de **marcher (ou rouler) avec son téléphone, photographier son parcours automatiquement, puis envoyer la séquence sur Panoramax en un geste**.

Principe directeur : **la plus simple possible**. Chaque fonctionnalité doit être justifiée par le parcours principal.

## 3. Utilisateurs cibles

- **Contributeur OSM / Panoramax** : à pied ou à vélo, il veut documenter une rue, un sentier ou une piste cyclable.
- **Agent de collectivité** : il fait des relevés de terrain ponctuels et publie sur l'instance de sa structure.

## 4. Parcours principal

1. Ouvrir l'app → **Nouvelle séquence**.
2. Démarrer le **mode auto** et marcher : une photo est prise régulièrement, uniquement en mouvement.
3. Prendre des photos manuelles si besoin.
4. Fermer → la séquence apparaît dans la liste.
5. (Une seule fois) se connecter à Panoramax dans les réglages.
6. **Envoyer** la séquence (ou **Tout envoyer**), même plus tard, au retour sur le Wi-Fi.

## 5. Exigences fonctionnelles

### 5.1 Capture — MVP
| ID | Exigence | Priorité |
|---|---|---|
| C1 | Aperçu plein écran de la caméra arrière | Must |
| C2 | Mode auto : toutes les *N* s (défaut 2 s), une photo est prise **seulement si** l'utilisateur s'est déplacé d'au moins *D* m (défaut 4 m) depuis la précédente | Must |
| C3 | Pas de photo si la précision GPS dépasse un seuil (défaut 20 m) | Must |
| C4 | Déclencheur manuel, disponible en plus du mode auto | Must |
| C5 | Chaque JPEG contient en EXIF : latitude, longitude, altitude, précision, date et heure avec millisecondes, direction de prise de vue, vitesse | Must |
| C6 | Indicateur GPS (rouge / orange / vert avec ±m) et compteur de photos | Must |
| C7 | L'écran reste allumé pendant la capture | Must |
| C8 | Retour haptique et flash visuel à chaque photo | Should |
| C9 | Orientation correcte des photos en portrait comme en paysage | Should |

### 5.2 Gestion des séquences — MVP
| ID | Exigence | Priorité |
|---|---|---|
| S1 | Liste des séquences avec nombre de photos et statut d'envoi | Must |
| S2 | Renommer une séquence (le nom devient le titre de l'upload set) | Must |
| S3 | Carte du parcours et grille de vignettes | Should |
| S4 | Supprimer une photo ou une séquence | Must |
| S5 | Reprendre la capture dans une séquence existante | Should |

### 5.3 Envoi Panoramax — MVP
| ID | Exigence | Priorité |
|---|---|---|
| U1 | Instance configurable (défaut `https://panoramax.openstreetmap.fr`) | Must |
| U2 | Connexion sans mot de passe dans l'app, via le flux « jeton réclamé » de Panoramax | Must |
| U3 | Envoi d'une séquence avec barre de progression | Must |
| U4 | « Tout envoyer » pour les séquences en attente | Should |
| U5 | Envoi **reprenable** : après une coupure, seules les photos manquantes sont renvoyées | Must |
| U6 | Option pour supprimer les JPEG du téléphone après envoi | Could |

## 6. Exigences non fonctionnelles

- **Simplicité** : 4 écrans (liste, capture, détail, réglages), aucune dépendance externe.
- **Hors ligne** : la capture fonctionne sans réseau ; seul l'envoi en a besoin.
- **Confidentialité** : aucun mot de passe stocké, jeton JWT dans le Keychain, aucune donnée envoyée ailleurs qu'à l'instance choisie.
- **Qualité des données** : les métadonnées sont injectées sans recompression du JPEG.
- **Batterie** : GPS et caméra actifs uniquement sur l'écran de capture.
- **Langue** : interface en français.

## 7. Hors périmètre (v1)

- Capture en arrière-plan (écran éteint) et upload en tâche de fond.
- Caméras 360°, ultra grand-angle, caméras externes.
- Floutage local des visages et plaques (Panoramax floute côté serveur).
- Correction manuelle de la position d'une photo (présente dans Baba : candidate v2).
- Annotations et tags sémantiques.
- iPad, Android (Baba existe déjà).

## 8. Indicateurs de succès

- Une séquence de 100 photos peut être capturée puis envoyée sans erreur sur l'instance OSM France.
- Moins de 5 % de photos rejetées par Panoramax (doublons exclus).
- Aucune photo prise à l'arrêt en mode auto (feu rouge, pause).
- Démarrer une capture prend moins de 3 secondes depuis l'ouverture de l'app.

## 9. Risques et questions ouvertes

| Risque | Mitigation |
|---|---|
| L'instance refuse la redirection `next_url=arpent://` après réclamation du jeton | À la fermeture de la feuille web, l'app vérifie quand même le jeton via `/api/users/me` |
| Conditions d'utilisation non acceptées sur l'instance : refus d'envoi | Afficher le message d'erreur du serveur ; l'utilisateur les accepte sur le site |
| GPS urbain imprécis (canyons urbains) | Seuil de précision réglable ; indicateur visible |
| Cap boussole faux près d'objets métalliques | Repli sur la direction du déplacement ; Panoramax peut recalculer le cap via `relative_heading` (piste v2) |
| Gros volumes : envoi au premier plan uniquement | Envoi reprenable ; upload en tâche de fond en v2 |

## 10. Feuille de route

- **v0.1 (MVP)** : périmètre ci-dessus.
- **v0.2** : correction de position, choix du cap relatif (avant / gauche / droite), upload en arrière-plan.
- **v0.3** : capture écran verrouillé, statistiques de séquence, liste des photos rejetées par le serveur.

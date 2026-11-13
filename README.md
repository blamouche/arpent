# Arpent

Application iOS minimaliste pour **capturer des séquences de photos géolocalisées** et les **publier sur [Panoramax](https://panoramax.fr)**. C'est l'équivalent iPhone de [Baba](https://wiki.openstreetmap.org/wiki/Baba) (Android).

- Mode auto : une photo toutes les *N* secondes, **seulement si on s'est déplacé** d'au moins *D* mètres. À l'arrêt, rien n'est pris.
- Déclencheur manuel.
- EXIF complet (GPS, cap, date avec millisecondes), sans recompression.
- Envoi reprenable vers n'importe quelle instance (défaut : `panoramax.openstreetmap.fr`).
- Connexion via le site de l'instance, sans mot de passe dans l'app.

## Prérequis

- **Xcode 16 ou plus récent** (App Store).
- iPhone sous iOS 17+, ou le simulateur (une image de test remplace alors la caméra).

## Lancer

1. Ouvrir `Arpent.xcodeproj`.
2. Cible *Arpent* → *Signing & Capabilities* : choisir votre équipe (un compte Apple gratuit suffit pour son propre iPhone). Changer le bundle id `org.arpent.app` si nécessaire.
3. Lancer sur un iPhone ou un simulateur.

En ligne de commande (simulateur) :
```bash
xcodebuild -project Arpent.xcodeproj -scheme Arpent -destination 'platform=iOS Simulator,name=iPhone 16' build
```

Dans le simulateur, *Features → Location → City Run* simule un déplacement pour tester le mode auto.

## Version web (prototype)

Le dossier [`web/`](web/README.md) contient une PWA qui reprend le même parcours dans le navigateur (iPhone et Android, sans installation depuis un store). Pour l'essayer en local avec position et caméra simulées :

```bash
python3 -m http.server 8137 --directory web
```

puis ouvrir <http://localhost:8137/?demo>. Version en ligne : <https://blamouche.github.io/arpent/>.

## Documentation

- [PRD](docs/PRD.md) : objectifs, exigences, périmètre.
- [Architecture](docs/ARCHITECTURE.md) : modules, flux de capture, d'authentification et d'envoi.
- [Notes API Panoramax](docs/API-PANORAMAX.md) : routes et EXIF utilisés.

## Licence

À définir. Baba est sous AGPL-3.0 ; Arpent ne reprend pas son code.

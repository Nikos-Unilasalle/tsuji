---
module: 7
duree: "45 min"
---

# Module 7 — Exporter son rendu final

← [[06-Post-Traitement-et-Style]] · Suivant → [[08-Projet-Final]]

## Ce que tu vas apprendre

Passer d'une animation qui joue dans Tsuji à un **fichier vidéo** que tu peux insérer dans une présentation, un e-mail, un rapport. C'est l'étape que beaucoup de tutoriels sautent, alors qu'elle a ses propres pièges.

## 7.1 — Ce qui se passe pendant l'export

Contrairement à la lecture en direct dans la vue 3D (qui peut ralentir sur une scène lourde sans que ça se voie trop), l'export de Tsuji **capture image par image, à un rythme fixe** : chaque frame est rendue, capturée, puis l'export attend le temps exact d'une frame avant de passer à la suivante. Résultat : la vidéo exportée respecte toujours le nombre d'images par seconde demandé, même si ta machine n'arrive pas à afficher l'animation à cette vitesse en aperçu.

Concrètement, ça veut dire : **ne juge jamais la fluidité finale sur l'aperçu temps réel d'une machine peu puissante** — exporte, le fichier sera correct.

## 7.2 — Format de sortie : MP4 ou WebM

Tsuji essaie d'exporter en **MP4** en priorité ; si le navigateur/l'environnement ne sait pas encoder du MP4 (fréquent sous Chrome/Edge sur Windows et Linux), il bascule automatiquement en **WebM** — même contenu, conteneur différent. Tu n'as rien à choisir : le nom de fichier proposé porte déjà la bonne extension.

- **MP4** : lecture universelle (PowerPoint, Keynote, réseaux sociaux, à peu près tout).
- **WebM** : s'ouvre très bien dans un navigateur ou VLC ; si ton logiciel de présentation le refuse, une conversion rapide en MP4 avec un outil en ligne ou VLC suffit.

## 7.3 — Réglages avant l'export

| Réglage | Recommandation pour une présentation |
|---|---|
| **FPS (images/seconde)** | 30 est un bon défaut. 24 pour un rendu "cinéma", 60 seulement si le mouvement est très rapide (rarement le cas pour un objet en orbite). |
| **Durée / nombre de frames** | Doit correspondre exactement à la durée que tu as animée au module 5 — vérifie la timeline avant de lancer. |
| **Son** | Inclus par défaut si ta scène en produit. Désactive-le si ta scène est lourde à calculer : le son tourne en temps réel pendant que les frames sont capturées une par une, donc sur une scène qui rame, le son peut se désynchroniser de l'image — mieux vaut une vidéo silencieuse propre qu'une vidéo avec un son décalé. |
| **Bitrate / qualité** | La valeur par défaut convient pour une présentation à l'écran. Augmente-la seulement si tu comptes projeter en très grand format et que le fichier a l'air compressé (blocs visibles dans les zones sombres). |

> 🎬 `![[demo-export-panneau-reglages.mp4]]`
> *Ouverture du panneau d'export, réglage FPS/durée, lancement, barre de progression, fichier obtenu.*

## 7.4 — Lancer l'export

1. Vérifie que la lecture depuis `t=0` donne bien l'animation complète attendue (relis-la une dernière fois avec `Espace`).
2. Ouvre le panneau d'export, règle FPS et durée comme au 7.3.
3. Lance l'export — une barre de progression avance frame par frame. **Ne ferme pas l'onglet/l'application pendant l'export.**
4. Une fois terminé, une boîte de sauvegarde s'ouvre (application desktop) ou le téléchargement démarre automatiquement (version web) — choisis un nom de fichier explicite plutôt que le nom par défaut si tu dois le retrouver plus tard parmi plusieurs exports.

## 7.5 — Si l'export échoue ou semble bloqué

- **"Cette page/application ne peut pas capturer le canvas en flux vidéo"** : le navigateur ne supporte pas cette fonctionnalité — réessaie avec la dernière version de Chrome, Edge ou l'application desktop.
- **Export très long ou qui semble figé** : une scène lourde (beaucoup de particules, un scan très détaillé) peut ralentir la capture de chaque frame. C'est normal tant que la barre de progression avance, même lentement — vérifie plutôt qu'elle avance que sa vitesse absolue.
- **Vidéo trop lourde pour un e-mail/une clé USB** : réduis le bitrate, ou raccourcis la durée de l'animation plutôt que de baisser le FPS (une vidéo saccadée se remarque plus qu'une vidéo un peu plus compressée).

## Exercice guidé (20 min)

1. Fais un export complet de ton animation du module 6, en 30 FPS, avec les réglages par défaut.
2. Ouvre le fichier obtenu dans un lecteur vidéo classique — vérifie la durée, la fluidité, le son (si présent).
3. Si quelque chose ne convient pas (durée, cadrage, effet trop fort), retourne dans Tsuji, corrige, ré-exporte.

## ✅ Mini-livrable du module

Un fichier vidéo (MP4 ou WebM) exporté, lisible en dehors de Tsuji, qui correspond exactement à l'animation validée au module 6.

---
← [[06-Post-Traitement-et-Style]] · Suivant → [[08-Projet-Final]]

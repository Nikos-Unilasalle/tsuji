---
module: 6
duree: "30 min"
---

# Module 6 — Post-traitement et style visuel

← [[05-Animer-dans-le-Temps]] · Suivant → [[07-Exporter-son-Rendu]]

## Ce que tu vas apprendre

Le post-traitement s'applique sur l'image finale, après le rendu 3D — comme un filtre photo. C'est le module le plus rapide, mais celui qui fait le plus souvent la différence entre "un rendu 3D" et "une vidéo qui a l'air pro".

## 6.1 — La règle d'or : moins, mais mieux

Chaque nœud de post-traitement du tableau ci-dessous est tentant à combiner avec tous les autres — c'est justement le piège. Un rendu de présentation gagne à rester lisible : **deux effets discrets valent mieux que cinq effets cumulés qui se battent entre eux.**

| Node | Effet | Recommandé pour une présentation ? |
|---|---|---|
| **Color Correction** | Luminosité, contraste, saturation | Oui — quasi systématique |
| **Vignette** | Assombrit progressivement les bords | Oui — discret, resserre l'attention sur le sujet |
| **Bloom** | Halo lumineux sur les zones claires/émissives | Avec parcimonie — utile si la scène a des sources de lumière visibles |
| **Depth of Field** | Flou de profondeur de champ | Oui si tu veux isoler le sujet d'un arrière-plan |
| **Film Grain** | Grain cinéma | Optionnel, effet de texture léger |
| **Outline** | Contour type cel-shading | Non — sauf effet volontairement stylisé/BD |
| **Glitch / Pixelate / Kaleidoscope / RGB Shift** | Effets créatifs marqués | Non pour une présentation d'objet ou de process |

## 6.2 — Le trio de base recommandé

Pour la grande majorité des rendus de présentation, ce trio suffit et se combine sans se marcher dessus :

1. **Color Correction** — remonte légèrement le contraste, vérifie que les couleurs ne sont ni trop ternes ni cramées.
2. **Vignette** — intensité faible, juste assez pour que l'œil ne s'échappe pas vers les coins de l'image.
3. **Depth of Field** — mets le focus sur ton objet, laisse l'arrière-plan (s'il y en a un) légèrement flou.

> 🎬 `![[demo-postprocess-avant-apres.mp4]]`
> *La même animation, sans puis avec le trio Color Correction + Vignette + Depth of Field.*

## 6.3 — Où brancher le post-traitement

Les nœuds de post-traitement se branchent en série, **après** la sortie de la caméra/du rendu, avant la sortie finale de la scène. L'ordre a un impact visible : place Color Correction avant Vignette pour que l'assombrissement des bords s'applique sur les couleurs déjà corrigées.

> 🧩 ![[schema-06-postprocess-chaine.svg]]
> *Color Correction → Depth of Field → Vignette, chaînés par leur socket Post-Process, jusqu'à l'entrée Post-Process du nœud Render.*

## Exercice guidé (15 min)

1. Reprends ton animation du module 5.
2. Ajoute Color Correction, ajuste contraste et saturation à l'œil.
3. Ajoute Depth of Field, règle la distance de focus sur ton objet.
4. Ajoute Vignette en dernier, à faible intensité.
5. Relis l'animation entière (`Espace`) — vérifie que l'effet reste cohérent sur toute la durée, y compris quand la caméra change d'angle en orbitant.

## ✅ Mini-livrable du module

Une animation avec un post-traitement à 2-3 effets maximum, appliqué de façon cohérente sur toute la durée du mouvement.

---
← [[05-Animer-dans-le-Temps]] · Suivant → [[07-Exporter-son-Rendu]]

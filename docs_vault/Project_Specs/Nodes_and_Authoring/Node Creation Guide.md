# Node Creation Guide

*Emplacement dans le code : `src/shared/graph/nodes/`*

Ce document est le guide de référence pour le développement d'un nouveau type de nœud dans Tsuji.

---

## 1. Arborescence des Fichiers

```
src/shared/graph/
  sockets.ts           <- Définition des 12 types de sockets
  types.ts             <- Interfaces NodeDefinition et EvalContext
  nodes/
    <categorie>.ts     <- Implémentation du nœud
    index.ts           <- Enregistrement dans STARTER_NODES et export *
    nodes.test.ts      <- Tests unitaires Vitest
```

---

## 2. Patron de Conception (`NodeDefinition`)

```typescript
import { NodeDefinition } from "../types";

export const MY_NODE: NodeDefinition = {
  type: "category/my-node",          // Identifiant unique en minuscules
  label: "My Node",                  // Libellé affiché dans l'UI
  category: "math",                  // Catégorie déterminant la couleur
  inputs: [
    { id: "factor", label: "Factor", type: "value" },
  ],
  outputs: [
    { id: "out", label: "Out", type: "value" },
  ],
  defaultParams: { factor: 1.0 },
  paramFields: [
    { id: "factor", label: "Factor", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.factor !== undefined ? inputs.factor : params.factor;
    const factor = Number(raw) || 0;
    const result = factor * 2;
    return {
      out: Number.isFinite(result) ? result : 0,
    };
  },
};
```

---

## 3. Règles Strictes pour `evaluate`

1. **Pureté Déterministe** : Aucun appel à `Date.now()` ou `Math.random()`. Se référer uniquement à `ctx.time` et `ctx.step`.
2. **Immuabilité** : Cloner tout objet Three.js partagé avant modification (`vec.clone()`).
3. **Gestion des Objets GPU Persistants** : Utiliser un cache module via `createNodeCache<T>` indexé par `ctx.nodeId`.
4. **Valeurs Numériques Saines** : Interdiction absolue de renvoyer `NaN` ou `Infinity`.

---

## 4. Principe Fondamental : Penser Toujours Générique (Orthogonalité & Atomicité)

> [!IMPORTANT]
> **Règle d'or de conception** : Un nœud ne doit **JAMAIS** être conçu sur mesure pour un exercice, une démo ou un besoin métier spécifique.

1. **Responsabilité Unique & Atomicité** :
   - Chaque nœud résout un problème mathématique ou géométrique élémentaire.
   - Ne jamais fusionner plusieurs étapes ou concepts dans un seul nœud sous prétexte de faciliter un cas particulier.
2. **Entrées et Sorties Minimalistes et Universelles** :
   - Proscrire les sorties composites pré-calculées pour un cas d'usage précis (ex: ne pas injecter des sorties `heights`, `colors` ou `displacements` dans un nœud d'échantillonnage de texture).
   - Un échantillonneur de texture (`Sample Texture`) doit se contenter d'échantillonner et de renvoyer **une simple liste de scalaires normalisés dans `[0, 1]`** (selon le canal sélectionné).
   - Un nœud de distribution spatiale (`Hex Grid`) calcule uniquement le pavage régulier et la disposition géométrique de base. Il **n'embarque pas d'entrée `heights` ni de mode d'élévation/étirement**.
3. **Délégation et Composition via les Nœuds Dédiés** :
   - Pour manipuler la pose, l'élévation ou l'échelle d'instances générées par une grille, on compose avec les nœuds de la catégorie `instance` (ex: `Set Instance Transform`, `Set Instance Color`).
   - Tout calcul intermédiaire (mise à l'échelle, offset, seuillage, marches/terrasses) appartient au graphe et se compose via `Map Range`, `Value Math` ou `List Math`.

### 💡 Cas d'école : Le paysage hexagonal (« Hexaworld »)
- `Hex Grid` : génère le pavage alvéolaire 2D (géométrie instanciée + liste `positions`).
- `Sample Texture` : lit une texture aux `positions` et produit une liste de scalaires `values` dans `[0, 1]`.
- `Map Range` / `List Math` : remappe `[0, 1]` vers l'amplitude désirée `[min, max]`.
- `Set Instance Transform` : applique ces hauteurs sur `posY` ou `scaleY` de la géométrie issue de `Hex Grid`.
- `Set Instance Color` : applique une palette de couleurs aux instances.
Chaque nœud conserve ainsi une réutilisabilité maximale à 100%.

---

## 🔗 Notes Associées
- [[Socket Type System and Ownership]]
- [[Graph Evaluation Runtime]]
- [[Node Catalog]]
- [[Testing Harness and Vitest Suites]]
- [[System Invariants and Coding Rules]]

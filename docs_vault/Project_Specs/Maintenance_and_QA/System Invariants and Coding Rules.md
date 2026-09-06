# System Invariants and Coding Rules

*Emplacement dans le code : Règles transversales du projet Tsuji*

Ce document consigne les invariants stricts et les conventions de code applicables à toute contribution sur le projet Tsuji.

---

## 1. Invariants Non Négociables

1. **Pureté de la fonction `evaluate`** :
   - `(inputs, params, ctx) -> outputs` doit être une transformation mathématique pure.
   - Ne jamais lire `Date.now()`, `Math.random()` ou des variables globales.
2. **Immuabilité des données d'entrée** :
   - Ne jamais modifier les objets `THREE.Vector3` ou tableaux passés en argument.
3. **Résilience Numérique** :
   - Prévenir les divisions par zéro, `NaN`, et `Infinity`. Renvoyer des nombres finis sécurisés.
4. **Source Unique de Vérité** :
   - Le graphe de nœuds est la source de vérité absolue pour toute la scène 3D.
5. **Gestion Stricte de la Mémoire GPU (`createNodeCache`)** :
   - Tout état, groupe ou texture persistant associé à un `nodeId` doit impérativement être enregistré via `createNodeCache<T>(disposeObject3D)` dans `src/shared/graph/nodeCaches.ts`. Les `new Map` brutes au niveau module sont proscrites.
6. **Conception Générique et Modularité des Nœuds (Orthogonalité)** :
   - Tout nœud doit être conçu de façon universelle, sans présupposer d'un cas d'usage ou d'un exercice particulier.
   - Interdiction de créer des sorties composites ou ad-hoc (ex: sorties combinées "heights" ou "displacements" dans un nœud d'échantillonnage de texture). Les nœuds fournissent des données atomiques pures (ex: liste normalisée `[0, 1]`), et la composition est réalisée par le graphe.

---

## 2. Conventions TypeScript & Style

- **Nommage** : `camelCase` pour les fonctions/variables, `PascalCase` pour les types et composants React, `UPPER_SNAKE_CASE` pour les nœuds exportés.
- **Interdiction de `any`** : Utiliser `unknown` combiné avec `instanceof` ou `typeof`.
- **Taille de Fichier** : Limiter les fichiers de catégories de nœuds à environ 300 lignes.

---

## 🔗 Notes Associées
- [[Node Creation Guide]]
- [[Testing Harness and Vitest Suites]]
- [[Graph Evaluation Runtime]]

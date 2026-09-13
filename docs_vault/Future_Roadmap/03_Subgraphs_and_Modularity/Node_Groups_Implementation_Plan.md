# Chantier : Groupes de Nœuds (Cmd+G) — Plan d'Implémentation

*Domaine : Modularité du Graphe · Runtime · Éditeur*
*Statut : P0, P1, P2 livrés — P3 partiel (voir §5)*

---

## 1. Objectif

`Cmd+G` sur une sélection de nœuds produit **un seul nœud** `structure/group` qui
encapsule un sous-graphe complet, avec des ports d'entrée/sortie dérivés des
câbles qui traversaient la frontière de la sélection. `Cmd+Shift+G` défait
l'opération. Double-clic plonge dans le sous-graphe, avec fil d'Ariane.

Modèle de référence : Blender (`Ctrl+G`, nœuds *Group Input* / *Group Output*)
et Nuke, plutôt que le simple cadre décoratif.

---

## 2. Décisions d'architecture

### 2.1 Vrai sous-graphe, pas un aplatissement cosmétique
L'alternative — le groupe comme cadre visuel aplati à l'évaluation — coûte
beaucoup moins cher mais ne donne ni ports, ni abstraction, ni réutilisation.
C'est un *frame*, pas un groupe. Écartée.

### 2.2 IDs globalement uniques, pas d'instanciation en v1
Grouper = **re-parenter** les instances existantes : leurs ids ne changent pas.
Conséquence directe : les keyframes (clés = nodeId), les caches GPU
(`nodeCaches.ts`), les `exposedParams` du HUD et l'undo continuent de
fonctionner sans aucune migration.

Coût assumé : `Cmd+D` sur un groupe fait un *deep clone* avec des ids neufs — il
n'y a pas de duplicata *lié*. L'instanciation réelle (namespacing
`${groupId}::${innerId}`, dispose de caches par préfixe) est reportée en P4.

### 2.3 Ports dérivés de nœuds internes, pas d'une liste dupliquée
Les notes [[GroupNodeDefinition and Exposed Ports Schema]] proposaient un tableau
`exposedInputs/exposedOutputs` sur le nœud groupe. Écarté : deux sources de
vérité à garder synchronisées. À la place, deux nœuds internes —
`structure/group-input` et `structure/group-output` — dont les ports *sont* la
définition. Le câblage interne devient naturel et le renommage d'un port est un
simple changement de param.

### 2.3bis Les keyframes restent à la racine
Décision prise en cours d'implémentation, contre le découpage initialement
envisagé : les keys sont indexées par id de nœud, grouper ne change pas l'id,
et une seule *KeyframeStore* évite que la timeline, l'évaluateur et l'undo
aient à s'accorder sur lequel des deux emplacements détient une clé. Le
sous-graphe porte donc un store vide.

### 2.4 Modèle de données — additif
```ts
interface NodeInstance {
  …
  /** Présent uniquement sur structure/group. */
  subgraph?: Graph;
}

interface EvalContext {
  …
  /** L'instance en cours — le nœud groupe y lit son propre sous-graphe. */
  instance?: NodeInstance;
  /** Valeurs injectées par le groupe parent, lues par structure/group-input. */
  groupInputs?: Record<string, unknown>;
}
```
`Graph` est déjà JSON-safe : la sérialisation est récursive, pas nouvelle.

### 2.5 Rendu
Le nœud groupe retourne `{ geometry: conteneur, ...sortiesExposées }`, où
`conteneur` est un `THREE.Group` contenant les *scene roots* internes qui ne
partent pas déjà vers un `group-output`. Cohérent avec la règle de
[[sceneRoots]] (« le dernier nœud géométrique de la chaîne rend ») décalée d'un
cran : pose une Box dans un groupe, elle s'affiche. Les lumières internes
tombent dans le conteneur, donc la détection par `traverse` du Viewport les
trouve sans code supplémentaire.

### 2.6 Ports dynamiques auto-typés
Chaque frontière se termine par une prise vide (`__new`, affichée `+`, type
`any` pour qu'aucun câble ne soit refusé à l'entrée). Y déposer un fil crée un
port réel, **typé par l'autre extrémité** — jamais `any`. Quatre points
d'entrée, une seule opération vue de quatre côtés :

| Geste | Résultat |
|-------|----------|
| Vers le `+` d'entrée d'un groupe | Nouveau port d'entrée (type de la source) — apparaît en sortie de *Group Input* |
| Depuis le `+` de sortie d'un groupe | Nouveau port de sortie (type de la cible) — apparaît en entrée de *Group Output* |
| Vers le `+` de *Group Output* | Nouveau port de sortie (type de la source) |
| Depuis le `+` de *Group Input* | Nouveau port d'entrée (type de la cible) |

Le nœud de frontière manquant est créé au besoin, donc un groupe vide accepte
un port. `materializeNewPort()` (groupSelection.ts) fait tout cela sur le
graphe pur ; `onConnect` s'y branche avant sa propre logique d'arêtes.

---

## 3. Contraintes relevées dans le moteur existant

| # | Endroit | Problème si on code naïvement |
|---|---------|-------------------------------|
| 1 | `evaluate.ts` — `lastGraphRef` | Cache structurel mono-slot : parent → sous-graphe → parent = 100 % de miss par frame. Devient une `WeakMap<Graph, cache>`. |
| 2 | `evaluate.ts` — `previousFrameOutputsBySession` | Clé = sessionId seul : un sous-graphe écrase la frame précédente du parent. Clé étendue à `${sessionId}::${groupNodeId}`. |
| 3 | `registry.get(instance.type)` — 14 sites | Un groupe a des sockets **par instance**, pas par type. Indirection `resolveDefinition(instance, registry)`. |
| 4 | `nodeCaches.ts` + `App.tsx` (diff des nœuds partis) | Ne voit que le premier niveau : supprimer un groupe fuit tout son intérieur. |
| 5 | `sceneRoots.ts` | Le groupe doit être un root unique contenant ses roots internes. |

---

## 4. Phases

### P0 — plomberie invisible (aucun changement utilisateur)
- `WeakMap` pour le cache structurel ; clé de session par groupe.
- `src/shared/graph/groups.ts` : `resolveDefinition()`, `walkGraphs()`,
  `collectAllNodeIds()`.
- Substitution de `resolveDefinition` aux 14 `registry.get(instance.type)`.
- Tests : non-thrashing du cache, neutralité sur les nœuds ordinaires.

### P1 — modèle + runtime
- `nodes/group.ts` : `structure/group`, `structure/group-input`,
  `structure/group-output`.
- Évaluation récursive ; dérivation des sockets depuis les nœuds I/O internes,
  mémoïsée par référence de sous-graphe.
- `sceneRoots` conteneur ; `storage` (clean/validate récursifs) ;
  `pruneConnections` récursif ; `cloneGraph` profond avec remap d'ids.
- Tests : round-trip de sérialisation imbriquée ; évaluation d'un groupe
  identique à celle du graphe aplati équivalent.

### P2 — UI
- `Cmd+G` sur la sélection : les câbles traversant la frontière deviennent des
  ports (dédupliqués par socket source). `Cmd+Shift+G` dégroupe.
- Dive-in au double-clic + fil d'Ariane ; état `graphPath: string[]` dans
  `App.tsx`, `onGraphChange` réécrit immuablement au chemin.
- Apparence du nœud groupe (badge, nombre de nœuds) ; ParamPanel : nom +
  liste des ports (renommer, réordonner, supprimer).

### P3 — intégration fine
Fait : dispose récursif des caches (contrainte 4) ; `exposedParams` HUD
pointant un nœud interne ; `rehydrateFiles`/`rehydrateParams` récursifs ;
exclusion du groupe et de ses nœuds de frontière de la palette et de la
recherche ; panneau de params atteignant un nœud interne (lecture et
écriture).

### P4 — plus tard
Export `.tsujigroup`, onglet « Mes Composants », instanciation liée.
Voir [[User Preset Export and .tsujigroup Library]].

---

## 5. Limites connues à ce stade

1. **Gizmo du viewport** — `onTransformChange` (App.tsx) écrit encore par
   `prevGraph.nodes.find`, donc déplacer à la souris un objet dont le nœud
   Transform est *dans* un groupe ne réécrit pas le graphe. Même chose pour
   quelques raccourcis d'App.tsx qui parcourent le premier niveau.
   Correctif : la même substitution `findNodeDeep` / `updateNodeDeep` déjà
   appliquée à `onParamChange`.
2. **Timeline** — la liste « All Nodes » lit `graph.nodes` du niveau racine :
   les nœuds intérieurs animés n'y apparaissent pas (leurs keys jouent bien,
   elles ne sont simplement pas listées).
3. **Dégroupage** — un câble partant de la sortie implicite `geometry` est
   perdu (§2.5) : il représentait un ensemble, pas une sortie de nœud.
4. **Pas d'instanciation** — dupliquer un groupe le copie en profondeur avec
   de nouveaux ids (décision 2.2).

---

## 🔗 Notes Associées
- [[GroupNodeDefinition and Exposed Ports Schema]]
- [[Hierarchical Subgraph Evaluation Runtime]]
- [[Subgraphs and Compound Nodes Architecture]]

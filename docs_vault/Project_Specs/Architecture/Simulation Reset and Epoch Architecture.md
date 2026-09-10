# Simulation Reset & Epoch Architecture

*Emplacement dans le code : `src/shared/graph/simulationEpoch.ts`, `src/shared/graph/types.ts`, `src/App.tsx`, `src/windows/TimelineBar.tsx`*

Ce document détaille l'architecture du **Reset Universel de Simulation** et du mécanisme d'**Époque de Simulation (`simulationEpoch`)**, garantissant la reproductibilité et la remise à zéro atomique de tous les nœuds à mémoire d'état dans Tsuji.

---

## 1. La Problématique : L'Inhérence Historique des Simulations

Dans un graphe nodal 3D réactif évalué à chaque frame, la plupart des nœuds sont **purs** : leur sortie à l'instant $t$ est une fonction déterministe stricte de leurs entrées à cet instant ($y_t = f(x_t)$).

Cependant, les systèmes physiques et dynamiques possèdent une **mémoire cumulative** :
- Un **monde physique Rapier** (`physics/world`) conserve l'état dynamique, la vitesse et les positions de contact où les caisses ont chuté.
- Un **solveur de fluide 3D** (`physics/fluid-solver-3d`) accumule la fumée, la température et le champ de vitesse advecté.
- Un **intégrateur** (`math/integrate`, `vector/integrate`) conserve la distance ou l'angle cumulé $\int v \, dt$.
- Une **carte d'interaction** (`texture/interaction-map`) conserve les empreintes de pas dans son double-buffer FBO ping-pong.
- Un **système de particules** (`particles/simulate`) conserve la position et la durée de vie de milliers de grains GPU.
- Le **registre de variables globales** (`variable/set`, `variable/get`) conserve les valeurs affectées au cours du temps.

Ces états **ne sont pas dérivables** de la frame courante : ils *sont* l'historique de la scène. Par conséquent, changer de frame en arrière (scrubbing) ou vouloir recommencer une expérience interactive ne peut pas se faire par simple ré-évaluation : il faut **jeter l'état accumulé et le reconstruire**.

---

## 2. Le Compteur d'Époque (`ctx.simulationEpoch`)

Pour synchroniser tous les sous-systèmes sans couplage fort ni variables globales dispersées, Tsuji utilise un compteur scalaire unique : **l'époque de simulation** (`epoch`).

```
                    ┌────────────────────────────┐
                    │  Action Reset (Shift+Space │
                    │   ou bouton Transport)     │
                    └─────────────┬──────────────┘
                                  │ resetSimulations()
                                  ▼
                    ┌────────────────────────────┐
                    │      epoch = epoch + 1     │
                    └─────────────┬──────────────┘
                                  │ injecté dans
                                  ▼
                    ┌────────────────────────────┐
                    │  EvalContext.simulationEpoch│
                    └─────────────┬──────────────┘
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
  physics/world            math/integrate           physics/fluid-solver-3d
  (recrée world & corps)   (remet initial value)    (purge grilles 3D)
         ▼                        ▼                        ▼
  texture/interaction-map  particles/simulate       variable/set & get
  (efface FBO ping-pong)   (purge buffers GPU)      (vide store global)
```

### 2.1 Implémentation (`simulationEpoch.ts`)

```typescript
let epoch = 0;
const listeners = new Set<() => void>();

export function resetSimulations(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function getSimulationEpoch(): number {
  return epoch;
}

export function isEpochCurrent(builtAt: number | undefined, epochNow: number | undefined): boolean {
  if (builtAt === undefined) return false;
  return builtAt === (epochNow ?? 0);
}
```

### 2.2 Acheminement par le Contexte d'Évaluation
`simulationEpoch` voyage dans `EvalContext` plutôt que d'être lu directement dans le module par chaque nœud :
- **Déterminisme d'Export** : L'export vidéo headless peut épingler ou fixer l'époque.
- **Isolation Multi-Viewports** : Deux viewports affichant le même graphe ne peuvent pas être en désaccord sur la génération observée.
- **Zéro fuite en contexte de test** : Un appel headless ou un test unitaire isole son évaluation sans résidu.

---

## 3. Comportement des Nœuds Abonnés

Chaque nœud détenant un état persistant mémorise l'époque à laquelle son état a été initialisé (`builtAtEpoch`). À chaque évaluation :

```typescript
const epoch = ctx.simulationEpoch ?? 0;
if (state && state.epoch !== epoch) {
  state.handle.dispose();
  state = createFreshState(epoch);
}
```

| Nœud / Sous-système | Effet de l'incrément d'époque |
| :--- | :--- |
| **`physics/world`** | Détruit le monde Rapier (`world.free()`), recrée l'instance et incrémente `generation`, forçant tous les `physics/rigid-body`, `physics/character` et `physics/vehicle` à recréer leurs colliders et corps rigides à leur pose d'origine. |
| **`math/integrate`** / **`vector/integrate`** | Réinitialise la valeur accumulée à `params.initial` (ou $(0,0,0)$). |
| **`physics/capsule-controller`** | Replace la capsule cinématique à sa position initiale (`params.position`). |
| **`physics/fluid-solver-3d`** | Purge les textures 3D de vitesse et de densité vers zéro. |
| **`texture/interaction-map`** | Réinitialise les deux cibles de rendu FBO ping-pong à noir transparent. |
| **`particles/simulate`** | Appelle `resetAllParticleSimulations()`, réallouant les textures de positions initiales. |
| **`variable/set`** / **`variable/get`** | Vide la `Map` globale de variables nommées. |
| **`Viewport.tsx`** | Remet l'horloge de rendu à zéro et renvoie la tête de lecture à la frame 0. |

---

## 4. Déclenchement & Ergonomie Utilisateur

1. **Raccourci Dédié `Shift+Space`** :
   - Choisi spécifiquement parce qu'une **combinaison avec modificateur n'est jamais capturée par les nœuds de la scène** (voir [[Input Subsystem and Playback Keys]]). Même si un personnage dans le graphe saute sur la barre `Espace`, `Shift+Space` reste toujours accessible à l'auteur pour reprendre le contrôle d'une simulation qui s'emballe.
2. **Bouton Transport dans la Timeline** :
   - Présent dans `TimelineBar.tsx`, permettant un reset manuel d'un clic.
3. **Remise à la Frame 0** :
   - Reconstruire une simulation sans rembobiner la timeline laisserait par exemple la frame 120 afficher une simulation qui vient de tourner 1 frame — ce qui briserait la cohérence avec le reste du graphe d'animation. Le Reset ramène donc systématiquement le playhead à 0.

---

## 🔗 Notes Associées
- [[Graph Evaluation Runtime]]
- [[Input Subsystem and Playback Keys]]
- [[Named Variables System]]
- [[Keyframe Store and Timeline]]
- [[Node Catalog]]

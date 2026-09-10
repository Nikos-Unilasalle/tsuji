# Input Subsystem & Playback Keys Architecture

*Emplacement dans le code : `src/shared/graph/playbackKeys.ts`, `src/shared/graph/nodes/input.ts`, `src/App.tsx`, `src/windows/ShortcutsModal.tsx`*

Ce document détaille l'architecture du sous-système d'entrées de Tsuji, le nœud de contrôle tout-en-un `io/move-input`, et le mécanisme de **réservation dynamique des touches clavier pendant la lecture**.

---

## 1. Le Conflit Fondamental : Écran Éditeur vs Jeu Interactif

Dès qu'une scène interactive permet de déplacer un personnage ou un véhicule au clavier (ex. via ZQSD ou WASD), un conflit direct éclate avec les raccourcis natifs de l'éditeur Tsuji :
- `S` arme le gizmo de mise à l'échelle (*Scale*).
- `Z` bascule la caméra sur la vue de face (*Front View*).
- `D` supprime un point de courbe sous la souris.
- `Espace` met la timeline en pause ou relance la lecture.

Appuyer sur `S` pour reculer avec un personnage mettait subitement le gizmo de l'éditeur en mode échelle derrière la scène. Pire encore, appuyer sur `Espace` pour faire sauter le personnage stoppait la lecture !

---

## 2. Le Registre de Revendication (`playbackKeys.ts`)

Pour résoudre ce conflit sans désactiver l'éditeur de manière permanente, Tsuji introduit un mécanisme de **revendication dynamique contextuelle** (*key claiming*).

### 2.1 La Règle d'Or
Un raccourci éditeur est supprimé et cédé à la scène **uniquement et strictement** lorsque les deux conditions suivantes sont réunies :
1. **La lecture est active (`playbackActive === true`)**, ET
2. **Un nœud d'entrée du graphe courant écoute activement cette touche spécifique.**

Conséquences directes :
- Un graphe sans nœud d'écoute clavier conserve l'intégralité de ses raccourcis éditeur, même en cours de lecture.
- Dès que la lecture s'arrête (pause ou stop), tous les raccourcis éditeur redeviennent instantanément actifs.
- L'éditeur ne perd **que** les touches réellement mobilisées par la scène active.

### 2.2 Invariant Absolu : Les Accords (Chords) ne sont Jamais Capturés

```typescript
export function isKeyReservedForPlayback(event: KeyEventLike): boolean {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  return playbackActive && isKeyClaimedByGraph(event);
}
```

Les nœuds de scène (`io/keyboard`, `io/move-input`) écoutent des touches simples (`z`, `q`, `s`, `d`, `space`, `shift`).
Les combinaisons avec modificateurs (`Shift+Space`, `Ctrl+Z`, `Alt+Click`, etc.) **ne sont jamais confisquées** par la scène.
Grâce à cette règle, `Shift+Space` (**Reset Simulations**, voir [[Simulation Reset and Epoch Architecture]]) reste toujours opérant, même si le saut du personnage est câblé sur `Space`.

De plus, la touche **`Échap` (Escape)** stoppe systématiquement la lecture en cours.

### 2.3 Correspondance Bilingue `key` / `code` (AZERTY / QWERTY)

Le système normalise et teste simultanément `event.key` et `event.code` :
- `key = "q"` cible la lettre (AZERTY).
- `code = "keya"` cible la position physique de la touche (QWERTY).
Un auteur écrivant `"q"` ou `"keyq"` est ainsi pris en charge de manière prévisible quel que soit l'agencement clavier de l'utilisateur.

---

## 3. Le Nœud de Contrôle : `io/move-input` (*Move Input*)

Avant `io/move-input`, piloter un personnage exigeait une chaîne de 8 nœuds :
`5 × Keyboard + 2 × Action Map + 1 × Compose Vector`.

`io/move-input` condense toute cette tuyauterie dans un **seul nœud standardisé**.

```
                 ┌───────────────────────┐
                 │     io/move-input     │
                 ├───────────────────────┤
 (Speed, Enabled)│                       │ move (vector XZ)  ──▶ Capsule / Character
                 │   [ Clavier ZQSD ]    │ forward (value)   ──▶ Throttle Véhicule
                 │   [  + Gamepad   ]    │ x (right), z (fw) ──▶ Direction / Braquage
                 │                       │ jump, sprint      ──▶ Actions
                 └───────────────────────┘
```

### 3.1 Agencements Préréglés (`layout`)
- `zqsd` (AZERTY standard)
- `wasd` (QWERTY standard)
- `arrows` (Flèches directionnelles)
- `zqsd+arrows` (AZERTY + Flèches simultanées)
- `wasd+arrows` (QWERTY + Flèches simultanées)
- `custom` (Touches personnalisables via les paramètres `forwardKey`, `backKey`, `leftKey`, `rightKey`)

### 3.2 Fusion Clavier + Manette (Strongest Wins)
Si `useGamepad` est activé, le stick gauche de la manette (avec zone morte radiale et remise à l'échelle) est fusionné dans le même vecteur :
- **Règle du plus fort** : $\max(|v_{\text{pad}}|, |v_{\text{clavier}}|)$. Tenir la touche `Z` tout en poussant le stick fait marcher à vitesse nominale, sans addition absurde de vitesses.

### 3.3 Convention Vectorielle Native Y-Up / -Z Avant
- Le vecteur de sortie `move` est directement orienté dans le plan du sol : $(x, 0, z)$ avec **avant = $-Z$**.
- La sortie dédiée `forward` fournit $-Z$ avec le signe intuitif ($+1$ = avance), prête à être injectée dans l'accélérateur d'un véhicule (`physics/vehicle`) sans multiplicateur d'inversion.
- Braquage : $X$ positif = droite.

---

## 🔗 Notes Associées
- [[Simulation Reset and Epoch Architecture]]
- [[Graph Evaluation Runtime]]
- [[Node Catalog]]
- [[Unreal FPS Camera and Kinematic Capsule Controller]]

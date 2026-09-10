# Named Variables System (Set & Get Variable)

*Emplacement dans le code : `src/shared/graph/nodes/variable.ts`, `src/shared/graph/nodes/variable.test.ts`*

Ce document décrit le système de variables globales nommées de Tsuji (`variable/set` et `variable/get`), inspiré du flux nodal de Blender, permettant la communication sans fil à travers le graphe et entre différents canvas.

---

## 1. Motivation : Dépasser le Câblage Spaghetti et Traverser les Canvas

Dans un graphe nodal complexe, faire transiter une valeur (ex. un score, une position cible, un trigger d'état) sur de longues distances visuelles crée des enchevêtrements de fils ("spaghetti graph").

De plus, l'architecture multi-canvas de Tsuji divise le projet en **6 canvas indépendants** (`CANVAS_COUNT = 6`, voir [[State Management and Multi-Canvas]]). Un fil SVG physique ne peut pas traverser la frontière entre deux canvas.

Les nœuds **`variable/set`** et **`variable/get`** fournissent la trappe d'évasion architecturale :
- **`variable/set`** écrit une valeur sous un nom déclaré et la transmet en transparence en sortie (*inline pass-through*).
- **`variable/get`** lit cette valeur n'importe où dans le projet en sélectionnant simplement son nom dans une liste déroulante dynamique.

---

## 2. Typage Fort et Valeurs par Défaut

Chaque nœud `variable/set` déclare un type explicite (`params.type`) :
- **`Float`** : Nombres flottants (défaut `0`).
- **`Int`** : Entiers arrondis via `Math.round()` (défaut `0`).
- **`String`** : Chaînes de caractères (défaut `""`).

### Valeur Initiale (`initial`)
Si aucun fil n'est branché sur l'entrée `value`, le nœud écrit son paramètre `initial`, garantissant qu'une variable possède une valeur valide dès la première frame d'évaluation.

### Sécurité sur `variable/get`
- Si la variable est **reconnue** mais pas encore évaluée dans l'époque courante, `variable/get` renvoie la valeur zéro de son type (`0` ou `""`).
- Si aucun `variable/set` ne déclare ce nom, `variable/get` renvoie `undefined`, permettant aux nœuds avals (`numberInput()`, `asVector3()`) d'activer leurs replis par défaut sans planter.

---

## 3. Double-Buffering de Déclaration par Step (`ctx.step`)

### Le Piège de la Saisie en Direct
Dans un éditeur réactif à 60 fps, chaque frappe au clavier dans le champ d'inspection déclenche une évaluation immédiate avec le texte en cours de frappe :
`"T"`, puis `"To"`, puis `"Tot"`, puis `"Toto"`.

Une accumulation naïve dans un `Set` persistant aurait pollué définitivement la liste déroulante de tous les `variable/get` avec ces fragments de saisie éphémères.

### La Solution : Double-Buffering par Step
Tsuji utilise deux dictionnaires (`liveRegistrations` et `pendingRegistrations`) rythmés par `ctx.step` :

```typescript
function register(step: number, name: string, type: VariableType): void {
  if (step !== currentStep) {
    liveRegistrations = pendingRegistrations;
    pendingRegistrations = new Map();
    currentStep = step;
  }
  pendingRegistrations.set(name, { type });
}
```

- Un nom ne subsiste dans le menu déroulant que s'il est **activement maintenu par un nœud `variable/set` lors des frames récentes**.
- Dès qu'un auteur cesse de taper ou supprime un nœud, les fragments intermédiaires disparaissent automatiquement en une frame ou deux, sans besoin de ramasse-miettes complexe.

---

## 4. Cycle de Vie et Simulation Reset

- **Persistance Multi-Canvas** : Le dictionnaire de stockage est global au runtime Tsuji. Un changement de canvas actif (`Go To Canvas`) conserve toutes les variables écrites.
- **Purge à la Réinitialisation** : Lors d'un Reset Universel (`Shift+Space`, voir [[Simulation Reset and Epoch Architecture]]), le store de variables est remis à zéro (`store.clear()`), garantissant qu'aucune valeur polluée d'une simulation antérieure ne contamine le redémarrage.

---

## 🔗 Notes Associées
- [[State Management and Multi-Canvas]]
- [[Simulation Reset and Epoch Architecture]]
- [[Graph Evaluation Runtime]]
- [[Node Catalog]]

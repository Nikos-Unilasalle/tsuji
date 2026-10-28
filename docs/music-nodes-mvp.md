# Nodes musique — plan de MVP

Faire de la musique dans tsuji, en nodes : un tracker FM façon **KAWA** et un groovebox live façon **SLOOP**, dans le même graphe que l'image, et exportés à l'échantillon près avec la vidéo.

## 1. Ce que font les références

| | SLOOP (isod89/sloop-fm1) | KAWA (guizmoh/Kawa-Tracker-Fm1) |
|---|---|---|
| Nature | Firmware C pour le M-VAVE FM-1, basé sur Felucca | Firmware C pour le FM-1, basé sur Dinghy, Felucca et SLOOP |
| Esprit | Groovebox live : 3 synthés + 1 boîte à rythmes, on joue, on enregistre en boucle | Tracker chiptune/IDM : lignes = steps, colonnes = pistes |
| Moteurs | 12 moteurs (FM6 DX7, analog, grain, phys, noise, sample…) | Pulse, wave 4 bits, noise, FM 6 opérateurs, kit de batterie, sample |
| Séquence | Steps, p-locks, micro-timing, fills, sections A–D, song, arp | Patterns 16/32/64, cellule = note + volume + 2 effets, chaîne de patterns, tables, groove |
| Web | Éditeur web (piano roll, MIDI, live) | **Émulateur : le firmware compilé en WASM, joué dans un AudioWorklet** |
| FM | msfa (moteur de Dexed) | msfa |
| Licence | **GPL-3.0** | **GPL-3.0** |

À en retenir :
- L'architecture de l'émulateur KAWA (DSP en WASM dans un AudioWorklet) est celle qu'il faut à tsuji.
- **Licence :** tsuji passe en GPL-3.0 (décision du 2026-10-28). On peut donc porter du code de SLOOP, KAWA et Felucca (modes d'arpège, kits de batterie synthétisés, valeurs de patchs), en citant les auteurs et en gardant leurs mentions de copyright. msfa (le moteur FM de Dexed, Apache-2.0) est compatible avec la GPL-3.0.

## 2. Ce qui existe déjà dans tsuji

- Catégorie `sound` ([sound.ts](../src/shared/graph/nodes/sound.ts)) : Audio Player, Synth, Spectrum, Peak Detector, Microphone.
- `Audio Synth` actuel : un `OscillatorNode` créé et modifié à chaque frame. Il est hors de l'export.
- Export audio hors ligne ([exportAudioCapture.ts](../src/shared/audio/exportAudioCapture.ts)) : les clips calés sur la timeline sont rejoués dans un `OfflineAudioContext`, alignés sur les frames. Les synths n'y sont pas.
- Une chaîne de build WASM en Rust (`npm run build:wasm`, `wasm/kernels`) pour la géométrie.
- Des éditeurs de paramètres dédiés (`color_ramp`, `curve_profile`, `topography_bands`) : le modèle pour un éditeur de pattern.

## 3. Principe d'architecture

**Le graphe décrit, le moteur joue.**

Le graphe est évalué une fois par frame (~60 Hz), alors que le son se calcule à 48 kHz. Les nodes musique ne produisent donc jamais d'échantillons : ils produisent une **description** (un patch, des patterns, une horloge), et ces descriptions sont pures (`pure: true`, donc mémoïsées).

```
 Graphe (par frame)                       Moteur (par échantillon)
 ┌───────┐  ┌─────────┐  ┌──────────┐      ┌─────────────────────────┐
 │ Clock │→ │ Pattern │→ │ FM Voice │→ ... │ MusicEngine (worklet)   │
 └───────┘  └─────────┘  └──────────┘      │  séquenceur + voix + mix│
                     │                     └─────────────────────────┘
                     └→ Note Probe → valeurs pour les visuels
```

- **Un seul `MusicEngine` par scène**, dans un `AudioWorklet`. Le node `Music Out` envoie la description complète au worklet, uniquement quand elle change (diff, `postMessage`).
- **Le séquençage se fait dans le moteur**, à l'échantillon près, et pas dans le graphe. Sinon on aurait une gigue de ±16 ms.
- **Le temps vient de la timeline.** Position musicale = f(temps timeline, BPM). Lecture, pause, seek et boucle de la timeline pilotent le moteur, comme `clipPlan` pour l'Audio Player.
- **Déterminisme :** le cœur DSP est un module pur, `render(desc, startSample, n) → Float32Array`. Le même code tourne dans le worklet (temps réel), dans l'export (rendu hors ligne de toute la durée, puis mixé avec les clips) et dans les tests vitest.
- **Seek :** l'état d'une voix FM dépend de son passé (enveloppes, feedback). Au seek, le moteur re-rend en silence depuis le dernier note-on actif. L'export, lui, rend toujours depuis la frame 0.
- **Visuels pilotés par la musique sans passer par l'audio :** `Note Probe` calcule gate, pitch, vélocité et enveloppe *analytiquement*, à partir du pattern et du temps. C'est exact et identique en export, sans analyse FFT.

### Langage du DSP

Recommandé : **TypeScript dans le worklet** pour le MVP. Pas d'étape de build, itération rapide, testable dans vitest. Un FM 4 opérateurs × 8 voix × 4 pistes tient sans problème en JS sur Float32Array. On portera la boucle chaude en Rust/WASM (la chaîne existe déjà) seulement si le profilage l'exige, ou pour intégrer msfa (FM 6 opérateurs, patchs DX7).

## 4. Périmètre du MVP

### Nodes

| Node | Entrées | Sorties | Rôle |
|---|---|---|---|
| `music/clock` | BPM, swing, mesure | `clock` | Tempo, grille, liaison à la timeline |
| `music/pattern` | clock, longueur (16/32/64) | `pattern`, step courant | Grille de tracker : note, **accord**, vélocité, 1 colonne d'effet par step |
| `music/arp` | pattern, mode, vitesse, octaves, gate | `pattern` | Arpège les accords (et les notes tenues) du pattern |
| `music/fm-voice` | pattern, paramètres | `track` | FM 4 opérateurs, 8 algorithmes, ratio / niveau / feedback, ADSR par opérateur, polyphonie 8 voix |
| `music/drum-kit` | pattern | `track` | Kick / snare / hat / clap synthétisés (pas de samples dans le MVP) |
| `music/out` | N pistes (entrées dynamiques), master | — | Mixer (niveau, pan, mute), envoie au moteur, branche l'export |
| `music/note-probe` | pattern ou track | gate, pitch, vélocité, env, step | Le pont vers l'image |

Toutes les entrées numériques restent des sockets `value`. On peut donc moduler un ratio FM avec la vitesse d'une particule, à la cadence des frames. Le moteur lisse les valeurs (rampe de 5 ms) pour éviter les clics.

### Colonne d'effet du MVP (sous-ensemble KAWA)

`GLD n` (glide), `RTG n` (ratchet / roll), `CHN n` (probabilité, graine fixe pour rester déterministe), `OFF` (note-off).

Pas d'effet `ARP xy` façon chiptune : le node `music/arp` le remplace. À la vitesse 1/64, il donne le même arpège « console ».

### Accords

Chaque cellule du pattern a une colonne **accord**, à côté de la note. Une seule note fondamentale suffit : `C-4 min7` joue do, mi♭, sol, si♭.

| Code | Accord | Intervalles (demi-tons) |
|---|---|---|
| `maj` | majeur | 0 4 7 |
| `min` | mineur | 0 3 7 |
| `7` | septième (dominante) | 0 4 7 10 |
| `9` | neuvième (dominante) | 0 4 7 10 14 |
| `sus` | sus4 | 0 5 7 |
| `dim` | diminué | 0 3 6 |

En plus, si c'est peu coûteux (une ligne par accord dans la table) : `maj7` (0 4 7 11), `min7` (0 3 7 10), `sus2` (0 2 7), `dim7` (0 3 6 9), `aug` (0 4 8).

- **Renversement** (0 à 3) et **étalement** (accord serré ou ouvert sur deux octaves), par cellule, avec une valeur par défaut au niveau du pattern.
- Les accords sont une table de données, pas du code : on en ajoute un en ajoutant une ligne.
- Une entrée `value` « type d'accord » sur le pattern permet aux visuels de choisir l'accord (par exemple la hauteur d'un objet → maj ou min).

### Arpège

`music/arp` transforme le flux de notes : chaque accord (ou groupe de notes tenues) devient une suite de notes simples.

- **Modes :** up, down, up-down, down-up, ordre joué, aléatoire. L'aléatoire est seedé, pour que l'export soit identique à la lecture. D'autres modes viendront après, inspirés des 15 modes de Felucca et SLOOP (converge, diverge, thumb, pinky…).
- **Vitesse :** 1/4, 1/8, 1/16, 1/32, 1/64, plus les triolets, calée sur la clock.
- **Octaves :** 1 à 4. **Gate :** 10 à 100 % de la durée d'un pas.
- **Synchronisation :** calée sur la grille de la clock par défaut (l'arpège tombe toujours sur les temps), ou relancée à chaque nouvel accord.
- Comme c'est un node, on peut l'insérer ou le retirer sur un fil, et moduler la vitesse ou le mode depuis le graphe.

Le séquenceur pur fait l'expansion dans cet ordre : **note + accord → renversement / étalement → arpège → effets (glide, ratchet, chance)**. Chaque étape est une fonction pure, testée séparément.

### Éditeur de pattern : un HUD dans la vue 3D

Demandé le 2026-10-28 : comme les autres nodes qui ont un HUD dans la vue 3D (Biped Dance, Route, Pose, Brush…), le Pattern s'édite **dans la vue 3D, quand il est sélectionné**. Pas dans le panneau de paramètres. Le modèle est `DanceHud.tsx`, une grille de temps avec le playhead lu à chaque frame d'animation, des cellules cliquables et une étape d'annulation par geste, écrite par `onParams`.

- **La grille :** une case par pas, 16 par ligne (une mesure), une ligne par mesure (1, 2 ou 4 lignes pour 16, 32 ou 64 pas). La note et l'accord sont écrits dans la case, la vélocité est rendue en intensité, et l'effet par un petit badge. Le pas joué s'allume en direct.
- **Saisie au clavier façon tracker** :
  - les rangées `Z–M` et `Q–U` jouent les notes ;
  - les flèches déplacent le curseur ;
  - `Suppr` efface, `0` écrit un OFF ;
  - octave ± ;
  - après chaque note, le curseur avance d'un pas (avance réglable).
- **Barre du bas** : accord (les 11, avec renversement et étalement), vélocité, effet (GLD / RTG / CHN et sa valeur), longueur du pattern, transpose.
- **Écoute** de la note pendant la saisie, par le moteur de Music Out s'il y en a un.
- Le HUD écrit le même paramètre texte `steps` (notation.ts) : rien ne change pour les fichiers, et le champ texte reste pour qui le préfère.
- Pour un Pattern branché sur un Drum Kit, la grille prend la forme d'une boîte à rythmes : une ligne par son (kick, snare, hat…) et un clic par pas.

### Export

`webCodecsExport` appelle `renderMusic(desc, 0, totalSamples)` hors ligne, puis le mixe avec la piste issue de `exportAudioCapture`. Pas de capture frame par frame : le rendu musical est une fonction pure du temps.

## 5. Étapes

| # | Étape | Critère « fini » |
|---|---|---|
| 0 | **Spike** : worklet minimal (FM 2-op) dans Vite **et dans le WKWebView de Tauri** | Son stable, pas de craquement, latence mesurée, worklet chargé dans le build Tauri |
| 1 | Cœur DSP pur : opérateur, ADSR, algorithmes, voix, mix | Tests vitest : rendu identique bit à bit sur deux appels, pas de NaN, pas de dénormaux |
| 2 | Séquenceur pur : clock + pattern → événements datés à l'échantillon, accords, arpège, swing, effets | Tests : positions des notes exactes à 120 et 137 BPM, intervalles de chaque accord, chaque mode d'arpège, swing, ratchet |
| 3 | `MusicEngine` worklet + `music/out` + diff des descriptions + liaison timeline (play / pause / seek / boucle) | Lecture synchronisée au playhead, seek sans clic |
| 4 | Nodes `clock`, `pattern`, `arp`, `fm-voice`, `drum-kit`, `note-probe` + enregistrement + catégorie `music` | Démo jouable construite uniquement au graphe, avec une suite d'accords arpégée |
| 5 | **HUD Pattern dans la vue 3D** (modèle : DanceHud) + saisie clavier | Écrire un pattern de 16 steps sans souris, sans quitter la vue 3D |
| 6 | Intégration export | Vidéo exportée : kick et flash visuel sur la même frame, vérifié à l'échantillon |
| 7 | Démo dans le menu Démos : un pattern FM qui pilote une scène | — |

### Résultats du spike (étape 0, 2026-10-28, Apple M1)

Code : `src/shared/music/dsp/fm.ts` (cœur FM pur, testé) et `src/shared/music/spike/` (worklet + panneau de test, dev seulement).

| | Node (vitest) | Chrome (aperçu Vite) | Tauri (WKWebView) |
|---|---|---|---|
| Pire cas, 96 opérateurs | 125 µs / bloc, 4,7 % d'un cœur | 125 µs / bloc, 4,7 % | **111 µs / bloc, 4,2 %** |
| Blocs par seconde | — | 375 (= 48 000 / 128) | 375, stable pendant 30 s sous charge |
| Latence (base / sortie) | — | 5,3 ms / 16,0 ms | **2,7 ms / 2,5 ms** |
| `performance.now()` dans le worklet | — | non | non |

Ce qu'on en retient :
- **Le budget de 4 pistes × 8 voix passe largement**, avec environ 20 fois de marge. On peut garder le DSP en TypeScript. Rust/WASM n'est nécessaire que pour msfa (FM 6 opérateurs).
- **Charger le worklet avec `?worker&url`** : Vite compile le TypeScript et ses imports en un seul script autonome (4,4 Ko), en dev comme au build. Avec un simple `new URL()`, le `.ts` serait copié tel quel, sans être compilé.
- **Il n'y a pas d'horloge fine dans le worklet**, ni dans Chrome ni dans WebKit. Le coût se mesure donc par calibration au démarrage (des milliers de blocs chronométrés avec `Date.now()`), pas à chaque bloc.
- **Les notes démarrent à l'échantillon près** : le bloc est découpé au moment exact de chaque note-on (`currentFrame`). C'est le modèle du futur séquenceur.
- **Dans Tauri**, ⌘⌥⇧M n'atteint pas la page (WKWebView le garde), et l'AudioContext a besoin d'un vrai clic. Il faudra en tenir compte pour les raccourcis du futur éditeur de pattern.
- Pas encore vérifié : l'écoute (craquements éventuels), la fenêtre en arrière-plan, et le build Tauri de release.

### Étape 1 — cœur DSP (2026-10-28)

Fichiers dans `src/shared/music/dsp/` :
- `algorithms.ts` : les 8 algorithmes 4 opérateurs de la famille Yamaha (DX100 / TX81Z), feedback sur l'opérateur 4, sous forme de matrice de routage.
- `fm.ts` : `FmSynth`. Par opérateur : ratio, detune (cents), niveau, sensibilité à la vélocité, ADSR. Par patch : algorithme et feedback (moyenné sur deux échantillons, comme sur le DX, pour rester stable). Phases remises à 0 à chaque note (« key sync »).
- `mix.ts` : `Mixer` stéréo (niveau, pan à puissance constante, mute, master), soft clip au-dessus de 0,8.
- `worstCase.ts` : le patch et les synthés du pire cas, partagés par le benchmark et le worklet.

Choix faits :
- **Voix :** une note déjà jouée reprend sa voix (pas de clic, pas de doublon). Sinon on prend une voix libre. Sinon on vole la plus ancienne voix relâchée, puis la plus ancienne tenue, avec un fondu de 2 ms avant la nouvelle note.
- **Lissage :** les niveaux d'opérateur, le feedback, les niveaux et pans du mixeur glissent en 5 ms. Le lissage est calculé à chaque échantillon et jamais par bloc : la sortie est identique bit à bit quel que soit le découpage (testé avec des blocs de 37, 128 et 1000 échantillons).
- **Pas de dénormaux :** une enveloppe sous −120 dB passe exactement à 0, et une voix se libère quand tous ses porteurs sont silencieux.

Mesures : 28 tests ; pire cas **208 µs par bloc, 7,8 % d'un cœur M1** (Node), 205 µs / 7,7 % dans le worklet Chrome. C'est plus que les 4,7 % du spike, qui n'avait que 2 opérateurs sans routage ni lissage. Il reste 13 fois de marge. Si un jour il en faut plus, la première piste est de dérouler la boucle de modulation pour 4 opérateurs fixes.

### Étape 2 — séquenceur (2026-10-28)

Fichiers dans `src/shared/music/seq/` :
- `chords.ts` : les 11 accords (les 6 demandés et 5 en plus), le renversement et l'étalement. Les accords sont une table de données.
- `arp.ts` : 6 modes (up, down, up-down, down-up, ordre joué, aléatoire seedé), 5 vitesses de 1/4 à 1/64 avec triolets, 1 à 4 octaves, gate, synchro grille ou relance.
- `sequencer.ts` : clock (BPM, swing, pas par temps), pattern (cellules : note ou OFF, accord, renversement, étalement, vélocité, longueur, effet), et trois questions posées sans état :
  - `notesStartingIn(seq, sr, from, to)` : les notes qui commencent dans un bloc ;
  - `notesSoundingAt(seq, sr, t)` : les notes qui sonnent à un instant donné (pour le seek et pour Note Probe) ;
  - `stepAt` / `stepSample` : quel pas joue à un instant donné, et à quel échantillon commence un pas.
- `hash.ts` : le hash seedé, seule source de hasard (effet CHN, arpège aléatoire).
- `FmSynth` gagne le **glide** : la note part d'une autre hauteur et glisse en ligne droite, en demi-tons, y compris sur une voix volée.

Choix faits :
- **Sémantique tracker :** une note sonne jusqu'à la prochaine cellule qui déclenche (note ou OFF), ou pendant sa propre longueur. Le pattern boucle, et la fin d'une note est cherchée à travers la boucle.
- **Pas de dérive :** les temps sont calculés exactement et arrondis à l'échantillon seulement quand une note est émise. À 137 BPM, le pas 548 tombe pile sur l'échantillon 2 880 000.
- **Swing :** chaque pas impair est retardé, jusqu'à un demi-pas (75/25 à swing 1).
- **Effets :**
  - `GLD n` glisse depuis la note précédente en n × 10 ms, l'accord se déplaçant en parallèle ;
  - `RTG n` frappe n fois dans le pas, et la dernière frappe tient jusqu'à la fin de la note ;
  - `CHN n` joue la cellule avec n % de chances, de façon reproductible. Une cellule sautée laisse sonner la note précédente.
- **Arpège + effets :** quand l'arpège est actif, il remplace le ratchet et le glide de la cellule.
- Quand une note se termine sur l'échantillon où une autre commence, le note-off passe avant le note-on.

Mesures : 63 tests sur la musique (35 de plus). Les notes sont identiques quelle que soit la taille des blocs (37, 61, 128, 5000 échantillons, ou un seul appel), arpège aléatoire compris. Le glide ne coûte rien quand il n'est pas utilisé (pire cas 7,9 %).

Un vrai bug trouvé par les tests : `isChordName("toString")` répondait vrai (l'opérateur `in` remonte le prototype). C'est corrigé avec `hasOwnProperty`.

Dans le worklet de spike, deux pistes séquencées jouent : une suite d'accords Cmaj7 – Am7 – Fmaj7 – G7 arpégée, et une basse avec glide et ratchet. Dans Chrome : 8 à 11 voix, 375 blocs/s, aucune erreur. L'ordonnanceur du worklet (note-ons, note-offs en attente, découpage du bloc) n'est pas encore testé : il sera extrait et testé à l'étape 3, avec le moteur.

### Étape 3 — moteur et Music Out (2026-10-28)

Fichiers :
- `src/shared/music/engine/description.ts` : ce que le graphe envoie au moteur (pistes : id, patch, séquence, voix, niveau, pan, mute ; master). Des données simples, qui passent par `postMessage`.
- `src/shared/music/engine/core.ts` : `EngineCore`, sans Web Audio. Il contient :
  - les pistes (un `FmSynth` chacune, à travers le `Mixer`) ;
  - le transport (`play`, `pause`, `seek`, `follow`) ;
  - l'ordonnanceur extrait du spike, qui place chaque note-on et note-off sur son échantillon exact.
  Il est testé (12 tests).
- `src/shared/music/engine/engine.worklet.ts` : `EngineCore` dans l'AudioWorklet. Il compense la latence des messages et renvoie son état (position, voix, recalages) toutes les 250 ms.
- `src/shared/music/engine/bridge.ts` : côté page, un `AudioWorkletNode` par node Music Out. Le module est chargé une fois par contexte audio, la description n'est envoyée que si elle a changé, et le playhead à chaque frame.
- `src/shared/graph/nodes/music.ts` : le node **Music Out** (`music/out`).
- `src/shared/music/demo.ts` : les deux pistes de démo, partagées par le spike et par la case « Demo » de Music Out.
- Nouveau type de socket **`music`** (rouge, forme pentagone dans l'export SVG) et nouvelle catégorie **Music** (fuchsia).

Comment le moteur suit la timeline :
- La position du morceau découle directement du playhead : `(frame − Start Frame) / fps`. Le calcul est identique en lecture et en export.
- Le moteur garde sa propre horloge, exacte à l'échantillon. Il ne saute que si le playhead s'en écarte de plus de 80 ms, comme l'Audio Player. Un seek ou une boucle de la timeline déclenche donc un saut, mais pas les pas grossiers du frame rate.
- Pause : plus aucune nouvelle note, et les notes en cours s'éteignent sous leur release.
- Seek : les notes en cours sont relâchées, et celles qui devraient déjà sonner à la nouvelle position sont lancées. Une note qui commence pile à la cible est laissée à l'ordonnanceur, sans double frappe.
- Avant Start Frame, le moteur est silencieux. Pendant un export, il se tait (la bande-son sera rendue hors ligne à l'étape 6). Comme l'Audio Player, un seul viewport le pilote à la fois.
- Si on modifie une piste en cours de lecture, le moteur relâche les notes que la nouvelle séquence ne tient plus et garde les autres. Une piste retirée est relâchée puis supprimée.

Mesures dans l'app (Chrome, panneau visible), timeline de 120 frames à 30 fps :
- **Un seul recalage par tour, la boucle elle-même**, pendant 13 s de lecture. Aucune dérive.
- Pause : arrêt à la position exacte, voix à 0 en environ 1,2 s (fin des releases).
- Seek en lecture vers la frame 90 : le moteur passe à 3,09 s, et les voix continuent sans trou.
- Seek à l'arrêt vers la frame 60, puis Play : le moteur démarre à 2,0 s avec 4 voix qui sonnent déjà.
- **Attention aux mesures avec le panneau masqué** : la page passe en arrière-plan, le rendu est bridé et le playhead avance plus lentement que le temps réel. Le moteur se recale alors environ 2 fois par tour. Ce n'est pas un défaut du moteur, mais ça montre qu'un rendu très lent (moins de ~25 fps) ferait des accrocs. Si ça arrive en vrai, on pourra élargir la tolérance ou faire suivre au moteur la vitesse du playhead.

Ce que les tests du moteur ont fait corriger :
- Une piste créée muette démarrait au niveau par défaut et glissait jusqu'à 0 : on entendait 5 ms de son. Le canal est maintenant créé avec ses réglages.
- Le mixeur identifiait ses canaux par index, ce qui ne permettait pas de retirer une piste. Il les identifie maintenant par id.
- Deux attentes de test mal posées (seuil de clic et soft clip), corrigées dans les tests.

Limites :
- **Case « Demo » provisoire** : elle sera retirée à l'étape 4, quand les nodes de piste existeront.
- En dev, si on modifie `engine.worklet.ts` à chaud, il faut recharger la page. Le contexte audio garde l'ancien processeur enregistré sous le même nom.
- Pas encore testé dans Tauri. Ce n'est pas encore écouté.
- En dev, `window.__tsujiMusic()` renvoie l'état des moteurs (position, voix, recalages) pour vérifier ce que font les haut-parleurs.

### Étape 4 — les nodes (2026-10-28)

La catégorie **Music** a maintenant sept nodes (`src/shared/graph/nodes/music.ts`) :

| Node | Entrées | Sortie | Rôle |
|---|---|---|---|
| **Clock** | BPM, Swing | `clock` | Tempo, swing, pas par temps (2, 3, 4, 6, 8) |
| **Pattern** | Clock, Transpose, Chord, Velocity × | `sequence` | Le pattern en notation texte, longueur 16/32/64, seed |
| **Arp** | Sequence, Octaves, Gate, On | `sequence` | Mode, vitesse, triolets, octaves, gate, synchro |
| **FM Voice** | Sequence, Level, Pan, Brightness ×, Mute | `track` | 8 presets, algorithme, feedback, 4 × 8 réglages d'opérateur, polyphonie |
| **Drum Kit** | Sequence, Level, Pan, Tune, Decay ×, Mute | `track` | 7 sons synthétisés (kick, snare, clap, hat, open hat, deux toms) |
| **Note Probe** | Sequence / Track, Start Frame, Decay | gate, trigger, pitch, pitch 0–1, velocity, envelope, count, step, notes | Ce qui joue au playhead, pour la scène |
| **Music Out** | Master, Start Frame, Track 1… | time, beat, step, playing | Joue les pistes, calé sur la timeline |

Ce qui circule entre eux : un seul type de socket, `music`, qui porte une clock, une séquence ou une piste (`description.ts`). Chaque node lit la forme qu'il attend et ignore les autres. Une séquence branchée directement dans Music Out joue sur le piano électrique par défaut.

**La notation des patterns** (`src/shared/music/seq/notation.ts`), en attendant l'éditeur de l'étape 5. C'est un mot par pas :
- `.` : vide ;
- `off` : arrête la note ;
- `C4:maj7` : note et accord (C4 = MIDI 60, `C-4`, `F#3` et `Bb2` marchent aussi) ;
- `/1` : renversement ;
- `^` : accord étalé ;
- `@0.6` : vélocité ;
- `~2` : longueur en pas ;
- `!GLD12`, `!RTG3`, `!CHN50` : glide, ratchet, chance ;
- `kick+hat` ou `C4+E4+B4` : des notes frappées ensemble (ajouté pour la batterie, utile aussi pour des voicings libres) ;
- les noms de batterie (`kick`, `snare`, `clap`, `hat`, `openhat`, `tomlow`, `tomhigh`), qui suivent la carte General MIDI.

Autres ajouts :
- `src/shared/music/dsp/presets.ts` : les 8 presets FM (E. Piano, Bass, Bell, Pad, Lead, Organ, Pluck, Chip). Choisir un preset remplit les 32 réglages d'opérateur, qu'on peut ensuite retoucher. Un fichier qui ne nomme que le preset reçoit ses réglages au chargement (`upgradeParams`).
- `src/shared/music/dsp/drums.ts` : `DrumSynth`. Une voix par son, le hat fermé coupe le hat ouvert, et le bruit est seedé (rendu identique quelle que soit la taille des blocs).
- Le moteur joue des pistes FM et des pistes de batterie, à travers une interface `Instrument` commune.
- **Brightness** multiplie les niveaux des modulateurs seulement : le timbre change, pas le volume. C'est une bonne prise pour les visuels.
- **Pattern** peut transposer, forcer un accord et changer la vélocité depuis des fils : ce sont les visuels qui pilotent la musique.
- **La case « Demo » de Music Out est retirée.** Elle est remplacée par une vraie démo dans le menu : **Démos → Music → Band** (`public/demos/demo_music_band.tsuji`, générée par `tools/gen_music_demo.py`). Elle contient Clock, trois patterns de 64 pas, un arpège, deux FM Voice (E. Piano, Bass), un Drum Kit, Music Out et une Note Probe, sur 240 frames à 30 fps, soit les 8 s du morceau.

Vérifié dans l'app (Chrome, panneau visible) : la démo Band se charge et joue. La boucle de 8 s tombe sur celle de la timeline, avec un seul recalage par tour (à la boucle) en 20 s, et 12 à 13 voix.

Ce que les tests ont fait corriger :
- `CHORD_NAMES` commençait par « 7 » et « 9 » : JavaScript met les clés numériques en tête dans `Object.keys`. Le menu Force Chord et l'entrée numérique étaient décalés. L'ordre est maintenant écrit en dur.
- Le seuil de silence de la batterie (−100 dB) gardait le kick « actif » plus de 3 s. Il est passé à −80 dB.
- Le `trigger` de Note Probe manquait une note jouée sur le tout premier échantillon.

Tests : 4 465 + 5 (notation `+`, `upgradeParams`), dont 17 sur les nodes.

Limites :
- Pas encore d'éditeur de grille : on édite les patterns dans un champ texte d'une ligne (étape 5).
- Note Probe a son propre Start Frame, à garder égal à celui de Music Out.
- Pas écouté, pas testé dans Tauri.
- Dans l'aperçu, la console reçoit en continu « THREE.WebGLRenderer: Texture marked for update but no image data found ». Ça n'a rien à voir avec la musique (aucun code de texture touché) et c'était déjà le cas avant cette étape.

### Étape 5 — HUD Pattern dans la vue 3D (2026-10-28)

Fichiers :
- `src/shared/three/PatternHud.tsx` : le HUD, monté par `Viewport.tsx` quand un node Pattern est sélectionné (même condition que les palettes du rig : pas en mode sortie, pas en vue d'élévation).
- `src/shared/music/seq/patternEdit.ts` : ce que fait le HUD, en fonctions pures testées (clavier → note, pose et effacement de cellules, frappes de batterie, curseur, longueur).
- Le moteur sait **faire écouter une note** (`previewNote`). Elle passe par un instrument sur son propre canal, entendu même transport à l'arrêt, et relâché au bout de 0,35 s. Le HUD l'utilise avec le patch de la FM Voice (ou les réglages du Drum Kit) branchée en aval du Pattern.

Ce que fait le HUD :
- **Grille mélodique :** 16 pas par ligne, une ligne par mesure. Chaque case montre la note et l'accord (renversement, `^` pour un accord étalé). L'intensité rend la vélocité, et un badge jaune marque l'effet. OFF est en rouge. Le pas joué s'allume pendant la lecture : il est lu à chaque frame d'animation, à partir du playhead, du fps du Render, de la clock branchée et du Start Frame de Music Out.
- **Grille batterie**, dès que le Pattern alimente un Drum Kit : une ligne par son, un clic pose ou retire une frappe. Les frappes d'un même pas restent dans l'ordre du kit (`kick+hat`, jamais `hat+kick`).
- **Clavier façon tracker**, par position physique des touches (identique en QWERTY et en AZERTY) :
  - `Z`–`M` jouent une octave depuis do, `Q`–`P` l'octave au-dessus, les touches noires sur la rangée du dessus ;
  - `1` écrit un OFF, `⌫` efface ;
  - les flèches déplacent le curseur ;
  - `[` `]` changent l'octave ;
  - `Esc` rend le clavier ;
  - `Espace` lance ou arrête la lecture, comme ailleurs.
  En vue batterie, `Z X C V B N M` frappent kick, snare, clap, hat, open hat et les deux toms au curseur.
- Le clavier passe par un `<input>` invisible qui prend le focus. Les raccourcis globaux (App, Viewport, GraphEditor) ignorent les touches quand un INPUT a le focus, donc taper une note ne déclenche rien d'autre. Les raccourcis avec ⌘ / Ctrl / Alt (annuler…) restent ceux de l'app.
- **Barre du bas :** accord, renversement, étalement, vélocité, longueur et effet (glide, ratchet, chance, avec sa valeur). Elle modifie la case sous le curseur, et c'est aussi le « pinceau » des notes qu'on tape ensuite.
- En haut : la longueur (16, 32 ou 64), l'octave, l'avance du curseur (0, 1, 2 ou 4) et Effacer tout.
- Chaque geste écrit le paramètre texte `steps` en une étape d'annulation : le HUD et le champ texte sont le même pattern.

Vérifié dans l'app (démo Band) :
- Le HUD s'ouvre à la sélection du Pattern des accords et montre les 4 mesures.
- Au clavier, un clic sur le pas 5 puis `Z`, `C` et `1` donnent `C4 E4 off`, et le curseur avance. `Q` au pas 9 donne C5. Une voix d'écoute sonne pendant que le transport est à l'arrêt.
- La vue batterie s'ouvre pour le troisième Pattern. Un clic sur Clap au pas 3 puis `Z` donnent `kick+clap+hat@0.5`, la vélocité est gardée.
- Pendant la lecture, le pas allumé avance : « Bar 1 · step 11 » après 1,3 s à 120 BPM, puis « Bar 2 · step 4 ».

Limites :
- Le panneau de paramètres, quand il est ouvert, recouvre la droite du HUD (comme pour les autres HUD).
- Pas encore de sélection de plusieurs cases, ni copier / coller ou décalage.
- Le son de l'écoute n'a pas été écouté, seulement compté (1 voix active).
- Pas testé dans Tauri.

### Sons et morceaux repris des firmwares FM-1 (2026-10-28)

Point de départ : [aroum/fm1-custom-fw](https://github.com/aroum/fm1-custom-fw), un annuaire des firmwares du FM-1 (environ 30, presque tous dérivés de Felucca et sous GPL-3.0). L'annuaire n'a ni sons ni morceaux lui-même. Tout ce qui suit vient des dépôts qu'il référence. Ces dépôts sont sous **GPL-3.0-only, comme tsuji**, et chaque fichier repris cite son auteur et son origine.

| Repris | De | Où chez nous |
|---|---|---|
| 8 sons du moteur DIGITAL (E.PIANO, BELL, BASS, BRASS, ORGAN, PAD, MARIMBA, FUNK KEY) | **Felucca**, Leo Kuroshita / Hügelton Instruments — `firmware/src/fm4_convert.c` | `src/shared/music/dsp/fm4Import.ts` |
| 21 sons DIGITAL (RHODES, DX RHODES, WURLI, CLAV, M1 PIANO, AFRO KEYS, TRAP BELL, MUSIC BOX, KALIMBA, PLUGG BELL, GLASS PAD, FM BASS, STEEL DRUM, GLOCKEN, CELESTA, XYLOPHONE, HARP, BASS GTR, TUBE BELL, FM PLUCK, FM GRAND) | **SLOOP**, isod89 — `firmware/src/eng_digital.c` | idem |
| 10 phrases d'usine (ACID, OFFBEAT, MELODY, LEAD, PAD, KEYS, BELL, SUB, BEAT, ARP) | **Felucca** — `firmware/src/engines.c`, PATTERNS | `src/shared/music/seq/phrases.ts`, menu « Load Phrase » du Pattern |
| Le morceau de démo « KAWA QUEST » | **KAWA**, Omnipotard — `source/firmware/src/kawa_edit.c`, `prj_demo()` | `tools/gen_music_kawa_quest.py` → Démos → Music → KAWA QUEST |

**Pourquoi le moteur DIGITAL :** c'est exactement notre architecture (4 opérateurs sinus, les 8 algorithmes Yamaha, feedback sur l'opérateur 4, moyenné sur deux échantillons). Les données sont reprises telles qu'écrites, et `fromFm4()` (testé) les convertit :
- les temps suivent leur courbe, 1 ms × 10000^(v/127), atteints à 99 % comme les nôtres ;
- INDEX 127 donne 2 tours de phase chez eux comme chez nous ;
- les modulateurs démarrent à fond et retombent vers 25 % (leur MODDEC), et sont divisés par deux quand deux modulateurs alimentent un même opérateur (eux font la moyenne, nous la somme) ;
- les porteurs suivent l'ADSR d'amplitude ;
- MONO donne 1 voix, et la transposition de SLOOP est gardée.

Ce qui manque : leur feedback va jusqu'à 2 tours, le nôtre jusqu'à 0,25. Les deux plus forts (CLAV, BRASS) sont donc un peu adoucis. Leurs LFO, glide, enveloppe de filtre et envois d'effets ne sont pas repris, faute d'équivalent chez nous.

Le **FM Voice** liste ces 29 sons après les nôtres, sous la forme « Felucca · E.PIANO » ou « SLOOP · RHODES ». Il a deux nouveaux réglages, chargés avec le preset : **Voices** (1 = mono) et **Transpose**.

**KAWA QUEST** (overworld en do, donjon en la mineur, boss breakcore, victoire) : 7 patterns de 2 mesures, la plupart joués deux fois, à 120 BPM sur 6 pistes. Le morceau est transcrit appel par appel depuis `prj_demo()`, puis mis bout à bout en un pattern de 416 pas par piste (52 s, une timeline de 1560 frames). Ce qui change faute d'équivalent chez nous :
- les moteurs chiptune : le lead pulse passe sur le preset Chip, la basse wave sur Felucca · BASS, les hats noise sur le hat du Drum Kit ;
- le kalimba est celui de SLOOP (celui de KAWA est un patch DX7 6 opérateurs) ;
- le kit SNES est rangé sur nos sons (1 kick, 3 snare, 4 clap, 9 crash → open hat…) ;
- le break samplé du boss est rejoué au Drum Kit, une frappe par tranche ;
- ARP devient l'accord lui-même, GLIDE devient GLD et ROLL un ratchet (8 frappes au plus) ;
- vibrato, reverse, pitch et effets live disparaissent.

Il faudra donc l'écouter en sachant que c'est une adaptation et non l'original.

Pour suivre :
- Le Pattern accepte jusqu'à 1024 pas, pour un morceau entier.
- Le HUD défile verticalement et affiche toute longueur.
- `src/shared/music/demoAudio.test.ts` rend 12 s de chaque démo musicale à travers le vrai moteur. Le test vérifie qu'il y a du son, aucune valeur infinie, et pas de saturation.

Ce qui reste disponible pour plus tard :
- les sons FM6 / DX7 de SLOOP, Felucca, Melodee et KAWA (patchs 6 opérateurs, msfa) : il faudrait un moteur 6 opérateurs ;
- les moteurs chiptune de KAWA (pulse, wave 4 bits, noise) : ils permettraient un KAWA QUEST fidèle ;
- l'enchaînement de patterns (song mode), plutôt qu'un pattern unique de 416 pas ;
- les autres firmwares de l'annuaire (X0X pour 303 / 808 / 909, Hortator pour la batterie, Polly pour les accompagnements…).

## 6. Après le MVP (côté SLOOP / KAWA)

- **Live / looper (SLOOP)** : jeu au clavier de l'ordi et en Web MIDI, enregistrement en boucle quantifié dans un pattern, overdub.
- **Accords live (CHORD+ de SLOOP)** : une touche = un accord, avec modificateurs maj / min / 7 / sus, strum et conduite des voix (voice leading).
- **Plus de modes d'arpège**, et arpège « latch » (hold).
- **Song** : chaîne de patterns, sections A–D, fills.
- **p-locks** (une valeur de paramètre par step) et micro-timing.
- **Tables** KAWA : petite séquence jouée dans chaque note.
- **FM 6 opérateurs + import SysEx DX7** via msfa (Apache-2.0) compilé en WASM.
- Moteurs pulse / wave 4 bits / noise (chiptune), sampler et slicer.
- Effets d'envoi : delay synchronisé au tempo, reverb, drive par piste.
- Sortie Web MIDI : piloter un vrai FM-1 depuis tsuji.
- Export audio seul (WAV) et export / import MIDI.

## 7. Décisions (2026-10-28)

1. **Type de socket `music`** : un nouveau type, ajouté aux 7 de `NODE_AUTHORING.md`, pour les descriptions clock / pattern / track. Couleur à choisir.
2. **Licence : GPL-3.0** pour tsuji. Il reste à ajouter le fichier `LICENSE` et `"license": "GPL-3.0-only"` dans `package.json`, puis à mettre `NOTICE` / crédits à jour à chaque code porté.
3. **Catégorie `music`**, séparée de `sound` (qui garde la lecture de fichiers, le micro et l'analyse).
4. **Polyphonie : 4 pistes, 8 voix par piste FM.**

### Budget CPU

- 3 pistes FM × 8 voix × 4 opérateurs = 96 opérateurs, plus la batterie (quelques oscillateurs et du bruit).
- Un opérateur coûte environ 20 opérations par échantillon (phase, lecture de table de sinus, enveloppe, modulation). Soit 96 × 20 × 48 000 ≈ **92 M opérations/s** dans le pire cas, toutes les voix actives en même temps.
- Un cœur moderne en JS (JIT, Float32Array, pas d'allocation dans la boucle) fait largement plus de 1 G opérations simples par seconde : **moins de 10 % d'un cœur**. Le bloc de rendu de l'AudioWorklet (128 échantillons, soit 2,67 ms) reste large.
- Pourquoi 8 voix et pas 6 : un accord de 9e prend 5 voix, et la release de l'accord précédent continue à sonner pendant le suivant. Avec 6 voix, on couperait des queues de release.
- Au-delà de 8 voix : on vole la voix la plus ancienne déjà relâchée, avec un fondu de 2 ms pour éviter le clic.
- Les voix inactives (enveloppe sous −90 dB) sont ignorées, donc le coût réel suit ce qui sonne vraiment.
- Mesuré par le spike (étape 0, voir §5) : 4,2 % d'un cœur dans le WKWebView de Tauri.

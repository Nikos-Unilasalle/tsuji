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

### Éditeur de pattern

- Nouveau `kind: "pattern_grid"` dans `ParamFieldDef`, rendu dans un panneau dédié (comme `ColorRampEditor`), avec une ouverture en grand dans un tiroir de type `TimelineDrawer`.
- Saisie au clavier façon tracker : rangée `Z–M` / `Q–U` = notes, flèches, `Suppr`, octave ±. Le step joué est surligné en direct.
- Écoute d'une note pendant la saisie.

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
| 5 | Éditeur `pattern_grid` + saisie clavier | Écrire un pattern de 16 steps sans souris |
| 6 | Intégration export | Vidéo exportée : kick et flash visuel sur la même frame, vérifié à l'échantillon |
| 7 | Démo dans le menu Démos : un pattern FM qui pilote une scène | — |

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
- Le spike (étape 0) mesure le vrai coût dans le WKWebView de Tauri. Il vérifie aussi que l'arrière-plan (fenêtre masquée) ne fait pas décrocher le worklet.

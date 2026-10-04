/**
 * CATALOGUE OFFICIEL DES 305 NODES TSUJI (v0.6.3)
 * Exporté directement depuis DEFAULT_REGISTRY
 */

export const CATEGORY_DEFINITIONS = {
  "structure": {
    "fr": "Structure & Scène",
    "en": "Structure & Scene",
    "color": "#00ff66"
  },
  "object": {
    "fr": "Primitives 3D & Géométrie",
    "en": "3D Primitives & Geometry",
    "color": "#00ff66"
  },
  "transform": {
    "fr": "Transformations & Matrices",
    "en": "Transforms & Matrices",
    "color": "#38bdf8"
  },
  "curve": {
    "fr": "Courbes, Splines & Tubes",
    "en": "Curves, Splines & Tubes",
    "color": "#facc15"
  },
  "math": {
    "fr": "Mathématiques & Scalaires",
    "en": "Math & Scalars",
    "color": "#00f0ff"
  },
  "vector": {
    "fr": "Vecteurs & Espace",
    "en": "Vectors & Spatial Math",
    "color": "#38bdf8"
  },
  "compose": {
    "fr": "Composition de Matrices",
    "en": "Matrix Composition",
    "color": "#38bdf8"
  },
  "converter": {
    "fr": "Convertisseurs de Types",
    "en": "Type Converters",
    "color": "#a855f7"
  },
  "text": {
    "fr": "Texte & Typographie Cinétique",
    "en": "Text & Kinetic Typography",
    "color": "#e2e8f0"
  },
  "texture": {
    "fr": "Textures & Surfaces",
    "en": "Textures & Surfaces",
    "color": "#2dd4bf"
  },
  "textureTools": {
    "fr": "Traitement de Textures GPU",
    "en": "GPU Texture Processing",
    "color": "#2dd4bf"
  },
  "instance": {
    "fr": "Instanciation & Clones GPU",
    "en": "GPU Instancing & Clones",
    "color": "#a855f7"
  },
  "lighting": {
    "fr": "Lumières & Environnement",
    "en": "Lights & Environment",
    "color": "#f59e0b"
  },
  "logic": {
    "fr": "Logique & Comparateurs",
    "en": "Logic & Triggers",
    "color": "#00f0ff"
  },
  "io": {
    "fr": "Contrôles I/O & Manette",
    "en": "I/O Controls & Gamepad",
    "color": "#00ff66"
  },
  "list": {
    "fr": "Listes & Tableaux de Données",
    "en": "Lists & Data Arrays",
    "color": "#f97316"
  },
  "sound": {
    "fr": "Audio Réactif & FFT",
    "en": "Audio Reactive & FFT",
    "color": "#ff007f"
  },
  "calibration": {
    "fr": "Calibration & Vidéo-Mapping DLT",
    "en": "Calibration & DLT Mapping",
    "color": "#00f0ff"
  },
  "particles": {
    "fr": "Systèmes de Particules",
    "en": "Particle Systems",
    "color": "#ec4899"
  },
  "postprocess": {
    "fr": "Shaders de Post-Traitement",
    "en": "Post-Processing Shaders",
    "color": "#f43f5e"
  },
  "material": {
    "fr": "Matériaux & Shaders PBR",
    "en": "Materials & PBR Shaders",
    "color": "#a855f7"
  },
  "physics": {
    "fr": "Physique Rapier 3D WASM",
    "en": "Rapier 3D WASM Physics",
    "color": "#ff007f"
  },
  "time": {
    "fr": "Temps, Oscillateurs & Rythme",
    "en": "Time, Oscillators & Rhythm",
    "color": "#facc15"
  },
  "utility": {
    "fr": "Organisation & Utilitaires",
    "en": "Utility & Routing",
    "color": "#94a3b8"
  },
  "hub": {
    "fr": "Interface HUD & Composition",
    "en": "HUD Interface & Layout",
    "color": "#00f0ff"
  }
};

export const FULL_NODES_CATALOG = [
  {
    "id": "utility/reroute",
    "name": "Reroute",
    "category": "utility",
    "summary": {
      "fr": "Reroute — Module nodal utility pour composition 3D et flux de signaux.",
      "en": "Reroute — utility node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "",
        "type": "any",
        "id": "in"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "any",
        "id": "out"
      }
    ]
  },
  {
    "id": "structure/group",
    "name": "Group",
    "category": "structure",
    "summary": {
      "fr": "Group — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Group — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": []
  },
  {
    "id": "structure/group-input",
    "name": "Group Input",
    "category": "structure",
    "summary": {
      "fr": "Group Input — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Group Input — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": []
  },
  {
    "id": "structure/group-output",
    "name": "Group Output",
    "category": "structure",
    "summary": {
      "fr": "Group Output — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Group Output — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": []
  },
  {
    "id": "variable/set",
    "name": "Set Variable",
    "category": "utility",
    "summary": {
      "fr": "Set Variable — Module nodal utility pour composition 3D et flux de signaux.",
      "en": "Set Variable — utility node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "any",
        "id": "value"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "any",
        "id": "value"
      }
    ]
  },
  {
    "id": "variable/get",
    "name": "Get Variable",
    "category": "utility",
    "summary": {
      "fr": "Get Variable — Module nodal utility pour composition 3D et flux de signaux.",
      "en": "Get Variable — utility node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Value",
        "type": "any",
        "id": "value"
      }
    ]
  },
  {
    "id": "time",
    "name": "Time",
    "category": "time",
    "summary": {
      "fr": "Time — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Time — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Seconds",
        "type": "value",
        "id": "seconds"
      },
      {
        "name": "Step",
        "type": "value",
        "id": "step"
      }
    ]
  },
  {
    "id": "time/frame",
    "name": "Frame",
    "category": "time",
    "summary": {
      "fr": "Frame — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Frame — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Frame",
        "type": "value",
        "id": "frame"
      }
    ]
  },
  {
    "id": "time/marker",
    "name": "Marker",
    "category": "time",
    "summary": {
      "fr": "Marker — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Marker — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Index",
        "type": "value",
        "id": "index"
      },
      {
        "name": "Time (s)",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Label",
        "type": "text",
        "id": "label"
      },
      {
        "name": "Since Marker (s)",
        "type": "value",
        "id": "sinceMarker"
      },
      {
        "name": "Duration (s)",
        "type": "value",
        "id": "duration"
      },
      {
        "name": "Triggered",
        "type": "value",
        "id": "triggered"
      }
    ]
  },
  {
    "id": "value/constant",
    "name": "Value",
    "category": "math",
    "summary": {
      "fr": "Value — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Value — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "value/math",
    "name": "Value Math",
    "category": "math",
    "summary": {
      "fr": "Value Math — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Value Math — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "value",
        "id": "a"
      },
      {
        "name": "B",
        "type": "value",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "value/clamp",
    "name": "Clamp",
    "category": "math",
    "summary": {
      "fr": "Clamp — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Clamp — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      },
      {
        "name": "Min",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max",
        "type": "value",
        "id": "max"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "value/map-range",
    "name": "Map Range",
    "category": "math",
    "summary": {
      "fr": "Map Range — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Map Range — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "vector/compose",
    "name": "Compose Vector",
    "category": "compose",
    "summary": {
      "fr": "Compose Vector — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Compose Vector — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Y",
        "type": "value",
        "id": "y"
      },
      {
        "name": "Z",
        "type": "value",
        "id": "z"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "vector",
        "id": "out"
      }
    ]
  },
  {
    "id": "vector/decompose",
    "name": "Decompose Vector",
    "category": "compose",
    "summary": {
      "fr": "Decompose Vector — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Decompose Vector — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ],
    "outputs": [
      {
        "name": "X",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Y",
        "type": "value",
        "id": "y"
      },
      {
        "name": "Z",
        "type": "value",
        "id": "z"
      }
    ]
  },
  {
    "id": "vector/math",
    "name": "Vector Math",
    "category": "math",
    "summary": {
      "fr": "Vector Math — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Vector Math — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "vector",
        "id": "a"
      },
      {
        "name": "B",
        "type": "vector",
        "id": "b"
      },
      {
        "name": "Factor",
        "type": "value",
        "id": "factor"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "vector",
        "id": "out"
      },
      {
        "name": "Value",
        "type": "value",
        "id": "val"
      }
    ]
  },
  {
    "id": "math/distance",
    "name": "Distance",
    "category": "math",
    "summary": {
      "fr": "Distance — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Distance — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A (Vector / Object / Matrix)",
        "type": "any",
        "id": "a"
      },
      {
        "name": "B (Vector / Object / Matrix)",
        "type": "any",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Distance",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Distance Sq",
        "type": "value",
        "id": "distanceSq"
      },
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "object/proximity",
    "name": "Proximity Object",
    "category": "math",
    "summary": {
      "fr": "Proximity Object — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Proximity Object — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target (Object / Vector / Matrix)",
        "type": "any",
        "id": "target"
      },
      {
        "name": "Candidates",
        "type": "any",
        "id": "candidates"
      }
    ],
    "outputs": [
      {
        "name": "Nearest Object",
        "type": "geometry",
        "id": "object"
      },
      {
        "name": "Distance",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Index",
        "type": "value",
        "id": "index"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "vector"
      }
    ]
  },
  {
    "id": "color/constant",
    "name": "Color",
    "category": "math",
    "summary": {
      "fr": "Color — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Color — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Out",
        "type": "color",
        "id": "out"
      }
    ]
  },
  {
    "id": "color/compose",
    "name": "Compose Color",
    "category": "compose",
    "summary": {
      "fr": "Compose Color — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Compose Color — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "R",
        "type": "value",
        "id": "r"
      },
      {
        "name": "G",
        "type": "value",
        "id": "g"
      },
      {
        "name": "B",
        "type": "value",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "color",
        "id": "out"
      }
    ]
  },
  {
    "id": "color/decompose",
    "name": "Decompose Color",
    "category": "compose",
    "summary": {
      "fr": "Decompose Color — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Decompose Color — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      }
    ],
    "outputs": [
      {
        "name": "R",
        "type": "value",
        "id": "r"
      },
      {
        "name": "G",
        "type": "value",
        "id": "g"
      },
      {
        "name": "B",
        "type": "value",
        "id": "b"
      }
    ]
  },
  {
    "id": "color/math",
    "name": "Color Math",
    "category": "math",
    "summary": {
      "fr": "Color Math — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Color Math — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "color",
        "id": "a"
      },
      {
        "name": "B",
        "type": "color",
        "id": "b"
      },
      {
        "name": "Factor",
        "type": "value",
        "id": "factor"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "color",
        "id": "out"
      }
    ]
  },
  {
    "id": "converter/value-to-vector",
    "name": "Value to Vector",
    "category": "converter",
    "summary": {
      "fr": "Value to Vector — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Value to Vector — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ]
  },
  {
    "id": "converter/color-to-vector",
    "name": "Color to Vector",
    "category": "converter",
    "summary": {
      "fr": "Color to Vector — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Color to Vector — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ]
  },
  {
    "id": "converter/vector-to-color",
    "name": "Vector to Color",
    "category": "converter",
    "summary": {
      "fr": "Vector to Color — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Vector to Color — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ],
    "outputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      }
    ]
  },
  {
    "id": "converter/value-to-color",
    "name": "Value to Color",
    "category": "converter",
    "summary": {
      "fr": "Value to Color — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Value to Color — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ],
    "outputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      }
    ]
  },
  {
    "id": "converter/value-to-text",
    "name": "Value to Text",
    "category": "converter",
    "summary": {
      "fr": "Value to Text — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Value to Text — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      },
      {
        "name": "Decimals",
        "type": "value",
        "id": "decimals"
      },
      {
        "name": "Prefix",
        "type": "text",
        "id": "prefix"
      },
      {
        "name": "Suffix",
        "type": "text",
        "id": "suffix"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/constant",
    "name": "Text",
    "category": "text",
    "summary": {
      "fr": "Text — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/concat",
    "name": "Text Concat",
    "category": "text",
    "summary": {
      "fr": "Text Concat — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Concat — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text A",
        "type": "text",
        "id": "textA"
      },
      {
        "name": "Text B",
        "type": "text",
        "id": "textB"
      },
      {
        "name": "Separator",
        "type": "text",
        "id": "separator"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/substring",
    "name": "Text Substring",
    "category": "text",
    "summary": {
      "fr": "Text Substring — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Substring — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Start Index",
        "type": "value",
        "id": "start"
      },
      {
        "name": "Length",
        "type": "value",
        "id": "length"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/length",
    "name": "Text Length",
    "category": "text",
    "summary": {
      "fr": "Text Length — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Length — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ],
    "outputs": [
      {
        "name": "Length",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "text/case",
    "name": "Text Case",
    "category": "text",
    "summary": {
      "fr": "Text Case — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Case — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/replace",
    "name": "Text Replace",
    "category": "text",
    "summary": {
      "fr": "Text Replace — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Replace — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Search",
        "type": "text",
        "id": "search"
      },
      {
        "name": "Replace",
        "type": "text",
        "id": "replace"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/split",
    "name": "Text Split",
    "category": "text",
    "summary": {
      "fr": "Text Split — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Split — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Delimiter",
        "type": "text",
        "id": "delimiter"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "text/trim",
    "name": "Text Trim",
    "category": "text",
    "summary": {
      "fr": "Text Trim — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Trim — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Start (chars)",
        "type": "value",
        "id": "start"
      },
      {
        "name": "End (chars)",
        "type": "value",
        "id": "end"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/random",
    "name": "Random Text",
    "category": "text",
    "summary": {
      "fr": "Random Text — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Random Text — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Length",
        "type": "value",
        "id": "length"
      }
    ],
    "outputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      }
    ]
  },
  {
    "id": "text/compare",
    "name": "Text Compare",
    "category": "text",
    "summary": {
      "fr": "Text Compare — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Compare — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text A",
        "type": "text",
        "id": "textA"
      },
      {
        "name": "Text B",
        "type": "text",
        "id": "textB"
      }
    ],
    "outputs": [
      {
        "name": "Result",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "text/animator",
    "name": "Text Animator",
    "category": "text",
    "summary": {
      "fr": "Text Animator — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Animator — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Curve Path",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Font Size",
        "type": "value",
        "id": "fontSize"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Tracking",
        "type": "value",
        "id": "tracking"
      },
      {
        "name": "Line Height",
        "type": "value",
        "id": "lineHeight"
      },
      {
        "name": "Position Δ",
        "type": "vector",
        "id": "positionDelta"
      },
      {
        "name": "Rotation Δ",
        "type": "vector",
        "id": "rotationDelta"
      },
      {
        "name": "Scale Δ",
        "type": "vector",
        "id": "scaleDelta"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrices",
        "type": "list",
        "id": "matrices"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Characters",
        "type": "list",
        "id": "characters"
      },
      {
        "name": "Weights",
        "type": "list",
        "id": "weights"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "text/decompose",
    "name": "Text Decompose",
    "category": "text",
    "summary": {
      "fr": "Text Decompose — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Text Decompose — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Font Size",
        "type": "value",
        "id": "fontSize"
      },
      {
        "name": "Tracking",
        "type": "value",
        "id": "tracking"
      },
      {
        "name": "Line Height",
        "type": "value",
        "id": "lineHeight"
      }
    ],
    "outputs": [
      {
        "name": "Characters",
        "type": "list",
        "id": "characters"
      },
      {
        "name": "Words",
        "type": "list",
        "id": "words"
      },
      {
        "name": "Lines",
        "type": "list",
        "id": "lines"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Matrices",
        "type": "list",
        "id": "matrices"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Total Width",
        "type": "value",
        "id": "width"
      },
      {
        "name": "Total Height",
        "type": "value",
        "id": "height"
      }
    ]
  },
  {
    "id": "text/range-selector",
    "name": "Range Selector",
    "category": "text",
    "summary": {
      "fr": "Range Selector — Module nodal text pour composition 3D et flux de signaux.",
      "en": "Range Selector — text node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Start",
        "type": "value",
        "id": "start"
      },
      {
        "name": "End",
        "type": "value",
        "id": "end"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      }
    ],
    "outputs": [
      {
        "name": "Weights",
        "type": "list",
        "id": "weights"
      },
      {
        "name": "Active Count",
        "type": "value",
        "id": "activeCount"
      }
    ]
  },
  {
    "id": "curve/text-on-path",
    "name": "Text on Path",
    "category": "curve",
    "summary": {
      "fr": "Projette et anime du texte typographique le long d'une courbe 3D continue.",
      "en": "Projects and animates typographic text along a continuous 3D curve path."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Font Size",
        "type": "value",
        "id": "fontSize"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      },
      {
        "name": "Tracking",
        "type": "value",
        "id": "tracking"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrices",
        "type": "list",
        "id": "matrices"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform",
    "name": "Compose Matrix",
    "category": "compose",
    "summary": {
      "fr": "Compose Matrix — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Compose Matrix — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform/pivot",
    "name": "Pivot Transform",
    "category": "transform",
    "summary": {
      "fr": "Pivot Transform — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Pivot Transform — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Pivot",
        "type": "vector",
        "id": "pivot"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "matrix/decompose",
    "name": "Decompose Matrix",
    "category": "compose",
    "summary": {
      "fr": "Decompose Matrix — Module nodal compose pour composition 3D et flux de signaux.",
      "en": "Decompose Matrix — compose node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      }
    ]
  },
  {
    "id": "transform/parent",
    "name": "Parent",
    "category": "transform",
    "summary": {
      "fr": "Parent — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Parent — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Parent",
        "type": "matrix",
        "id": "parent"
      },
      {
        "name": "Child",
        "type": "matrix",
        "id": "child"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform/look-at",
    "name": "Look At",
    "category": "transform",
    "summary": {
      "fr": "Look At — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Look At — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Target",
        "type": "any",
        "id": "target"
      },
      {
        "name": "Up",
        "type": "vector",
        "id": "up"
      },
      {
        "name": "Eye / Pos",
        "type": "any",
        "id": "eye"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform/matrix-transform",
    "name": "Matrix Transform",
    "category": "transform",
    "summary": {
      "fr": "Matrix Transform — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Matrix Transform — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform/delay",
    "name": "Matrix Delay",
    "category": "transform",
    "summary": {
      "fr": "Matrix Delay — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Matrix Delay — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Delay (frames)",
        "type": "value",
        "id": "frames"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "transform/transform-vector",
    "name": "Transform Vector",
    "category": "transform",
    "summary": {
      "fr": "Transform Vector — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Transform Vector — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ]
  },
  {
    "id": "curve/from_points",
    "name": "Curve from Points",
    "category": "curve",
    "summary": {
      "fr": "Curve from Points — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve from Points — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Closed",
        "type": "value",
        "id": "closed"
      },
      {
        "name": "Tension",
        "type": "value",
        "id": "tension"
      },
      {
        "name": "Sag",
        "type": "value",
        "id": "sag"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Curve Preview",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "curve/primitive",
    "name": "Curve Primitive",
    "category": "curve",
    "summary": {
      "fr": "Curve Primitive — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve Primitive — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Radius / Size",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Height",
        "type": "value",
        "id": "height"
      },
      {
        "name": "Turns",
        "type": "value",
        "id": "turns"
      },
      {
        "name": "Sag",
        "type": "value",
        "id": "sag"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Curve Preview",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "curve/array",
    "name": "Curve Array",
    "category": "curve",
    "summary": {
      "fr": "Curve Array — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve Array — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Spacing",
        "type": "value",
        "id": "spacing"
      },
      {
        "name": "Start Scale",
        "type": "value",
        "id": "start"
      },
      {
        "name": "Step Scale",
        "type": "value",
        "id": "step"
      }
    ],
    "outputs": [
      {
        "name": "Curves (List)",
        "type": "list",
        "id": "curves"
      },
      {
        "name": "Offsets (List)",
        "type": "list",
        "id": "offsets"
      },
      {
        "name": "Scales (List)",
        "type": "list",
        "id": "scales"
      }
    ]
  },
  {
    "id": "curve/to_mesh",
    "name": "Curve to Mesh",
    "category": "curve",
    "summary": {
      "fr": "Génère un tube volumétrique 3D balayé avec profil d'épaisseur variable (équivalent temps réel de Trim Paths).",
      "en": "Generates a swept 3D volumetric tube with variable thickness profile (real-time Trim Paths equivalent)."
    },
    "inputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "thickness"
      },
      {
        "name": "Start %",
        "type": "value",
        "id": "startProgress"
      },
      {
        "name": "End %",
        "type": "value",
        "id": "endProgress"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      },
      {
        "name": "Surface Material",
        "type": "material",
        "id": "surfaceMaterial"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/to_mesh_list",
    "name": "Curves to Meshes",
    "category": "curve",
    "summary": {
      "fr": "Curves to Meshes — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curves to Meshes — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curves (List)",
        "type": "list",
        "id": "curves"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "thickness"
      },
      {
        "name": "Start %",
        "type": "value",
        "id": "startProgress"
      },
      {
        "name": "End %",
        "type": "value",
        "id": "endProgress"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/sample",
    "name": "Follow Path",
    "category": "curve",
    "summary": {
      "fr": "Follow Path — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Follow Path — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Progress (0-1)",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Up Vector",
        "type": "vector",
        "id": "up"
      }
    ],
    "outputs": [
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Tangent",
        "type": "vector",
        "id": "tangent"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      }
    ]
  },
  {
    "id": "curve/deform",
    "name": "Curve Deform",
    "category": "curve",
    "summary": {
      "fr": "Curve Deform — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve Deform — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Stretch",
        "type": "value",
        "id": "stretch"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/shape_key",
    "name": "Curve Shape Key",
    "category": "curve",
    "summary": {
      "fr": "Curve Shape Key — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve Shape Key — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Basis",
        "type": "curve",
        "id": "basis"
      },
      {
        "name": "Target 1",
        "type": "curve",
        "id": "target0"
      },
      {
        "name": "Weight 1",
        "type": "value",
        "id": "weight0"
      }
    ],
    "outputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Preview",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "object/shape_key",
    "name": "Mesh Shape Key",
    "category": "object",
    "summary": {
      "fr": "Mesh Shape Key — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Mesh Shape Key — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Basis",
        "type": "geometry",
        "id": "basis"
      },
      {
        "name": "Target 1",
        "type": "geometry",
        "id": "target0"
      },
      {
        "name": "Weight 1",
        "type": "value",
        "id": "weight0"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "object/box",
    "name": "Box",
    "category": "object",
    "summary": {
      "fr": "Box — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Box — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/edit_points",
    "name": "Edit Mesh Points",
    "category": "object",
    "summary": {
      "fr": "Edit Mesh Points — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Edit Mesh Points — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Basis",
        "type": "geometry",
        "id": "basis"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "object/empty",
    "name": "Empty",
    "category": "object",
    "summary": {
      "fr": "Empty — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Empty — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      }
    ]
  },
  {
    "id": "object/plane",
    "name": "Plane",
    "category": "object",
    "summary": {
      "fr": "Plane — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Plane — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      },
      {
        "name": "Inner (Hole)",
        "type": "value",
        "id": "innerRadius"
      },
      {
        "name": "Segments",
        "type": "value",
        "id": "segments"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/terrain",
    "name": "Terrain",
    "category": "object",
    "summary": {
      "fr": "Terrain — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Terrain — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Height Map",
        "type": "texture",
        "id": "heightmap"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Heightmap",
        "type": "texture",
        "id": "heightmap"
      }
    ]
  },
  {
    "id": "object/sculpt",
    "name": "Sculpt",
    "category": "object",
    "summary": {
      "fr": "Sculpt — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Sculpt — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/sphere",
    "name": "Sphere",
    "category": "object",
    "summary": {
      "fr": "Sphere — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Sphere — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/disc",
    "name": "Disc",
    "category": "object",
    "summary": {
      "fr": "Disc — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Disc — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Inner Radius",
        "type": "value",
        "id": "innerRadius"
      },
      {
        "name": "Start Angle",
        "type": "value",
        "id": "startAngle"
      },
      {
        "name": "Arc Angle",
        "type": "value",
        "id": "arcAngle"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/polygon",
    "name": "Polygon",
    "category": "object",
    "summary": {
      "fr": "Polygon — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Polygon — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Sides",
        "type": "value",
        "id": "sides"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Inner Radius",
        "type": "value",
        "id": "innerRadius"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/cylinder",
    "name": "Cylinder",
    "category": "object",
    "summary": {
      "fr": "Cylinder — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Cylinder — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/cone",
    "name": "Cone",
    "category": "object",
    "summary": {
      "fr": "Cone — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Cone — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/text",
    "name": "Text",
    "category": "object",
    "summary": {
      "fr": "Text — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Text — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Font Size",
        "type": "value",
        "id": "fontSize"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/bar_graph",
    "name": "Bar Graph",
    "category": "object",
    "summary": {
      "fr": "Bar Graph — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Bar Graph — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Values (List)",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Colors (List)",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Bar Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Spacing",
        "type": "value",
        "id": "spacing"
      },
      {
        "name": "Bar Width",
        "type": "value",
        "id": "barWidth"
      },
      {
        "name": "Max Height",
        "type": "value",
        "id": "maxHeight"
      },
      {
        "name": "Bar Depth",
        "type": "value",
        "id": "barDepth"
      },
      {
        "name": "Show Labels",
        "type": "value",
        "id": "showLabels"
      },
      {
        "name": "Label Position",
        "type": "text",
        "id": "labelPosition"
      },
      {
        "name": "Decimals",
        "type": "value",
        "id": "labelDecimals"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/line_graph",
    "name": "Line Graph",
    "category": "object",
    "summary": {
      "fr": "Line Graph — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Line Graph — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Values (List)",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Point Colors (List)",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Point Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Spacing",
        "type": "value",
        "id": "spacing"
      },
      {
        "name": "Max Height",
        "type": "value",
        "id": "maxHeight"
      },
      {
        "name": "Line Width",
        "type": "value",
        "id": "lineWidth"
      },
      {
        "name": "Smooth",
        "type": "value",
        "id": "smooth"
      },
      {
        "name": "Show Points",
        "type": "value",
        "id": "showPoints"
      },
      {
        "name": "Point Size",
        "type": "value",
        "id": "pointSize"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/chart_axis",
    "name": "Chart Axis",
    "category": "object",
    "summary": {
      "fr": "Chart Axis — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Chart Axis — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Min Value",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max Value",
        "type": "value",
        "id": "max"
      },
      {
        "name": "Step",
        "type": "value",
        "id": "step"
      },
      {
        "name": "Max Height",
        "type": "value",
        "id": "maxHeight"
      },
      {
        "name": "Grid Width",
        "type": "value",
        "id": "width"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/pie_chart",
    "name": "Pie / Donut Chart",
    "category": "object",
    "summary": {
      "fr": "Pie / Donut Chart — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Pie / Donut Chart — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Values (List)",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Slice Colors (List)",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Inner Radius (Donut)",
        "type": "value",
        "id": "innerRadius"
      },
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Slice Gap (deg)",
        "type": "value",
        "id": "gapDegrees"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/scatter_plot",
    "name": "Scatter Plot",
    "category": "object",
    "summary": {
      "fr": "Scatter Plot — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Scatter Plot — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Colors (List)",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Sizes (List)",
        "type": "list",
        "id": "sizes"
      },
      {
        "name": "Marker Size",
        "type": "value",
        "id": "markerSize"
      },
      {
        "name": "Scale X",
        "type": "value",
        "id": "scaleX"
      },
      {
        "name": "Scale Y",
        "type": "value",
        "id": "scaleY"
      },
      {
        "name": "Scale Z",
        "type": "value",
        "id": "scaleZ"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/point_cloud",
    "name": "Point Cloud",
    "category": "object",
    "summary": {
      "fr": "Point Cloud — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Point Cloud — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Colors (List)",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Point Size",
        "type": "value",
        "id": "pointSize"
      },
      {
        "name": "Scale X",
        "type": "value",
        "id": "scaleX"
      },
      {
        "name": "Scale Y",
        "type": "value",
        "id": "scaleY"
      },
      {
        "name": "Scale Z",
        "type": "value",
        "id": "scaleZ"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Colors (List)",
        "type": "list",
        "id": "colors"
      }
    ]
  },
  {
    "id": "object/obj",
    "name": "OBJ Model",
    "category": "object",
    "summary": {
      "fr": "OBJ Model — Module nodal object pour composition 3D et flux de signaux.",
      "en": "OBJ Model — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Diffuse Map",
        "type": "texture",
        "id": "diffuse"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      },
      {
        "name": "Pivot",
        "type": "vector",
        "id": "pivot"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/gltf",
    "name": "glTF Model",
    "category": "object",
    "summary": {
      "fr": "glTF Model — Module nodal object pour composition 3D et flux de signaux.",
      "en": "glTF Model — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Pivot",
        "type": "vector",
        "id": "pivot"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/ply_point_cloud",
    "name": "PLY Point Cloud",
    "category": "object",
    "summary": {
      "fr": "PLY Point Cloud — Module nodal object pour composition 3D et flux de signaux.",
      "en": "PLY Point Cloud — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Point Size",
        "type": "value",
        "id": "pointSize"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/frozen",
    "name": "Frozen Geometry",
    "category": "object",
    "summary": {
      "fr": "Frozen Geometry — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Frozen Geometry — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "object/raccoon",
    "name": "Raccoon",
    "category": "object",
    "summary": {
      "fr": "Raccoon — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Raccoon — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/image",
    "name": "Image Texture",
    "category": "texture",
    "summary": {
      "fr": "Image Texture — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Image Texture — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Aspect Ratio",
        "type": "value",
        "id": "aspectRatio"
      }
    ]
  },
  {
    "id": "texture/camera",
    "name": "2D Camera",
    "category": "texture",
    "summary": {
      "fr": "2D Camera — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "2D Camera — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Target",
        "type": "any",
        "id": "target"
      },
      {
        "name": "FOV",
        "type": "value",
        "id": "fov"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/plane",
    "name": "Texture to Plane",
    "category": "object",
    "summary": {
      "fr": "Texture to Plane — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Texture to Plane — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/procedural",
    "name": "Procedural Texture",
    "category": "texture",
    "summary": {
      "fr": "Procedural Texture — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Procedural Texture — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/noise",
    "name": "Noise Texture",
    "category": "texture",
    "summary": {
      "fr": "Noise Texture — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Noise Texture — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "W (evolution)",
        "type": "value",
        "id": "w"
      },
      {
        "name": "Detail",
        "type": "value",
        "id": "detail"
      },
      {
        "name": "Roughness",
        "type": "value",
        "id": "roughness"
      },
      {
        "name": "Distortion",
        "type": "value",
        "id": "distortion"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/voronoi",
    "name": "Voronoi Texture",
    "category": "texture",
    "summary": {
      "fr": "Voronoi Texture — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Voronoi Texture — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Randomness",
        "type": "value",
        "id": "randomness"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Distance",
        "type": "texture",
        "id": "distance"
      },
      {
        "name": "Color",
        "type": "texture",
        "id": "color"
      }
    ]
  },
  {
    "id": "texture/wave",
    "name": "Wave Texture",
    "category": "texture",
    "summary": {
      "fr": "Wave Texture — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Wave Texture — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Phase",
        "type": "value",
        "id": "phase"
      },
      {
        "name": "Distortion",
        "type": "value",
        "id": "distortion"
      },
      {
        "name": "Detail",
        "type": "value",
        "id": "detail"
      },
      {
        "name": "Detail Scale",
        "type": "value",
        "id": "detailScale"
      },
      {
        "name": "Detail Roughness",
        "type": "value",
        "id": "roughness"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Center X",
        "type": "value",
        "id": "centerX"
      },
      {
        "name": "Center Y",
        "type": "value",
        "id": "centerY"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/to_normal",
    "name": "Texture to Normal",
    "category": "textureTools",
    "summary": {
      "fr": "Texture to Normal — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Texture to Normal — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      }
    ],
    "outputs": [
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      }
    ]
  },
  {
    "id": "texture/to_roughness",
    "name": "Texture to Roughness",
    "category": "textureTools",
    "summary": {
      "fr": "Texture to Roughness — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Texture to Roughness — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Invert",
        "type": "value",
        "id": "invert"
      },
      {
        "name": "Contrast",
        "type": "value",
        "id": "contrast"
      },
      {
        "name": "Min Roughness",
        "type": "value",
        "id": "minRoughness"
      },
      {
        "name": "Max Roughness",
        "type": "value",
        "id": "maxRoughness"
      }
    ],
    "outputs": [
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughness"
      }
    ]
  },
  {
    "id": "texture/transform",
    "name": "Transform",
    "category": "textureTools",
    "summary": {
      "fr": "Transform — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Transform — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Scale X",
        "type": "value",
        "id": "scaleX"
      },
      {
        "name": "Scale Y",
        "type": "value",
        "id": "scaleY"
      },
      {
        "name": "Offset X",
        "type": "value",
        "id": "offsetX"
      },
      {
        "name": "Offset Y",
        "type": "value",
        "id": "offsetY"
      },
      {
        "name": "Rotation (°)",
        "type": "value",
        "id": "rotation"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/mix",
    "name": "Mix Texture",
    "category": "textureTools",
    "summary": {
      "fr": "Mix Texture — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Mix Texture — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture A",
        "type": "texture",
        "id": "textureA"
      },
      {
        "name": "Texture B",
        "type": "texture",
        "id": "textureB"
      },
      {
        "name": "Factor",
        "type": "value",
        "id": "factor"
      },
      {
        "name": "Factor (Texture)",
        "type": "texture",
        "id": "factorTexture"
      },
      {
        "name": "Color A",
        "type": "color",
        "id": "colorA"
      },
      {
        "name": "Color B",
        "type": "color",
        "id": "colorB"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/math",
    "name": "Texture Math",
    "category": "textureTools",
    "summary": {
      "fr": "Texture Math — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Texture Math — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture A",
        "type": "texture",
        "id": "textureA"
      },
      {
        "name": "Texture B",
        "type": "texture",
        "id": "textureB"
      },
      {
        "name": "B (value)",
        "type": "value",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/mask",
    "name": "Mask",
    "category": "textureTools",
    "summary": {
      "fr": "Mask — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Mask — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture A",
        "type": "texture",
        "id": "textureA"
      },
      {
        "name": "Texture B (Combine)",
        "type": "texture",
        "id": "textureB"
      },
      {
        "name": "Invert",
        "type": "value",
        "id": "invert"
      }
    ],
    "outputs": [
      {
        "name": "Mask",
        "type": "texture",
        "id": "mask"
      }
    ]
  },
  {
    "id": "texture/map-range",
    "name": "Map Range",
    "category": "textureTools",
    "summary": {
      "fr": "Map Range — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Map Range — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Out Min (Texture)",
        "type": "texture",
        "id": "outMinTexture"
      },
      {
        "name": "Out Max (Texture)",
        "type": "texture",
        "id": "outMaxTexture"
      },
      {
        "name": "In Min",
        "type": "value",
        "id": "inMin"
      },
      {
        "name": "In Max",
        "type": "value",
        "id": "inMax"
      },
      {
        "name": "Out Min",
        "type": "value",
        "id": "outMin"
      },
      {
        "name": "Out Max",
        "type": "value",
        "id": "outMax"
      },
      {
        "name": "Clamp",
        "type": "value",
        "id": "clamp"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/blur",
    "name": "Blur",
    "category": "textureTools",
    "summary": {
      "fr": "Blur — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Blur — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/color-ramp",
    "name": "Color Ramp",
    "category": "textureTools",
    "summary": {
      "fr": "Color Ramp — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Color Ramp — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/combine-rgb",
    "name": "Combine RGB",
    "category": "textureTools",
    "summary": {
      "fr": "Combine RGB — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Combine RGB — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "R",
        "type": "texture",
        "id": "r"
      },
      {
        "name": "G",
        "type": "texture",
        "id": "g"
      },
      {
        "name": "B",
        "type": "texture",
        "id": "b"
      },
      {
        "name": "A",
        "type": "texture",
        "id": "a"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/separate-rgb",
    "name": "Separate RGB",
    "category": "textureTools",
    "summary": {
      "fr": "Separate RGB — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Separate RGB — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ],
    "outputs": [
      {
        "name": "R",
        "type": "texture",
        "id": "r"
      },
      {
        "name": "G",
        "type": "texture",
        "id": "g"
      },
      {
        "name": "B",
        "type": "texture",
        "id": "b"
      },
      {
        "name": "A",
        "type": "texture",
        "id": "a"
      }
    ]
  },
  {
    "id": "texture/threshold",
    "name": "Threshold",
    "category": "textureTools",
    "summary": {
      "fr": "Threshold — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Threshold — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Cutoff",
        "type": "value",
        "id": "cutoff"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      },
      {
        "name": "Invert",
        "type": "value",
        "id": "invert"
      }
    ],
    "outputs": [
      {
        "name": "Mask",
        "type": "texture",
        "id": "mask"
      }
    ]
  },
  {
    "id": "texture/invert",
    "name": "Invert",
    "category": "textureTools",
    "summary": {
      "fr": "Invert — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Invert — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Factor",
        "type": "value",
        "id": "factor"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/levels",
    "name": "Levels",
    "category": "textureTools",
    "summary": {
      "fr": "Levels — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Levels — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Input Black",
        "type": "value",
        "id": "inBlack"
      },
      {
        "name": "Input White",
        "type": "value",
        "id": "inWhite"
      },
      {
        "name": "Gamma",
        "type": "value",
        "id": "gamma"
      },
      {
        "name": "Output Black",
        "type": "value",
        "id": "outBlack"
      },
      {
        "name": "Output White",
        "type": "value",
        "id": "outWhite"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/hue-sat-val",
    "name": "Hue/Saturation/Value",
    "category": "textureTools",
    "summary": {
      "fr": "Hue/Saturation/Value — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Hue/Saturation/Value — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Hue Shift (°)",
        "type": "value",
        "id": "hue"
      },
      {
        "name": "Saturation",
        "type": "value",
        "id": "saturation"
      },
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/rgb-curves",
    "name": "RGB Curves",
    "category": "textureTools",
    "summary": {
      "fr": "RGB Curves — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "RGB Curves — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/bloom",
    "name": "Bloom",
    "category": "textureTools",
    "summary": {
      "fr": "Bloom — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Bloom — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Threshold",
        "type": "value",
        "id": "threshold"
      },
      {
        "name": "Size (px)",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Glow Only",
        "type": "value",
        "id": "glowOnly"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/film-grain",
    "name": "Film Grain",
    "category": "textureTools",
    "summary": {
      "fr": "Film Grain — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Film Grain — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      },
      {
        "name": "Grain Size (px)",
        "type": "value",
        "id": "grainSize"
      },
      {
        "name": "Animated",
        "type": "value",
        "id": "animated"
      },
      {
        "name": "Monochrome",
        "type": "value",
        "id": "monochrome"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "texture/paint",
    "name": "Texture Paint",
    "category": "texture",
    "summary": {
      "fr": "Texture Paint — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Texture Paint — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Base Texture",
        "type": "texture",
        "id": "baseTexture"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/mix-paint",
    "name": "Texture Mix",
    "category": "textureTools",
    "summary": {
      "fr": "Texture Mix — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Texture Mix — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture 1 (Base)",
        "type": "texture",
        "id": "texture0"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Splat Map",
        "type": "texture",
        "id": "splatMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/height-slope-mix",
    "name": "Topography Texture Mix",
    "category": "textureTools",
    "summary": {
      "fr": "Topography Texture Mix — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Topography Texture Mix — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Texture 0 (Base / Flat)",
        "type": "texture",
        "id": "texture0"
      },
      {
        "name": "Texture 1 (Slope / Cliff)",
        "type": "texture",
        "id": "texture1"
      },
      {
        "name": "Texture 2 (Snow / Peak)",
        "type": "texture",
        "id": "texture2"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Splat Map",
        "type": "texture",
        "id": "splatMap"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/pixel-spawner",
    "name": "Texture Pixel Spawner",
    "category": "instance",
    "summary": {
      "fr": "Texture Pixel Spawner — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Texture Pixel Spawner — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Instance Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Density (%)",
        "type": "value",
        "id": "density"
      },
      {
        "name": "Pixel Scale",
        "type": "value",
        "id": "scale"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Colors",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Intensities",
        "type": "list",
        "id": "intensities"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "structure/merge",
    "name": "Merge",
    "category": "structure",
    "summary": {
      "fr": "Merge — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Merge — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      },
      {
        "name": "In 1",
        "type": "geometry",
        "id": "in0"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "structure/array",
    "name": "Array",
    "category": "instance",
    "summary": {
      "fr": "Array — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Array — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Geometries (List) — random pick per instance",
        "type": "list",
        "id": "geometries"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Spacing",
        "type": "value",
        "id": "spacing"
      },
      {
        "name": "Spacing Variance (%)",
        "type": "value",
        "id": "spacingVariance"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Count X",
        "type": "value",
        "id": "countX"
      },
      {
        "name": "Count Y",
        "type": "value",
        "id": "countY"
      },
      {
        "name": "Count Z",
        "type": "value",
        "id": "countZ"
      },
      {
        "name": "Spacing X",
        "type": "value",
        "id": "spacingX"
      },
      {
        "name": "Spacing Y",
        "type": "value",
        "id": "spacingY"
      },
      {
        "name": "Spacing Z",
        "type": "value",
        "id": "spacingZ"
      },
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "structure/instance-positions",
    "name": "Instance Positions",
    "category": "converter",
    "summary": {
      "fr": "Instance Positions — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Instance Positions — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Height Offset",
        "type": "value",
        "id": "heightOffset"
      }
    ],
    "outputs": [
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "structure/instance-color",
    "name": "Set Instance Color",
    "category": "instance",
    "summary": {
      "fr": "Set Instance Color — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Set Instance Color — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Colors",
        "type": "list",
        "id": "colors"
      },
      {
        "name": "Default Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Index (-1 = All)",
        "type": "value",
        "id": "index"
      },
      {
        "name": "Target IDs (List, 1-based)",
        "type": "list",
        "id": "ids"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "structure/instance-transform",
    "name": "Instance Transform",
    "category": "instance",
    "summary": {
      "fr": "Instance Transform — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Instance Transform — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Matrices (List)",
        "type": "any",
        "id": "matrices"
      },
      {
        "name": "Positions (Vector List)",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Target (look-at)",
        "type": "any",
        "id": "target"
      },
      {
        "name": "Pos X",
        "type": "any",
        "id": "posX"
      },
      {
        "name": "Pos Y",
        "type": "any",
        "id": "posY"
      },
      {
        "name": "Pos Z",
        "type": "any",
        "id": "posZ"
      },
      {
        "name": "Rotations / Directions (Vector List)",
        "type": "list",
        "id": "rotations"
      },
      {
        "name": "Rot X (°)",
        "type": "any",
        "id": "rotX"
      },
      {
        "name": "Rot Y (°)",
        "type": "any",
        "id": "rotY"
      },
      {
        "name": "Rot Z (°)",
        "type": "any",
        "id": "rotZ"
      },
      {
        "name": "Scales (Vector List)",
        "type": "list",
        "id": "scales"
      },
      {
        "name": "Scale X",
        "type": "any",
        "id": "scaleX"
      },
      {
        "name": "Scale Y",
        "type": "any",
        "id": "scaleY"
      },
      {
        "name": "Scale Z",
        "type": "any",
        "id": "scaleZ"
      },
      {
        "name": "Index (-1 = All)",
        "type": "value",
        "id": "index"
      },
      {
        "name": "Target IDs (List, 1-based)",
        "type": "list",
        "id": "ids"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "structure/geometry-transform",
    "name": "Geometry Transform",
    "category": "instance",
    "summary": {
      "fr": "Geometry Transform — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Geometry Transform — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Pos X",
        "type": "value",
        "id": "posX"
      },
      {
        "name": "Pos Y",
        "type": "value",
        "id": "posY"
      },
      {
        "name": "Pos Z",
        "type": "value",
        "id": "posZ"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Rot X (°)",
        "type": "value",
        "id": "rotX"
      },
      {
        "name": "Rot Y (°)",
        "type": "value",
        "id": "rotY"
      },
      {
        "name": "Rot Z (°)",
        "type": "value",
        "id": "rotZ"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      },
      {
        "name": "Scale X",
        "type": "value",
        "id": "scaleX"
      },
      {
        "name": "Scale Y",
        "type": "value",
        "id": "scaleY"
      },
      {
        "name": "Scale Z",
        "type": "value",
        "id": "scaleZ"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "structure/get-instance",
    "name": "Get Instance",
    "category": "instance",
    "summary": {
      "fr": "Get Instance — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Get Instance — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Index",
        "type": "value",
        "id": "index"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "structure/instances-to-list",
    "name": "Instances to List",
    "category": "converter",
    "summary": {
      "fr": "Instances to List — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Instances to List — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "light/directional",
    "name": "Directional Light",
    "category": "lighting",
    "summary": {
      "fr": "Directional Light — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Directional Light — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Target",
        "type": "geometry",
        "id": "target"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Shadows",
        "type": "value",
        "id": "castShadow"
      },
      {
        "name": "Shadow Softness",
        "type": "value",
        "id": "shadowSoftness"
      }
    ],
    "outputs": [
      {
        "name": "Light",
        "type": "geometry",
        "id": "light"
      }
    ]
  },
  {
    "id": "light/point",
    "name": "Point Light",
    "category": "lighting",
    "summary": {
      "fr": "Point Light — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Point Light — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Distance",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Decay",
        "type": "value",
        "id": "decay"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Shadows",
        "type": "value",
        "id": "castShadow"
      },
      {
        "name": "Shadow Softness",
        "type": "value",
        "id": "shadowSoftness"
      }
    ],
    "outputs": [
      {
        "name": "Light",
        "type": "geometry",
        "id": "light"
      }
    ]
  },
  {
    "id": "light/spot",
    "name": "Spot Light",
    "category": "lighting",
    "summary": {
      "fr": "Spot Light — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Spot Light — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Angle (°)",
        "type": "value",
        "id": "angle"
      },
      {
        "name": "Penumbra",
        "type": "value",
        "id": "penumbra"
      },
      {
        "name": "Target",
        "type": "geometry",
        "id": "target"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Shadows",
        "type": "value",
        "id": "castShadow"
      },
      {
        "name": "Shadow Softness",
        "type": "value",
        "id": "shadowSoftness"
      }
    ],
    "outputs": [
      {
        "name": "Light",
        "type": "geometry",
        "id": "light"
      }
    ]
  },
  {
    "id": "light/ambient",
    "name": "Ambient Light",
    "category": "lighting",
    "summary": {
      "fr": "Ambient Light — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Ambient Light — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      }
    ],
    "outputs": [
      {
        "name": "Light",
        "type": "geometry",
        "id": "light"
      }
    ]
  },
  {
    "id": "lighting/environment",
    "name": "Environment & HDRI",
    "category": "lighting",
    "summary": {
      "fr": "Environment & HDRI — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Environment & HDRI — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Background Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "HDRI / Env Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Env Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Show Background",
        "type": "value",
        "id": "background"
      },
      {
        "name": "Bg Blur",
        "type": "value",
        "id": "blurriness"
      },
      {
        "name": "Bg Image Scale",
        "type": "vector",
        "id": "backgroundScale"
      },
      {
        "name": "Bg Image Offset",
        "type": "vector",
        "id": "backgroundOffset"
      },
      {
        "name": "Bg Image Rotation",
        "type": "value",
        "id": "backgroundRotation"
      }
    ],
    "outputs": [
      {
        "name": "Environment",
        "type": "any",
        "id": "environment"
      }
    ]
  },
  {
    "id": "render",
    "name": "Render",
    "category": "structure",
    "summary": {
      "fr": "Render — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Render — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Environment",
        "type": "any",
        "id": "environment"
      },
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "postprocess"
      },
      {
        "name": "Motion Blur",
        "type": "value",
        "id": "motionBlur"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Environment",
        "type": "any",
        "id": "environment"
      },
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "postprocess"
      }
    ]
  },
  {
    "id": "view2d",
    "name": "2D Render",
    "category": "structure",
    "summary": {
      "fr": "Caméra 2D orthographique dédiée au motion design, HUD et composition d'écrans plats dans l'univers 3D.",
      "en": "Orthographic 2D camera dedicated to motion design, HUD layouts, and flat screen composition in 3D space."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ],
    "outputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      }
    ]
  },
  {
    "id": "canvas/goto",
    "name": "Go To Canvas",
    "category": "utility",
    "summary": {
      "fr": "Go To Canvas — Module nodal utility pour composition 3D et flux de signaux.",
      "en": "Go To Canvas — utility node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Canvas (1-6)",
        "type": "value",
        "id": "canvas"
      }
    ],
    "outputs": [
      {
        "name": "Switched",
        "type": "value",
        "id": "switched"
      }
    ]
  },
  {
    "id": "logic/compare",
    "name": "Compare",
    "category": "logic",
    "summary": {
      "fr": "Compare — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Compare — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "value",
        "id": "a"
      },
      {
        "name": "B",
        "type": "value",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "logic/boolean",
    "name": "Boolean Logic",
    "category": "logic",
    "summary": {
      "fr": "Boolean Logic — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Boolean Logic — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "value",
        "id": "a"
      },
      {
        "name": "B",
        "type": "value",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "logic/trigger",
    "name": "Trigger",
    "category": "logic",
    "summary": {
      "fr": "Trigger — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Trigger — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "In",
        "type": "value",
        "id": "in"
      }
    ],
    "outputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      }
    ]
  },
  {
    "id": "logic/toggle",
    "name": "Toggle",
    "category": "logic",
    "summary": {
      "fr": "Toggle — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Toggle — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "logic/gate",
    "name": "Gate",
    "category": "logic",
    "summary": {
      "fr": "Gate — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Gate — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      },
      {
        "name": "Enable",
        "type": "value",
        "id": "enable"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "logic/bridge",
    "name": "Logic Bridge",
    "category": "logic",
    "summary": {
      "fr": "Logic Bridge — Module nodal logic pour composition 3D et flux de signaux.",
      "en": "Logic Bridge — logic node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Condition",
        "type": "value",
        "id": "condition"
      },
      {
        "name": "If True (A)",
        "type": "any",
        "id": "ifTrue"
      },
      {
        "name": "If False (B)",
        "type": "any",
        "id": "ifFalse"
      }
    ],
    "outputs": [
      {
        "name": "Output",
        "type": "any",
        "id": "out"
      }
    ]
  },
  {
    "id": "io/keyboard",
    "name": "Keyboard",
    "category": "io",
    "summary": {
      "fr": "Keyboard — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Keyboard — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Key",
        "type": "text",
        "id": "key"
      }
    ],
    "outputs": [
      {
        "name": "Is Down",
        "type": "value",
        "id": "isDown"
      },
      {
        "name": "Pressed",
        "type": "value",
        "id": "pressed"
      }
    ]
  },
  {
    "id": "io/mouse",
    "name": "Mouse",
    "category": "io",
    "summary": {
      "fr": "Mouse — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Mouse — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Plane Distance",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Ground Height",
        "type": "value",
        "id": "height"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      }
    ],
    "outputs": [
      {
        "name": "Screen X",
        "type": "value",
        "id": "screenX"
      },
      {
        "name": "Screen Y",
        "type": "value",
        "id": "screenY"
      },
      {
        "name": "NDC X",
        "type": "value",
        "id": "ndcX"
      },
      {
        "name": "NDC Y",
        "type": "value",
        "id": "ndcY"
      },
      {
        "name": "Inside Viewport",
        "type": "value",
        "id": "inside"
      },
      {
        "name": "Point (3D)",
        "type": "vector",
        "id": "point"
      },
      {
        "name": "Normal",
        "type": "vector",
        "id": "normal"
      },
      {
        "name": "Hit Geometry (0/1)",
        "type": "value",
        "id": "hit"
      },
      {
        "name": "Distance",
        "type": "value",
        "id": "distanceOut"
      }
    ]
  },
  {
    "id": "io/click",
    "name": "Mouse Click",
    "category": "io",
    "summary": {
      "fr": "Mouse Click — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Mouse Click — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [],
    "outputs": [
      {
        "name": "Is Down",
        "type": "value",
        "id": "isDown"
      },
      {
        "name": "Pressed",
        "type": "value",
        "id": "pressed"
      },
      {
        "name": "Released",
        "type": "value",
        "id": "released"
      }
    ]
  },
  {
    "id": "animation/oscillator",
    "name": "Oscillator",
    "category": "time",
    "summary": {
      "fr": "Oscillator — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Oscillator — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Frequency",
        "type": "value",
        "id": "frequency"
      },
      {
        "name": "Phase",
        "type": "value",
        "id": "phase"
      },
      {
        "name": "Amplitude",
        "type": "value",
        "id": "amplitude"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "animation/envelope",
    "name": "Envelope",
    "category": "time",
    "summary": {
      "fr": "Envelope — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Envelope — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Attack",
        "type": "value",
        "id": "attack"
      },
      {
        "name": "Release",
        "type": "value",
        "id": "release"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "time/pulse",
    "name": "Pulse",
    "category": "time",
    "summary": {
      "fr": "Pulse — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Pulse — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Decay",
        "type": "value",
        "id": "decay"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "value",
        "id": "out"
      }
    ]
  },
  {
    "id": "io/csv-reader",
    "name": "CSV Reader",
    "category": "list",
    "summary": {
      "fr": "CSV Reader — Module nodal list pour composition 3D et flux de signaux.",
      "en": "CSV Reader — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Row",
        "type": "value",
        "id": "row"
      }
    ],
    "outputs": [
      {
        "name": "Column",
        "type": "list",
        "id": "column"
      },
      {
        "name": "Row Values",
        "type": "list",
        "id": "rowValues"
      },
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "list/get-item",
    "name": "Get List Item",
    "category": "list",
    "summary": {
      "fr": "Get List Item — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Get List Item — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "Index",
        "type": "value",
        "id": "index"
      }
    ],
    "outputs": [
      {
        "name": "Item",
        "type": "any",
        "id": "item"
      },
      {
        "name": "Value",
        "type": "value",
        "id": "val"
      }
    ]
  },
  {
    "id": "list/length",
    "name": "List Length",
    "category": "list",
    "summary": {
      "fr": "List Length — Module nodal list pour composition 3D et flux de signaux.",
      "en": "List Length — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ],
    "outputs": [
      {
        "name": "Length",
        "type": "value",
        "id": "length"
      }
    ]
  },
  {
    "id": "list/generate",
    "name": "Generate List",
    "category": "list",
    "summary": {
      "fr": "Generate List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Generate List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Start",
        "type": "value",
        "id": "start"
      },
      {
        "name": "Step",
        "type": "value",
        "id": "step"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/math",
    "name": "List Math",
    "category": "list",
    "summary": {
      "fr": "List Math — Module nodal list pour composition 3D et flux de signaux.",
      "en": "List Math — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "list",
        "id": "a"
      },
      {
        "name": "B",
        "type": "list",
        "id": "b"
      },
      {
        "name": "Factor",
        "type": "value",
        "id": "factor"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/statistics",
    "name": "List Statistics",
    "category": "list",
    "summary": {
      "fr": "List Statistics — Module nodal list pour composition 3D et flux de signaux.",
      "en": "List Statistics — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ],
    "outputs": [
      {
        "name": "Sum",
        "type": "value",
        "id": "sum"
      },
      {
        "name": "Average",
        "type": "value",
        "id": "average"
      },
      {
        "name": "Min",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max",
        "type": "value",
        "id": "max"
      },
      {
        "name": "Median",
        "type": "value",
        "id": "median"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "list/combine-math",
    "name": "Combine Lists Math",
    "category": "list",
    "summary": {
      "fr": "Combine Lists Math — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Combine Lists Math — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "list",
        "id": "a"
      },
      {
        "name": "B",
        "type": "list",
        "id": "b"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/color-palette",
    "name": "Color Palette List",
    "category": "list",
    "summary": {
      "fr": "Color Palette List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Color Palette List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ],
    "outputs": [
      {
        "name": "Colors",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/gradient",
    "name": "Gradient List",
    "category": "list",
    "summary": {
      "fr": "Gradient List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Gradient List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Values",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Radius / Max",
        "type": "value",
        "id": "radius"
      }
    ],
    "outputs": [
      {
        "name": "Colors",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/map-range",
    "name": "List Map Range",
    "category": "list",
    "summary": {
      "fr": "List Map Range — Module nodal list pour composition 3D et flux de signaux.",
      "en": "List Map Range — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "In Min",
        "type": "value",
        "id": "inMin"
      },
      {
        "name": "In Max",
        "type": "value",
        "id": "inMax"
      },
      {
        "name": "Out Min",
        "type": "value",
        "id": "outMin"
      },
      {
        "name": "Out Max",
        "type": "value",
        "id": "outMax"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/slice",
    "name": "Slice List",
    "category": "list",
    "summary": {
      "fr": "Slice List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Slice List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "Start",
        "type": "value",
        "id": "start"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "list/random-sample",
    "name": "Random Sample List",
    "category": "list",
    "summary": {
      "fr": "Random Sample List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Random Sample List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Sampled List",
        "type": "list",
        "id": "list"
      },
      {
        "name": "Indices",
        "type": "list",
        "id": "indices"
      }
    ]
  },
  {
    "id": "list/combine-vectors",
    "name": "Combine Vectors",
    "category": "list",
    "summary": {
      "fr": "Combine Vectors — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Combine Vectors — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X List",
        "type": "list",
        "id": "xList"
      },
      {
        "name": "Y List",
        "type": "list",
        "id": "yList"
      },
      {
        "name": "Z List",
        "type": "list",
        "id": "zList"
      }
    ],
    "outputs": [
      {
        "name": "Vector List",
        "type": "list",
        "id": "vectorList"
      }
    ]
  },
  {
    "id": "list/split-vectors",
    "name": "Split Vector List",
    "category": "list",
    "summary": {
      "fr": "Split Vector List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Split Vector List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Vector List",
        "type": "list",
        "id": "vectorList"
      }
    ],
    "outputs": [
      {
        "name": "X List",
        "type": "list",
        "id": "xList"
      },
      {
        "name": "Y List",
        "type": "list",
        "id": "yList"
      },
      {
        "name": "Z List",
        "type": "list",
        "id": "zList"
      }
    ]
  },
  {
    "id": "io/inspector",
    "name": "Inspector",
    "category": "io",
    "summary": {
      "fr": "Inspector — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Inspector — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Input",
        "type": "any",
        "id": "input"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "any",
        "id": "out"
      }
    ]
  },
  {
    "id": "sound/player",
    "name": "Audio Player",
    "category": "sound",
    "summary": {
      "fr": "Audio Player — Module nodal sound pour composition 3D et flux de signaux.",
      "en": "Audio Player — sound node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Play",
        "type": "value",
        "id": "play"
      },
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "playbackRate"
      },
      {
        "name": "Seek (s)",
        "type": "value",
        "id": "seek"
      },
      {
        "name": "Start Frame",
        "type": "value",
        "id": "startFrame"
      }
    ],
    "outputs": [
      {
        "name": "Audio",
        "type": "any",
        "id": "audio"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      },
      {
        "name": "Duration",
        "type": "value",
        "id": "duration"
      },
      {
        "name": "Position",
        "type": "value",
        "id": "position"
      },
      {
        "name": "Audio URL",
        "type": "text",
        "id": "url"
      },
      {
        "name": "Start Frame",
        "type": "value",
        "id": "startFrame"
      }
    ]
  },
  {
    "id": "sound/spectrum",
    "name": "Audio Spectrum",
    "category": "sound",
    "summary": {
      "fr": "Audio Spectrum — Module nodal sound pour composition 3D et flux de signaux.",
      "en": "Audio Spectrum — sound node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Audio In",
        "type": "any",
        "id": "audio"
      },
      {
        "name": "Bins",
        "type": "value",
        "id": "bins"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      }
    ],
    "outputs": [
      {
        "name": "Spectrum List",
        "type": "list",
        "id": "spectrum"
      },
      {
        "name": "Bass",
        "type": "value",
        "id": "bass"
      },
      {
        "name": "Mid",
        "type": "value",
        "id": "mid"
      },
      {
        "name": "Treble",
        "type": "value",
        "id": "treble"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      }
    ]
  },
  {
    "id": "sound/microphone",
    "name": "Microphone Input",
    "category": "sound",
    "summary": {
      "fr": "Microphone Input — Module nodal sound pour composition 3D et flux de signaux.",
      "en": "Microphone Input — sound node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Enable",
        "type": "value",
        "id": "enable"
      },
      {
        "name": "Gain",
        "type": "value",
        "id": "gain"
      }
    ],
    "outputs": [
      {
        "name": "Audio",
        "type": "any",
        "id": "audio"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      }
    ]
  },
  {
    "id": "sound/peak-detector",
    "name": "Audio Peak Detector",
    "category": "sound",
    "summary": {
      "fr": "Audio Peak Detector — Module nodal sound pour composition 3D et flux de signaux.",
      "en": "Audio Peak Detector — sound node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Volume In",
        "type": "value",
        "id": "volume"
      },
      {
        "name": "Threshold",
        "type": "value",
        "id": "threshold"
      },
      {
        "name": "Decay",
        "type": "value",
        "id": "decay"
      }
    ],
    "outputs": [
      {
        "name": "Beat Pulse",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Envelope",
        "type": "value",
        "id": "peak"
      }
    ]
  },
  {
    "id": "sound/synth",
    "name": "Audio Synth",
    "category": "sound",
    "summary": {
      "fr": "Audio Synth — Module nodal sound pour composition 3D et flux de signaux.",
      "en": "Audio Synth — sound node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Pitch (Hz)",
        "type": "value",
        "id": "frequency"
      },
      {
        "name": "Gate",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      }
    ],
    "outputs": [
      {
        "name": "Audio",
        "type": "any",
        "id": "audio"
      },
      {
        "name": "Volume",
        "type": "value",
        "id": "volume"
      }
    ]
  },
  {
    "id": "math/random-value",
    "name": "Random Value",
    "category": "math",
    "summary": {
      "fr": "Random Value — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Random Value — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Min",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max",
        "type": "value",
        "id": "max"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "vector/random-vector",
    "name": "Random Vector",
    "category": "math",
    "summary": {
      "fr": "Random Vector — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Random Vector — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Min",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max",
        "type": "value",
        "id": "max"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      }
    ]
  },
  {
    "id": "transform/random-matrix",
    "name": "Random Matrix",
    "category": "math",
    "summary": {
      "fr": "Random Matrix — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Random Matrix — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Pos Range",
        "type": "value",
        "id": "posRange"
      },
      {
        "name": "Rot Range (°)",
        "type": "value",
        "id": "rotRange"
      },
      {
        "name": "Scale Min",
        "type": "value",
        "id": "scaleMin"
      },
      {
        "name": "Scale Max",
        "type": "value",
        "id": "scaleMax"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "list/random-list",
    "name": "Random List",
    "category": "math",
    "summary": {
      "fr": "Random List — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Random List — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Min",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max",
        "type": "value",
        "id": "max"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "calibration/camera",
    "name": "Camera",
    "category": "calibration",
    "summary": {
      "fr": "Caméra de vidéo-mapping avec solveur DLT : calcule pose, focale et lens-shift sur des repères in-situ.",
      "en": "Video-mapping camera with DLT solver: recovers pose, focal length, and lens shift from in-situ real-world landmarks."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Target",
        "type": "any",
        "id": "target"
      },
      {
        "name": "FOV",
        "type": "value",
        "id": "fov"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      },
      {
        "name": "Ref Points",
        "type": "list",
        "id": "refPoints"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "FOV",
        "type": "value",
        "id": "fov"
      },
      {
        "name": "Projection",
        "type": "matrix",
        "id": "projection"
      },
      {
        "name": "Error",
        "type": "value",
        "id": "error"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      }
    ]
  },
  {
    "id": "camera/fly_to",
    "name": "Fly To",
    "category": "calibration",
    "summary": {
      "fr": "Fly To — Module nodal calibration pour composition 3D et flux de signaux.",
      "en": "Fly To — calibration node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Camera A (Start)",
        "type": "any",
        "id": "cameraA"
      },
      {
        "name": "Camera B (Target)",
        "type": "any",
        "id": "cameraB"
      },
      {
        "name": "Progress (0-1)",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Trigger Flight",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Duration (s)",
        "type": "value",
        "id": "duration"
      },
      {
        "name": "Arc Height",
        "type": "value",
        "id": "arcHeight"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "FOV",
        "type": "value",
        "id": "fov"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      },
      {
        "name": "Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Finished Signal",
        "type": "value",
        "id": "isFinished"
      }
    ]
  },
  {
    "id": "calibration/grid",
    "name": "3D Grid",
    "category": "calibration",
    "summary": {
      "fr": "3D Grid — Module nodal calibration pour composition 3D et flux de signaux.",
      "en": "3D Grid — calibration node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "calibration/room_corner",
    "name": "Room Corner",
    "category": "calibration",
    "summary": {
      "fr": "Room Corner — Module nodal calibration pour composition 3D et flux de signaux.",
      "en": "Room Corner — calibration node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Width (m)",
        "type": "value",
        "id": "width"
      },
      {
        "name": "Height (m)",
        "type": "value",
        "id": "height"
      },
      {
        "name": "Depth (m)",
        "type": "value",
        "id": "depth"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Ref Points",
        "type": "list",
        "id": "points"
      }
    ]
  },
  {
    "id": "particles/emitter",
    "name": "Particle Emitter",
    "category": "particles",
    "summary": {
      "fr": "Particle Emitter — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Particle Emitter — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Spawn Rate",
        "type": "value",
        "id": "spawnRate"
      },
      {
        "name": "Diameter",
        "type": "value",
        "id": "diameter"
      },
      {
        "name": "Emit",
        "type": "value",
        "id": "emit"
      }
    ],
    "outputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      }
    ]
  },
  {
    "id": "particles/emitter-from-points",
    "name": "Point Emitter",
    "category": "particles",
    "summary": {
      "fr": "Point Emitter — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Point Emitter — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Spawn Rate",
        "type": "value",
        "id": "spawnRate"
      },
      {
        "name": "Emit",
        "type": "value",
        "id": "emit"
      }
    ],
    "outputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      }
    ]
  },
  {
    "id": "particles/points-to-particles",
    "name": "Points to Particles",
    "category": "particles",
    "summary": {
      "fr": "Points to Particles — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Points to Particles — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Spawn Frame",
        "type": "value",
        "id": "spawnFrame"
      },
      {
        "name": "Kill Frame",
        "type": "value",
        "id": "killFrame"
      }
    ],
    "outputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      }
    ]
  },
  {
    "id": "particles/emitter-from-surface",
    "name": "Surface Emitter",
    "category": "particles",
    "summary": {
      "fr": "Surface Emitter — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Surface Emitter — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Spawn Rate",
        "type": "value",
        "id": "spawnRate"
      },
      {
        "name": "Surface Points",
        "type": "value",
        "id": "points"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Emit",
        "type": "value",
        "id": "emit"
      }
    ],
    "outputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      }
    ]
  },
  {
    "id": "list/points-from-geometry",
    "name": "Vertices to Points",
    "category": "list",
    "summary": {
      "fr": "Vertices to Points — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Vertices to Points — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Max Points",
        "type": "value",
        "id": "maxPoints"
      }
    ],
    "outputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "particles/to-points",
    "name": "Particles to Points",
    "category": "particles",
    "summary": {
      "fr": "Particles to Points — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Particles to Points — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ],
    "outputs": [
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Points (Vectors)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Live Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "particles/render-instances",
    "name": "Particle Instances",
    "category": "particles",
    "summary": {
      "fr": "Particle Instances — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Particle Instances — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Lifetime",
        "type": "value",
        "id": "lifetime"
      },
      {
        "name": "Lifetime Variation (%)",
        "type": "value",
        "id": "lifetimeVariance"
      },
      {
        "name": "Shape (Mesh)",
        "type": "geometry",
        "id": "shape"
      },
      {
        "name": "Instance Scale",
        "type": "value",
        "id": "instanceScale"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "particles/force-field",
    "name": "Force Field",
    "category": "particles",
    "summary": {
      "fr": "Force Field — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Force Field — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Axis / Direction",
        "type": "vector",
        "id": "axis"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Turbulence Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Turbulence Speed",
        "type": "value",
        "id": "speed"
      }
    ],
    "outputs": [
      {
        "name": "Field",
        "type": "any",
        "id": "field"
      }
    ]
  },
  {
    "id": "particles/ground",
    "name": "Ground",
    "category": "particles",
    "summary": {
      "fr": "Ground — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Ground — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Enabled",
        "type": "value",
        "id": "enabled"
      },
      {
        "name": "Height (Y)",
        "type": "value",
        "id": "height"
      },
      {
        "name": "Bounce",
        "type": "value",
        "id": "bounce"
      },
      {
        "name": "Friction",
        "type": "value",
        "id": "friction"
      }
    ],
    "outputs": [
      {
        "name": "Ground",
        "type": "any",
        "id": "ground"
      }
    ]
  },
  {
    "id": "particles/simulate",
    "name": "Particle Simulate",
    "category": "particles",
    "summary": {
      "fr": "Particle Simulate — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Particle Simulate — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      },
      {
        "name": "Gravity",
        "type": "value",
        "id": "gravity"
      },
      {
        "name": "Wind",
        "type": "vector",
        "id": "wind"
      },
      {
        "name": "Lifetime",
        "type": "value",
        "id": "lifetime"
      },
      {
        "name": "Lifetime Variation (%)",
        "type": "value",
        "id": "lifetimeVariance"
      },
      {
        "name": "Flow Field Strength",
        "type": "value",
        "id": "flowStrength"
      },
      {
        "name": "Flow Field Scale",
        "type": "value",
        "id": "flowScale"
      },
      {
        "name": "Flow Field Speed",
        "type": "value",
        "id": "flowSpeed"
      },
      {
        "name": "Bounds Radius",
        "type": "value",
        "id": "boundsRadius"
      },
      {
        "name": "Max Speed",
        "type": "value",
        "id": "maxSpeed"
      },
      {
        "name": "Ground",
        "type": "any",
        "id": "ground"
      },
      {
        "name": "Force Field 1",
        "type": "any",
        "id": "field0"
      }
    ],
    "outputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Velocities",
        "type": "texture",
        "id": "velocities"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Lifetime",
        "type": "value",
        "id": "lifetime"
      }
    ]
  },
  {
    "id": "particles/render",
    "name": "Particle Render",
    "category": "particles",
    "summary": {
      "fr": "Particle Render — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Particle Render — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Velocities",
        "type": "texture",
        "id": "velocities"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Lifetime",
        "type": "value",
        "id": "lifetime"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "postprocess/bloom",
    "name": "Bloom",
    "category": "postprocess",
    "summary": {
      "fr": "Halo néon haute intensité à downsampling optimisé pour les lueurs et contours émissifs.",
      "en": "High-intensity neon glow with optimized downsampling for emissive materials and accents."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Threshold",
        "type": "value",
        "id": "threshold"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/vignette",
    "name": "Vignette",
    "category": "postprocess",
    "summary": {
      "fr": "Vignette — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Vignette — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      },
      {
        "name": "Darkness",
        "type": "value",
        "id": "darkness"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/rgb-shift",
    "name": "RGB Shift",
    "category": "postprocess",
    "summary": {
      "fr": "RGB Shift — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "RGB Shift — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      },
      {
        "name": "Angle (°)",
        "type": "value",
        "id": "angle"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/dof",
    "name": "Depth of Field",
    "category": "postprocess",
    "summary": {
      "fr": "Depth of Field — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Depth of Field — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Focus Distance",
        "type": "value",
        "id": "focus"
      },
      {
        "name": "Aperture",
        "type": "value",
        "id": "aperture"
      },
      {
        "name": "Max Blur",
        "type": "value",
        "id": "maxblur"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/outline",
    "name": "Outline",
    "category": "postprocess",
    "summary": {
      "fr": "Détection de contours géométriques par différence de profondeur pour rendu cel-shading et dessin au trait.",
      "en": "Depth-difference geometric edge detection for clean cel-shading and line art aesthetics."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Geometry (target, defaults to whole render)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Edge Color",
        "type": "color",
        "id": "edgeColor"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "edgeStrength"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "edgeThickness"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/film-grain",
    "name": "Film Grain",
    "category": "postprocess",
    "summary": {
      "fr": "Film Grain — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Film Grain — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Noise Intensity",
        "type": "value",
        "id": "noiseIntensity"
      },
      {
        "name": "Scanlines Intensity",
        "type": "value",
        "id": "scanlinesIntensity"
      },
      {
        "name": "Scanlines Count",
        "type": "value",
        "id": "scanlinesCount"
      },
      {
        "name": "Grayscale",
        "type": "value",
        "id": "grayscale"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/glitch",
    "name": "Digital Glitch",
    "category": "postprocess",
    "summary": {
      "fr": "Digital Glitch — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Digital Glitch — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      },
      {
        "name": "Wild Mode",
        "type": "value",
        "id": "wild"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/pixelate",
    "name": "Pixelate / Mosaic",
    "category": "postprocess",
    "summary": {
      "fr": "Pixelate / Mosaic — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Pixelate / Mosaic — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Pixel Size",
        "type": "value",
        "id": "pixelSize"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/kaleidoscope",
    "name": "Kaleidoscope",
    "category": "postprocess",
    "summary": {
      "fr": "Kaleidoscope — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Kaleidoscope — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Sides / Mirrors",
        "type": "value",
        "id": "sides"
      },
      {
        "name": "Angle (°)",
        "type": "value",
        "id": "angle"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/color-correction",
    "name": "Color Correction",
    "category": "postprocess",
    "summary": {
      "fr": "Color Correction — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Color Correction — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Brightness",
        "type": "value",
        "id": "brightness"
      },
      {
        "name": "Contrast",
        "type": "value",
        "id": "contrast"
      },
      {
        "name": "Saturation",
        "type": "value",
        "id": "saturation"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/antialias",
    "name": "FXAA Antialiasing",
    "category": "postprocess",
    "summary": {
      "fr": "FXAA Antialiasing — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "FXAA Antialiasing — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Enabled",
        "type": "value",
        "id": "enabled"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/fog",
    "name": "Fog / Atmosphere",
    "category": "postprocess",
    "summary": {
      "fr": "Fog / Atmosphere — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Fog / Atmosphere — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Density",
        "type": "value",
        "id": "density"
      },
      {
        "name": "Near Distance",
        "type": "value",
        "id": "near"
      },
      {
        "name": "Far Distance",
        "type": "value",
        "id": "far"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/ambient-occlusion",
    "name": "Ambient Occlusion",
    "category": "postprocess",
    "summary": {
      "fr": "Ambient Occlusion — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Ambient Occlusion — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Blend Intensity",
        "type": "value",
        "id": "blendIntensity"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "thickness"
      },
      {
        "name": "Samples",
        "type": "value",
        "id": "samples"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/duotone",
    "name": "Dual Tone",
    "category": "postprocess",
    "summary": {
      "fr": "Dual Tone — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Dual Tone — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "shadowColor"
      },
      {
        "name": "Highlight Color",
        "type": "color",
        "id": "highlightColor"
      },
      {
        "name": "Balance",
        "type": "value",
        "id": "balance"
      },
      {
        "name": "Softness",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/halftone",
    "name": "Halftone",
    "category": "postprocess",
    "summary": {
      "fr": "Halftone — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Halftone — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Dot Radius (px)",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Screen Angle (°)",
        "type": "value",
        "id": "screenAngle"
      },
      {
        "name": "Scatter",
        "type": "value",
        "id": "scatter"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/film-texture",
    "name": "Film Texture",
    "category": "postprocess",
    "summary": {
      "fr": "Film Texture — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Film Texture — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Grain",
        "type": "value",
        "id": "grain"
      },
      {
        "name": "Dust",
        "type": "value",
        "id": "dust"
      },
      {
        "name": "Scratches",
        "type": "value",
        "id": "scratches"
      },
      {
        "name": "Blotches",
        "type": "value",
        "id": "blotches"
      },
      {
        "name": "Rate (fps)",
        "type": "value",
        "id": "rate"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/super8",
    "name": "Super 8 Projector",
    "category": "postprocess",
    "summary": {
      "fr": "Super 8 Projector — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Super 8 Projector — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Softness (px)",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Flicker",
        "type": "value",
        "id": "flicker"
      },
      {
        "name": "Gate Weave",
        "type": "value",
        "id": "weave"
      },
      {
        "name": "Warmth",
        "type": "value",
        "id": "warmth"
      },
      {
        "name": "Vignette",
        "type": "value",
        "id": "vignette"
      },
      {
        "name": "Rate (fps)",
        "type": "value",
        "id": "rate"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "postprocess/dry-brush",
    "name": "Dry Brush",
    "category": "postprocess",
    "summary": {
      "fr": "Dry Brush — Module nodal postprocess pour composition 3D et flux de signaux.",
      "en": "Dry Brush — postprocess node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      },
      {
        "name": "Coverage",
        "type": "value",
        "id": "coverage"
      },
      {
        "name": "Speck Size",
        "type": "value",
        "id": "speckSize"
      },
      {
        "name": "Softness",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Stroke Length",
        "type": "value",
        "id": "stretch"
      },
      {
        "name": "Stroke Angle (°)",
        "type": "value",
        "id": "strokeAngle"
      },
      {
        "name": "Paper Color",
        "type": "color",
        "id": "paperColor"
      }
    ],
    "outputs": [
      {
        "name": "Post-Process",
        "type": "postprocess",
        "id": "effect"
      }
    ]
  },
  {
    "id": "list/group",
    "name": "List Group",
    "category": "list",
    "summary": {
      "fr": "List Group — Module nodal list pour composition 3D et flux de signaux.",
      "en": "List Group — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "In 1",
        "type": "any",
        "id": "in0"
      }
    ],
    "outputs": [
      {
        "name": "List",
        "type": "list",
        "id": "list"
      }
    ]
  },
  {
    "id": "structure/spawn",
    "name": "Spawner",
    "category": "instance",
    "summary": {
      "fr": "Spawner — Module nodal instance pour composition 3D et flux de signaux.",
      "en": "Spawner — instance node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Support (Surface)",
        "type": "geometry",
        "id": "support"
      },
      {
        "name": "Items to Spawn",
        "type": "any",
        "id": "items"
      },
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "curve/to_line",
    "name": "Curve to Line",
    "category": "curve",
    "summary": {
      "fr": "Curve to Line — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve to Line — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/to_line_list",
    "name": "Curves to Lines",
    "category": "curve",
    "summary": {
      "fr": "Curves to Lines — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curves to Lines — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curves (List)",
        "type": "list",
        "id": "curves"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/grease-pencil",
    "name": "Grease Pencil",
    "category": "curve",
    "summary": {
      "fr": "Grease Pencil — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Grease Pencil — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Curves",
        "type": "curve",
        "id": "curves"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/paint-on-geometry",
    "name": "Paint on geometry",
    "category": "curve",
    "summary": {
      "fr": "Paint on geometry — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Paint on geometry — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Curves",
        "type": "curve",
        "id": "curves"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/from_point_lists",
    "name": "Curves from Point Lists",
    "category": "curve",
    "summary": {
      "fr": "Curves from Point Lists — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curves from Point Lists — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Point Lists (List of Lists)",
        "type": "list",
        "id": "pointLists"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/subdivide",
    "name": "Curve Subdivide",
    "category": "curve",
    "summary": {
      "fr": "Curve Subdivide — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve Subdivide — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Subdivisions",
        "type": "value",
        "id": "subdivisions"
      }
    ],
    "outputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      }
    ]
  },
  {
    "id": "curve/to_points",
    "name": "Curve to Points",
    "category": "curve",
    "summary": {
      "fr": "Curve to Points — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "Curve to Points — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Curve",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Max Points",
        "type": "value",
        "id": "maxPoints"
      }
    ],
    "outputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "X Values (List)",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values (List)",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values (List)",
        "type": "list",
        "id": "zValues"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "modifier/lattice",
    "name": "Lattice Deform",
    "category": "transform",
    "summary": {
      "fr": "Lattice Deform — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Lattice Deform — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Influence",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Per-Point Influence (List)",
        "type": "list",
        "id": "pointInfluence"
      },
      {
        "name": "Points List",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Bulge",
        "type": "value",
        "id": "bulge"
      },
      {
        "name": "Twist (°)",
        "type": "value",
        "id": "twist"
      },
      {
        "name": "Taper",
        "type": "value",
        "id": "taper"
      },
      {
        "name": "Bend",
        "type": "value",
        "id": "bend"
      },
      {
        "name": "Shear X",
        "type": "value",
        "id": "shearX"
      },
      {
        "name": "Shear Z",
        "type": "value",
        "id": "shearZ"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Cage Wireframe",
        "type": "geometry",
        "id": "cage"
      },
      {
        "name": "Points (Local)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Cage Points (Local)",
        "type": "list",
        "id": "cagePoints"
      }
    ]
  },
  {
    "id": "object/metaballs",
    "name": "Metaballs",
    "category": "object",
    "summary": {
      "fr": "Metaballs — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Metaballs — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Centres (Geometry)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Centres (Points)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Smooth",
        "type": "value",
        "id": "smooth"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Ball Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "modifier/boolean",
    "name": "Boolean",
    "category": "transform",
    "summary": {
      "fr": "Boolean — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Boolean — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Boolean Shape",
        "type": "geometry",
        "id": "boolean"
      },
      {
        "name": "Operation",
        "type": "value",
        "id": "operation"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/contour-scan",
    "name": "Contour Scan",
    "category": "transform",
    "summary": {
      "fr": "Contour Scan — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Contour Scan — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Target (Morph)",
        "type": "geometry",
        "id": "target"
      },
      {
        "name": "Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Stagger",
        "type": "value",
        "id": "stagger"
      },
      {
        "name": "Bulge",
        "type": "value",
        "id": "bulge"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Curves",
        "type": "list",
        "id": "curves"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/weld",
    "name": "Weld",
    "category": "transform",
    "summary": {
      "fr": "Weld — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Weld — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Weld Shape",
        "type": "geometry",
        "id": "weld"
      },
      {
        "name": "Blend",
        "type": "value",
        "id": "blend"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/subdivide",
    "name": "Subdivide",
    "category": "transform",
    "summary": {
      "fr": "Subdivide — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Subdivide — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Levels",
        "type": "value",
        "id": "levels"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/solidify",
    "name": "Solidify",
    "category": "transform",
    "summary": {
      "fr": "Solidify — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Solidify — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "thickness"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      },
      {
        "name": "Fill Rim",
        "type": "value",
        "id": "rim"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/extrude",
    "name": "Extrude Mesh",
    "category": "transform",
    "summary": {
      "fr": "Extrude Mesh — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Extrude Mesh — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Face Selection",
        "type": "list",
        "id": "selection"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Distance",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Passes",
        "type": "value",
        "id": "passes"
      },
      {
        "name": "Per-Pass Transform (Matrix)",
        "type": "matrix",
        "id": "transform"
      },
      {
        "name": "Rotation / Pass",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale / Pass",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Location / Pass",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Random %",
        "type": "value",
        "id": "random"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/edit-mesh",
    "name": "Edit Mesh",
    "category": "transform",
    "summary": {
      "fr": "Edit Mesh — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Edit Mesh — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/delete-geometry",
    "name": "Delete Geometry",
    "category": "transform",
    "summary": {
      "fr": "Delete Geometry — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Delete Geometry — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/face-selection",
    "name": "Face Selection",
    "category": "transform",
    "summary": {
      "fr": "Face Selection — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Face Selection — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Threshold",
        "type": "value",
        "id": "threshold"
      }
    ],
    "outputs": [
      {
        "name": "Selection",
        "type": "list",
        "id": "selection"
      },
      {
        "name": "Faces",
        "type": "list",
        "id": "faces"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/shade",
    "name": "Shade",
    "category": "transform",
    "summary": {
      "fr": "Shade — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Shade — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/visual-slice",
    "name": "Visual Slice",
    "category": "transform",
    "summary": {
      "fr": "Visual Slice — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Visual Slice — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Plane Point",
        "type": "vector",
        "id": "point"
      },
      {
        "name": "Plane Normal",
        "type": "vector",
        "id": "direction"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/clip-box",
    "name": "Clip Box",
    "category": "transform",
    "summary": {
      "fr": "Clip Box — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Clip Box — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Box Center",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Box Rotation (°)",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Box Size",
        "type": "vector",
        "id": "size"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "animation/wiggle",
    "name": "Wiggle",
    "category": "time",
    "summary": {
      "fr": "Bruit fractal fBm multi-octaves pilotant translation, rotation et échelle simultanément. L'équivalent du Wiggle d'After Effects.",
      "en": "Multi-octave fBm fractal noise driving translation, rotation, and scale simultaneously. The real-time AE Wiggle."
    },
    "inputs": [
      {
        "name": "Evolution",
        "type": "value",
        "id": "evolution"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Amplitude",
        "type": "value",
        "id": "amplitude"
      },
      {
        "name": "Vector Amp",
        "type": "vector",
        "id": "amplitudeVector"
      },
      {
        "name": "Rot Amp (°)",
        "type": "vector",
        "id": "rotationAmplitude"
      },
      {
        "name": "Scale Amp",
        "type": "vector",
        "id": "scaleAmplitude"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Octaves",
        "type": "value",
        "id": "octaves"
      },
      {
        "name": "Persistance",
        "type": "value",
        "id": "persistance"
      },
      {
        "name": "Lacunarity",
        "type": "value",
        "id": "lacunarity"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      },
      {
        "name": "Base Vector",
        "type": "vector",
        "id": "baseVector"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      },
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "math/wiggle-number",
    "name": "Wiggle Number",
    "category": "math",
    "summary": {
      "fr": "Wiggle Number — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Wiggle Number — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Evolution",
        "type": "value",
        "id": "evolution"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Amplitude",
        "type": "value",
        "id": "amplitude"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Octaves",
        "type": "value",
        "id": "octaves"
      },
      {
        "name": "Persistance",
        "type": "value",
        "id": "persistance"
      },
      {
        "name": "Lacunarity",
        "type": "value",
        "id": "lacunarity"
      },
      {
        "name": "Offset",
        "type": "value",
        "id": "offset"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "vector/wiggle-vector",
    "name": "Wiggle Vector",
    "category": "math",
    "summary": {
      "fr": "Wiggle Vector — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Wiggle Vector — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Evolution",
        "type": "value",
        "id": "evolution"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Amplitude",
        "type": "vector",
        "id": "amplitude"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Octaves",
        "type": "value",
        "id": "octaves"
      },
      {
        "name": "Persistance",
        "type": "value",
        "id": "persistance"
      },
      {
        "name": "Lacunarity",
        "type": "value",
        "id": "lacunarity"
      },
      {
        "name": "Base Vector",
        "type": "vector",
        "id": "baseVector"
      },
      {
        "name": "Points (Individual)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Influence (1=wiggle, 0=hold, continuous)",
        "type": "list",
        "id": "mask"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      },
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      }
    ]
  },
  {
    "id": "material/standard",
    "name": "Material",
    "category": "material",
    "summary": {
      "fr": "Material — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Material — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Emissive Color",
        "type": "color",
        "id": "emissive"
      },
      {
        "name": "Emissive Intensity",
        "type": "value",
        "id": "emissiveIntensity"
      },
      {
        "name": "Shadeless",
        "type": "value",
        "id": "shadeless"
      },
      {
        "name": "Roughness",
        "type": "value",
        "id": "roughness"
      },
      {
        "name": "Metalness",
        "type": "value",
        "id": "metalness"
      },
      {
        "name": "Wireframe",
        "type": "value",
        "id": "wireframe"
      },
      {
        "name": "Opacity",
        "type": "value",
        "id": "opacity"
      },
      {
        "name": "Transmission (Glass)",
        "type": "value",
        "id": "transmission"
      },
      {
        "name": "Glass Thickness",
        "type": "value",
        "id": "thickness"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/shadow-catcher",
    "name": "Shadow Catcher",
    "category": "material",
    "summary": {
      "fr": "Shadow Catcher — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Shadow Catcher — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Shadow Opacity",
        "type": "value",
        "id": "opacity"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Double Sided",
        "type": "value",
        "id": "doubleSided"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/worn",
    "name": "Worn Material",
    "category": "material",
    "summary": {
      "fr": "Worn Material — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Worn Material — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Base Material",
        "type": "material",
        "id": "base"
      },
      {
        "name": "Worn Material (Convex)",
        "type": "material",
        "id": "worn"
      },
      {
        "name": "Dirt Material (Concave)",
        "type": "material",
        "id": "dirt"
      },
      {
        "name": "Wear Amount",
        "type": "value",
        "id": "wearAmount"
      },
      {
        "name": "Dirt Amount",
        "type": "value",
        "id": "dirtAmount"
      },
      {
        "name": "Contrast",
        "type": "value",
        "id": "contrast"
      },
      {
        "name": "Noise Intensity",
        "type": "value",
        "id": "noise"
      },
      {
        "name": "Noise Scale",
        "type": "value",
        "id": "noiseScale"
      },
      {
        "name": "Noise Detail",
        "type": "value",
        "id": "noiseDetail"
      },
      {
        "name": "Surface Variation",
        "type": "value",
        "id": "variation"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Wear Patchiness",
        "type": "value",
        "id": "wearPatch"
      },
      {
        "name": "Dirt Patchiness",
        "type": "value",
        "id": "dirtPatch"
      },
      {
        "name": "Patch Scale",
        "type": "value",
        "id": "patchScale"
      },
      {
        "name": "Curvature Wear",
        "type": "value",
        "id": "curveWear"
      },
      {
        "name": "Curvature Dirt",
        "type": "value",
        "id": "curveDirt"
      },
      {
        "name": "Curvature Sensitivity",
        "type": "value",
        "id": "curveSensitivity"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/hologram",
    "name": "Hologram (Cyberpunk)",
    "category": "material",
    "summary": {
      "fr": "Hologram (Cyberpunk) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Hologram (Cyberpunk) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Neon Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Rim Color",
        "type": "color",
        "id": "rimColor"
      },
      {
        "name": "Scanlines Freq",
        "type": "value",
        "id": "scanlinesFrequency"
      },
      {
        "name": "Scanlines Speed",
        "type": "value",
        "id": "scanlinesSpeed"
      },
      {
        "name": "Fresnel Rim",
        "type": "value",
        "id": "fresnelPower"
      },
      {
        "name": "Glitch Strength",
        "type": "value",
        "id": "glitchStrength"
      },
      {
        "name": "Glitch Freq",
        "type": "value",
        "id": "glitchFrequency"
      },
      {
        "name": "Flicker Intensity",
        "type": "value",
        "id": "flickerIntensity"
      },
      {
        "name": "Stripe Sharpness",
        "type": "value",
        "id": "stripeSharpness"
      },
      {
        "name": "CRT Noise",
        "type": "value",
        "id": "noiseIntensity"
      },
      {
        "name": "Opacity",
        "type": "value",
        "id": "opacity"
      },
      {
        "name": "Enable Scanlines",
        "type": "value",
        "id": "enableScanlines"
      },
      {
        "name": "Enable Glitch",
        "type": "value",
        "id": "enableGlitch"
      },
      {
        "name": "Enable Noise",
        "type": "value",
        "id": "enableNoise"
      },
      {
        "name": "Enable Flicker",
        "type": "value",
        "id": "enableFlicker"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/liquid-metal",
    "name": "Liquid Metal (Warp)",
    "category": "material",
    "summary": {
      "fr": "Liquid Metal (Warp) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Liquid Metal (Warp) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Base Color",
        "type": "color",
        "id": "baseColor"
      },
      {
        "name": "Reflection Color",
        "type": "color",
        "id": "reflectionColor"
      },
      {
        "name": "Specular Color",
        "type": "color",
        "id": "specularColor"
      },
      {
        "name": "Warp Scale",
        "type": "value",
        "id": "warpScale"
      },
      {
        "name": "Warp Intensity",
        "type": "value",
        "id": "warpIntensity"
      },
      {
        "name": "Fluid Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Viscosity",
        "type": "value",
        "id": "viscosity"
      },
      {
        "name": "Roughness",
        "type": "value",
        "id": "roughness"
      },
      {
        "name": "Metalness",
        "type": "value",
        "id": "metalness"
      },
      {
        "name": "Perlescent Sheen",
        "type": "value",
        "id": "iridescence"
      },
      {
        "name": "Fresnel Rim",
        "type": "value",
        "id": "fresnelPower"
      },
      {
        "name": "Enable Displacement",
        "type": "value",
        "id": "enableDisplacement"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/cel-shade",
    "name": "Cel-Shading (Toon / BD)",
    "category": "material",
    "summary": {
      "fr": "Cel-Shading (Toon / BD) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Cel-Shading (Toon / BD) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "shadowColor"
      },
      {
        "name": "Halftone Dot Color",
        "type": "color",
        "id": "halftoneDotColor"
      },
      {
        "name": "Bands (Levels)",
        "type": "value",
        "id": "bands"
      },
      {
        "name": "Band Softness",
        "type": "value",
        "id": "bandSoftness"
      },
      {
        "name": "Halftone Dots",
        "type": "value",
        "id": "halftone"
      },
      {
        "name": "Halftone Scale",
        "type": "value",
        "id": "halftoneScale"
      },
      {
        "name": "Rim Color",
        "type": "color",
        "id": "rimColor"
      },
      {
        "name": "Rim Power",
        "type": "value",
        "id": "rimPower"
      },
      {
        "name": "Specular Hardness",
        "type": "value",
        "id": "specularHardness"
      },
      {
        "name": "Specular Strength",
        "type": "value",
        "id": "specularStrength"
      },
      {
        "name": "Enable Halftone",
        "type": "value",
        "id": "enableHalftone"
      },
      {
        "name": "Enable Rim Light",
        "type": "value",
        "id": "enableRim"
      },
      {
        "name": "Enable Specular",
        "type": "value",
        "id": "enableSpecular"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/iridescent",
    "name": "Iridescent (Thin Film)",
    "category": "material",
    "summary": {
      "fr": "Iridescent (Thin Film) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Iridescent (Thin Film) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Base Color",
        "type": "color",
        "id": "baseColor"
      },
      {
        "name": "Specular Color",
        "type": "color",
        "id": "specularColor"
      },
      {
        "name": "Film Thickness (nm)",
        "type": "value",
        "id": "filmThickness"
      },
      {
        "name": "Refractive Index",
        "type": "value",
        "id": "refractiveIndex"
      },
      {
        "name": "Rainbow Boost",
        "type": "value",
        "id": "boost"
      },
      {
        "name": "Roughness",
        "type": "value",
        "id": "roughness"
      },
      {
        "name": "Ripple Speed",
        "type": "value",
        "id": "rippleSpeed"
      },
      {
        "name": "Ripple Frequency",
        "type": "value",
        "id": "rippleFrequency"
      },
      {
        "name": "Rainbow Mix",
        "type": "value",
        "id": "rainbowMix"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/wireframe-pulse",
    "name": "Wireframe Pulse",
    "category": "material",
    "summary": {
      "fr": "Wireframe Pulse — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Wireframe Pulse — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Fill Color",
        "type": "color",
        "id": "fillColor"
      },
      {
        "name": "Fill Opacity",
        "type": "value",
        "id": "fillOpacity"
      },
      {
        "name": "Edge Color",
        "type": "color",
        "id": "edgeColor"
      },
      {
        "name": "Edge Width",
        "type": "value",
        "id": "edgeWidth"
      },
      {
        "name": "Pulse Color",
        "type": "color",
        "id": "pulseColor"
      },
      {
        "name": "Pulse Speed",
        "type": "value",
        "id": "pulseSpeed"
      },
      {
        "name": "Pulse Length",
        "type": "value",
        "id": "pulseLength"
      },
      {
        "name": "Pulse Frequency",
        "type": "value",
        "id": "pulseFrequency"
      },
      {
        "name": "Glow Intensity",
        "type": "value",
        "id": "glowIntensity"
      },
      {
        "name": "Enable Fill",
        "type": "value",
        "id": "enableFill"
      },
      {
        "name": "Enable Pulse",
        "type": "value",
        "id": "enablePulse"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/thermal",
    "name": "Thermal Vision (FLIR)",
    "category": "material",
    "summary": {
      "fr": "Thermal Vision (FLIR) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Thermal Vision (FLIR) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Cold Color",
        "type": "color",
        "id": "coldColor"
      },
      {
        "name": "Hot Color",
        "type": "color",
        "id": "hotColor"
      },
      {
        "name": "Heat Scale",
        "type": "value",
        "id": "heatScale"
      },
      {
        "name": "Min Temp",
        "type": "value",
        "id": "minTemp"
      },
      {
        "name": "Max Temp",
        "type": "value",
        "id": "maxTemp"
      },
      {
        "name": "Heat Shimmer",
        "type": "value",
        "id": "distortion"
      },
      {
        "name": "Shimmer Speed",
        "type": "value",
        "id": "shimmerSpeed"
      },
      {
        "name": "Enable Distortion",
        "type": "value",
        "id": "enableDistortion"
      },
      {
        "name": "Invert (White Hot)",
        "type": "value",
        "id": "invert"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/xray",
    "name": "X-Ray / Radiology",
    "category": "material",
    "summary": {
      "fr": "X-Ray / Radiology — Module nodal material pour composition 3D et flux de signaux.",
      "en": "X-Ray / Radiology — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Tint Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Core Density Color",
        "type": "color",
        "id": "coreColor"
      },
      {
        "name": "Edge Intensity",
        "type": "value",
        "id": "edgeIntensity"
      },
      {
        "name": "Interior Opacity",
        "type": "value",
        "id": "interiorOpacity"
      },
      {
        "name": "Rim Power",
        "type": "value",
        "id": "rimPower"
      },
      {
        "name": "Noise Intensity",
        "type": "value",
        "id": "noiseIntensity"
      },
      {
        "name": "Enable Film Grain",
        "type": "value",
        "id": "enableGrain"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/energy-shield",
    "name": "Energy Shield (Hex)",
    "category": "material",
    "summary": {
      "fr": "Energy Shield (Hex) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Energy Shield (Hex) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Shield Color",
        "type": "color",
        "id": "shieldColor"
      },
      {
        "name": "Hex Grid Color",
        "type": "color",
        "id": "gridColor"
      },
      {
        "name": "Hex Scale",
        "type": "value",
        "id": "hexScale"
      },
      {
        "name": "Edge Sharpness",
        "type": "value",
        "id": "edgeSharpness"
      },
      {
        "name": "Fresnel Power",
        "type": "value",
        "id": "fresnelPower"
      },
      {
        "name": "Pulse Speed",
        "type": "value",
        "id": "pulseSpeed"
      },
      {
        "name": "Pulse Intensity",
        "type": "value",
        "id": "pulseIntensity"
      },
      {
        "name": "Enable Hex Grid",
        "type": "value",
        "id": "enableGrid"
      },
      {
        "name": "Enable Pulse Wave",
        "type": "value",
        "id": "enablePulse"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/stylized_fire",
    "name": "Stylized Flame (SDF)",
    "category": "material",
    "summary": {
      "fr": "Stylized Flame (SDF) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Stylized Flame (SDF) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Smoothness (k)",
        "type": "value",
        "id": "smoothness"
      },
      {
        "name": "Color Softness",
        "type": "value",
        "id": "colorSoftness"
      },
      {
        "name": "Show Core",
        "type": "value",
        "id": "enableCore"
      },
      {
        "name": "Show Inner",
        "type": "value",
        "id": "enableInner"
      },
      {
        "name": "Show Shadow",
        "type": "value",
        "id": "enableDark"
      },
      {
        "name": "Show Outline",
        "type": "value",
        "id": "enableOutline"
      },
      {
        "name": "Flame Width",
        "type": "value",
        "id": "flameWidth"
      },
      {
        "name": "Flame Height",
        "type": "value",
        "id": "flameHeight"
      },
      {
        "name": "Wave Speed",
        "type": "value",
        "id": "waveSpeed"
      },
      {
        "name": "Wave Freq",
        "type": "value",
        "id": "waveFrequency"
      },
      {
        "name": "Wave Amp",
        "type": "value",
        "id": "waveAmplitude"
      },
      {
        "name": "Bubble Speed",
        "type": "value",
        "id": "bubbleSpeed"
      },
      {
        "name": "Bubble Scale",
        "type": "value",
        "id": "bubbleScale"
      },
      {
        "name": "Internal Holes",
        "type": "value",
        "id": "internalHoles"
      },
      {
        "name": "Core Size",
        "type": "value",
        "id": "coreSize"
      },
      {
        "name": "Core Offset Y",
        "type": "value",
        "id": "coreOffsetY"
      },
      {
        "name": "Core Masking",
        "type": "value",
        "id": "coreBaseMask"
      },
      {
        "name": "Base Curvature (Y)",
        "type": "value",
        "id": "baseCurvature"
      },
      {
        "name": "Outline Width",
        "type": "value",
        "id": "outlineWidth"
      },
      {
        "name": "Core Color",
        "type": "color",
        "id": "coreColor"
      },
      {
        "name": "Inner Color",
        "type": "color",
        "id": "innerColor"
      },
      {
        "name": "Body Color",
        "type": "color",
        "id": "bodyColor"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "darkColor"
      },
      {
        "name": "Outline Color",
        "type": "color",
        "id": "outlineColor"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/miyazaki_cloud",
    "name": "Miyazaki Cloud (Ghibli)",
    "category": "material",
    "summary": {
      "fr": "Miyazaki Cloud (Ghibli) — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Miyazaki Cloud (Ghibli) — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Cumulus Height",
        "type": "value",
        "id": "cumulusHeight"
      },
      {
        "name": "Cloud Width",
        "type": "value",
        "id": "cloudWidth"
      },
      {
        "name": "Base Flatness",
        "type": "value",
        "id": "baseFlatness"
      },
      {
        "name": "Puffiness",
        "type": "value",
        "id": "puffiness"
      },
      {
        "name": "Micro-Puffs Detail",
        "type": "value",
        "id": "detail"
      },
      {
        "name": "Sun Angle (deg)",
        "type": "value",
        "id": "sunAngle"
      },
      {
        "name": "Sun Elevation",
        "type": "value",
        "id": "sunElevation"
      },
      {
        "name": "Shadow Intensity",
        "type": "value",
        "id": "shadowIntensity"
      },
      {
        "name": "Band Softness",
        "type": "value",
        "id": "bandSoftness"
      },
      {
        "name": "Edge Sharpness",
        "type": "value",
        "id": "edgeSharpness"
      },
      {
        "name": "Outline Width",
        "type": "value",
        "id": "outlineWidth"
      },
      {
        "name": "Highlight Color",
        "type": "color",
        "id": "highlightColor"
      },
      {
        "name": "Body Color",
        "type": "color",
        "id": "bodyColor"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "shadowColor"
      },
      {
        "name": "Deep Shadow Color",
        "type": "color",
        "id": "deepShadowColor"
      },
      {
        "name": "Outline Color",
        "type": "color",
        "id": "outlineColor"
      },
      {
        "name": "Show Highlight Rim",
        "type": "value",
        "id": "enableHighlight"
      },
      {
        "name": "Show Deep Shadow",
        "type": "value",
        "id": "enableDeepShadow"
      },
      {
        "name": "Show Outline",
        "type": "value",
        "id": "enableOutline"
      },
      {
        "name": "Show Puff Clusters",
        "type": "value",
        "id": "enablePuffs"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "material/stylized-water",
    "name": "Stylized Water",
    "category": "material",
    "summary": {
      "fr": "Stylized Water — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Stylized Water — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Terrain Heightmap",
        "type": "texture",
        "id": "shoreMap"
      },
      {
        "name": "Surface Elevation (Y)",
        "type": "value",
        "id": "surfaceElevation"
      },
      {
        "name": "Depth Elevation (Y)",
        "type": "value",
        "id": "depthElevation"
      },
      {
        "name": "Terrain Width (X)",
        "type": "value",
        "id": "terrainWidth"
      },
      {
        "name": "Terrain Depth (Z)",
        "type": "value",
        "id": "terrainDepth"
      },
      {
        "name": "Terrain Center",
        "type": "vector",
        "id": "terrainCenter"
      },
      {
        "name": "Shore Foam Width",
        "type": "value",
        "id": "shoreFoamWidth"
      },
      {
        "name": "Ripples Speed",
        "type": "value",
        "id": "ripplesSpeed"
      },
      {
        "name": "Ripples per Shore",
        "type": "value",
        "id": "ripplesCount"
      },
      {
        "name": "Ripples Reach",
        "type": "value",
        "id": "ripplesReach"
      },
      {
        "name": "Temperature (°C)",
        "type": "value",
        "id": "temperature"
      },
      {
        "name": "Rain (0-1)",
        "type": "value",
        "id": "rain"
      },
      {
        "name": "Ripples Ratio (override)",
        "type": "value",
        "id": "ripplesRatio"
      },
      {
        "name": "Ice Ratio (override)",
        "type": "value",
        "id": "iceRatio"
      },
      {
        "name": "Splashes Ratio (override)",
        "type": "value",
        "id": "splashesRatio"
      },
      {
        "name": "Sand Color",
        "type": "color",
        "id": "sandColor"
      },
      {
        "name": "Shallow Color",
        "type": "color",
        "id": "shallowColor"
      },
      {
        "name": "Deep Color",
        "type": "color",
        "id": "deepColor"
      },
      {
        "name": "Details Color",
        "type": "color",
        "id": "detailsColor"
      },
      {
        "name": "Water Tint",
        "type": "value",
        "id": "waterTint"
      },
      {
        "name": "Shore Edge Fade",
        "type": "value",
        "id": "edgeFade"
      },
      {
        "name": "Foam Shadow",
        "type": "value",
        "id": "detailsShadowStrength"
      },
      {
        "name": "Segment Gaps",
        "type": "value",
        "id": "ripplesSegmentGap"
      }
    ],
    "outputs": [
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      }
    ]
  },
  {
    "id": "object/explosion",
    "name": "Explosion",
    "category": "object",
    "summary": {
      "fr": "Explosion — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Explosion — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Fire Radius",
        "type": "value",
        "id": "fireRadius"
      },
      {
        "name": "Core Color",
        "type": "color",
        "id": "emissiveColorA"
      },
      {
        "name": "Flame Color",
        "type": "color",
        "id": "emissiveColorB"
      },
      {
        "name": "Emissive Strength",
        "type": "value",
        "id": "emissiveStrength"
      },
      {
        "name": "Overbright (for Bloom)",
        "type": "value",
        "id": "glowGain"
      },
      {
        "name": "Floor Level (Y)",
        "type": "value",
        "id": "floorLevel"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Burn Progress",
        "type": "value",
        "id": "progress"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      }
    ]
  },
  {
    "id": "object/leaves",
    "name": "Leaves",
    "category": "object",
    "summary": {
      "fr": "Leaves — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Leaves — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Wind Field",
        "type": "any",
        "id": "wind"
      },
      {
        "name": "Ground",
        "type": "geometry",
        "id": "ground"
      },
      {
        "name": "Focus (Follow)",
        "type": "vector",
        "id": "focus"
      },
      {
        "name": "Mover Position",
        "type": "vector",
        "id": "pusher"
      },
      {
        "name": "Mover Velocity",
        "type": "vector",
        "id": "pusherVelocity"
      },
      {
        "name": "Blast Trigger",
        "type": "value",
        "id": "blastTrigger"
      },
      {
        "name": "Blast Position",
        "type": "vector",
        "id": "blastPosition"
      },
      {
        "name": "Blast Radius",
        "type": "value",
        "id": "blastRadius"
      },
      {
        "name": "Wind Multiplier",
        "type": "value",
        "id": "windMultiplier"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Leaf Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "time/reset-simulations",
    "name": "Reset Simulations",
    "category": "time",
    "summary": {
      "fr": "Reset Simulations — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Reset Simulations — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      }
    ],
    "outputs": [
      {
        "name": "Fired",
        "type": "value",
        "id": "fired"
      },
      {
        "name": "Reset Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "physics/spawner",
    "name": "Spawner",
    "category": "physics",
    "summary": {
      "fr": "Spawner — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Spawner — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Object",
        "type": "geometry",
        "id": "prototype"
      },
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Spawn Point",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Direction",
        "type": "vector",
        "id": "direction"
      },
      {
        "name": "Launch Speed",
        "type": "value",
        "id": "speed"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "In Flight",
        "type": "value",
        "id": "alive"
      },
      {
        "name": "Spawned",
        "type": "value",
        "id": "spawned"
      }
    ]
  },
  {
    "id": "physics/explosion",
    "name": "Explosion Impulse",
    "category": "physics",
    "summary": {
      "fr": "Explosion Impulse — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Explosion Impulse — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      }
    ],
    "outputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Bodies Hit",
        "type": "value",
        "id": "hits"
      }
    ]
  },
  {
    "id": "geometry/twist-bend-taper",
    "name": "Twist / Bend / Taper",
    "category": "structure",
    "summary": {
      "fr": "Twist / Bend / Taper — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Twist / Bend / Taper — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Twist (°)",
        "type": "value",
        "id": "twist"
      },
      {
        "name": "Bend (°)",
        "type": "value",
        "id": "bend"
      },
      {
        "name": "Taper",
        "type": "value",
        "id": "taper"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "geometry/wave-ripple",
    "name": "Wave / Ripple",
    "category": "structure",
    "summary": {
      "fr": "Wave / Ripple — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Wave / Ripple — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Amplitude",
        "type": "value",
        "id": "amplitude"
      },
      {
        "name": "Frequency",
        "type": "value",
        "id": "frequency"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Decay (Ripple)",
        "type": "value",
        "id": "decay"
      },
      {
        "name": "Center X",
        "type": "value",
        "id": "centerX"
      },
      {
        "name": "Center Z",
        "type": "value",
        "id": "centerZ"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "geometry/facet-explode",
    "name": "Facet Explode",
    "category": "structure",
    "summary": {
      "fr": "Facet Explode — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Facet Explode — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Explosion Dist",
        "type": "value",
        "id": "distance"
      },
      {
        "name": "Random Spread",
        "type": "value",
        "id": "randomFactor"
      },
      {
        "name": "Facet Scale",
        "type": "value",
        "id": "scale"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "particles/curl-noise",
    "name": "Curl Noise Field",
    "category": "particles",
    "summary": {
      "fr": "Curl Noise Field — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Curl Noise Field — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Frequency / Scale",
        "type": "value",
        "id": "scale"
      },
      {
        "name": "Evolution Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Influence Radius",
        "type": "value",
        "id": "radius"
      }
    ],
    "outputs": [
      {
        "name": "Force Field",
        "type": "any",
        "id": "field"
      }
    ]
  },
  {
    "id": "particles/strange-attractor",
    "name": "Strange Attractor",
    "category": "particles",
    "summary": {
      "fr": "Strange Attractor — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Strange Attractor — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      },
      {
        "name": "Point Count",
        "type": "value",
        "id": "steps"
      },
      {
        "name": "dt Step",
        "type": "value",
        "id": "stepSize"
      },
      {
        "name": "Attractor Size",
        "type": "value",
        "id": "attractorScale"
      },
      {
        "name": "Evolution Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Color Speed",
        "type": "value",
        "id": "colorSpeed"
      },
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Point Size",
        "type": "value",
        "id": "pointSize"
      },
      {
        "name": "Param a",
        "type": "value",
        "id": "paramA"
      },
      {
        "name": "Param b",
        "type": "value",
        "id": "paramB"
      },
      {
        "name": "Param c",
        "type": "value",
        "id": "paramC"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Points List",
        "type": "list",
        "id": "points"
      }
    ]
  },
  {
    "id": "object/laser-beam",
    "name": "Laser Beam (Stage FX)",
    "category": "object",
    "summary": {
      "fr": "Laser Beam (Stage FX) — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Laser Beam (Stage FX) — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Location",
        "type": "vector",
        "id": "location"
      },
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Scale",
        "type": "vector",
        "id": "scale"
      },
      {
        "name": "Pan (°)",
        "type": "value",
        "id": "pan"
      },
      {
        "name": "Tilt (°)",
        "type": "value",
        "id": "tilt"
      },
      {
        "name": "Laser Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Beam Length",
        "type": "value",
        "id": "length"
      },
      {
        "name": "Beam Thickness",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Divergence",
        "type": "value",
        "id": "coneAngle"
      },
      {
        "name": "Strobe Pulse",
        "type": "value",
        "id": "pulseFrequency"
      },
      {
        "name": "Beam Opacity",
        "type": "value",
        "id": "beamFade"
      },
      {
        "name": "Spot Size",
        "type": "value",
        "id": "spotSize"
      },
      {
        "name": "Show Hit Spot",
        "type": "value",
        "id": "showHitSpot"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Direction",
        "type": "vector",
        "id": "direction"
      },
      {
        "name": "Hit Position",
        "type": "vector",
        "id": "hitPosition"
      }
    ]
  },
  {
    "id": "light/probe",
    "name": "Light Probe",
    "category": "lighting",
    "summary": {
      "fr": "Light Probe — Module nodal lighting pour composition 3D et flux de signaux.",
      "en": "Light Probe — lighting node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      }
    ],
    "outputs": [
      {
        "name": "Light",
        "type": "geometry",
        "id": "light"
      }
    ]
  },
  {
    "id": "object/decal",
    "name": "Decal",
    "category": "material",
    "summary": {
      "fr": "Decal — Module nodal material pour composition 3D et flux de signaux.",
      "en": "Decal — material node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target Surface",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Color",
        "type": "color",
        "id": "color"
      },
      {
        "name": "Opacity",
        "type": "value",
        "id": "opacity"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "modifier/invert-normals",
    "name": "Invert Normals",
    "category": "transform",
    "summary": {
      "fr": "Invert Normals — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Invert Normals — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "hub/text",
    "name": "HUD Text",
    "category": "hub",
    "summary": {
      "fr": "HUD Text — Module nodal hub pour composition 3D et flux de signaux.",
      "en": "HUD Text — hub node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Text",
        "type": "text",
        "id": "text"
      },
      {
        "name": "Position X",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Position Y",
        "type": "value",
        "id": "y"
      },
      {
        "name": "Rotation",
        "type": "value",
        "id": "rotation"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "HUD Element",
        "type": "any",
        "id": "hud"
      }
    ]
  },
  {
    "id": "hub/image",
    "name": "HUD Image",
    "category": "hub",
    "summary": {
      "fr": "HUD Image — Module nodal hub pour composition 3D et flux de signaux.",
      "en": "HUD Image — hub node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Trigger",
        "type": "value",
        "id": "trigger"
      },
      {
        "name": "Position X",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Position Y",
        "type": "value",
        "id": "y"
      },
      {
        "name": "Rotation",
        "type": "value",
        "id": "rotation"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "HUD Element",
        "type": "any",
        "id": "hud"
      }
    ]
  },
  {
    "id": "curve/svg",
    "name": "SVG to Curves",
    "category": "curve",
    "summary": {
      "fr": "SVG to Curves — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "SVG to Curves — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      }
    ],
    "outputs": [
      {
        "name": "Curve (first)",
        "type": "curve",
        "id": "curve"
      },
      {
        "name": "Curves (list)",
        "type": "list",
        "id": "curves"
      },
      {
        "name": "Curve Preview",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "curve/svg_mesh",
    "name": "SVG to Mesh",
    "category": "curve",
    "summary": {
      "fr": "SVG to Mesh — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "SVG to Mesh — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "curve/svg_solid",
    "name": "SVG to Solid",
    "category": "curve",
    "summary": {
      "fr": "SVG to Solid — Module nodal curve pour composition 3D et flux de signaux.",
      "en": "SVG to Solid — curve node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Depth",
        "type": "value",
        "id": "depth"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Texture Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Normal Map",
        "type": "texture",
        "id": "normal"
      },
      {
        "name": "Roughness Map",
        "type": "texture",
        "id": "roughnessMap"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "physics/raycast",
    "name": "Raycast",
    "category": "physics",
    "summary": {
      "fr": "Raycast — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Raycast — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Surface",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Origin",
        "type": "vector",
        "id": "origin"
      },
      {
        "name": "Direction",
        "type": "vector",
        "id": "direction"
      },
      {
        "name": "Max Distance",
        "type": "value",
        "id": "maxDistance"
      }
    ],
    "outputs": [
      {
        "name": "Hit (0/1)",
        "type": "value",
        "id": "hit"
      },
      {
        "name": "Hit Point",
        "type": "vector",
        "id": "point"
      },
      {
        "name": "Hit Normal",
        "type": "vector",
        "id": "normal"
      },
      {
        "name": "Distance",
        "type": "value",
        "id": "distance"
      }
    ]
  },
  {
    "id": "physics/ray-burst",
    "name": "Ray Burst",
    "category": "physics",
    "summary": {
      "fr": "Ray Burst — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Ray Burst — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Center",
        "type": "vector",
        "id": "origin"
      },
      {
        "name": "Ray Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Rotate (°/s)",
        "type": "value",
        "id": "rotate"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      }
    ],
    "outputs": [
      {
        "name": "Rays (Lines)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Ray Origins",
        "type": "list",
        "id": "rayOrigins"
      },
      {
        "name": "Hit Points",
        "type": "list",
        "id": "hitPoints"
      },
      {
        "name": "Hit Normals",
        "type": "list",
        "id": "hitNormals"
      },
      {
        "name": "Hits (0/1)",
        "type": "list",
        "id": "hits"
      },
      {
        "name": "Distances",
        "type": "list",
        "id": "distances"
      }
    ]
  },
  {
    "id": "physics/sample",
    "name": "Surface Scatter",
    "category": "physics",
    "summary": {
      "fr": "Surface Scatter — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Surface Scatter — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Surface",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Normals",
        "type": "list",
        "id": "normals"
      }
    ]
  },
  {
    "id": "physics/volume_scatter",
    "name": "Volume Scatter",
    "category": "physics",
    "summary": {
      "fr": "Volume Scatter — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Volume Scatter — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Volume",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      }
    ],
    "outputs": [
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Normals",
        "type": "list",
        "id": "normals"
      }
    ]
  },
  {
    "id": "list/stagger",
    "name": "Stagger",
    "category": "list",
    "summary": {
      "fr": "Stagger — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Stagger — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Source (List / Geometry)",
        "type": "any",
        "id": "source"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Duration (s)",
        "type": "value",
        "id": "duration"
      },
      {
        "name": "Stagger (s)",
        "type": "value",
        "id": "offset"
      },
      {
        "name": "Total (s)",
        "type": "value",
        "id": "total"
      },
      {
        "name": "From",
        "type": "value",
        "id": "from"
      },
      {
        "name": "To",
        "type": "value",
        "id": "to"
      },
      {
        "name": "First Start (s)",
        "type": "value",
        "id": "startAt"
      }
    ],
    "outputs": [
      {
        "name": "Values",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Progress (0–1)",
        "type": "list",
        "id": "progress"
      },
      {
        "name": "Active (0/1)",
        "type": "list",
        "id": "active"
      },
      {
        "name": "Start Times",
        "type": "list",
        "id": "delays"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "time/remap",
    "name": "Time Remap",
    "category": "time",
    "summary": {
      "fr": "Time Remap — Module nodal time pour composition 3D et flux de signaux.",
      "en": "Time Remap — time node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Input Start",
        "type": "value",
        "id": "inStart"
      },
      {
        "name": "Input End",
        "type": "value",
        "id": "inEnd"
      },
      {
        "name": "Output Start",
        "type": "value",
        "id": "outStart"
      },
      {
        "name": "Output End",
        "type": "value",
        "id": "outEnd"
      },
      {
        "name": "Loop",
        "type": "value",
        "id": "loop"
      }
    ],
    "outputs": [
      {
        "name": "Remapped Time",
        "type": "value",
        "id": "time"
      }
    ]
  },
  {
    "id": "transform/orbit",
    "name": "Orbit",
    "category": "transform",
    "summary": {
      "fr": "Orbit — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Orbit — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target (Geometry / Matrix)",
        "type": "any",
        "id": "target"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Speed (°/s)",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Phase (°)",
        "type": "value",
        "id": "phase"
      },
      {
        "name": "Height",
        "type": "value",
        "id": "height"
      }
    ],
    "outputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      }
    ]
  },
  {
    "id": "matrix/math",
    "name": "Matrix Math",
    "category": "math",
    "summary": {
      "fr": "Matrix Math — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Matrix Math — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "A",
        "type": "matrix",
        "id": "a"
      },
      {
        "name": "B",
        "type": "matrix",
        "id": "b"
      },
      {
        "name": "Factor (mix)",
        "type": "value",
        "id": "factor"
      }
    ],
    "outputs": [
      {
        "name": "Out",
        "type": "matrix",
        "id": "out"
      },
      {
        "name": "Determinant",
        "type": "value",
        "id": "determinant"
      }
    ]
  },
  {
    "id": "structure/trail",
    "name": "Trail",
    "category": "structure",
    "summary": {
      "fr": "Trail — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Trail — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "History (s)",
        "type": "value",
        "id": "history"
      },
      {
        "name": "Segments",
        "type": "value",
        "id": "segments"
      }
    ],
    "outputs": [
      {
        "name": "Points (World)",
        "type": "list",
        "id": "points"
      }
    ]
  },
  {
    "id": "modifier/squash-stretch",
    "name": "Squash & Stretch",
    "category": "structure",
    "summary": {
      "fr": "Squash & Stretch — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Squash & Stretch — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Intensity",
        "type": "value",
        "id": "intensity"
      },
      {
        "name": "Max Speed",
        "type": "value",
        "id": "maxSpeed"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      },
      {
        "name": "Bounciness",
        "type": "value",
        "id": "bounciness"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "math/velocity",
    "name": "Velocity",
    "category": "math",
    "summary": {
      "fr": "Velocity — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Velocity — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      }
    ],
    "outputs": [
      {
        "name": "Speed (units/s)",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Velocity Vector",
        "type": "vector",
        "id": "velocity"
      }
    ]
  },
  {
    "id": "physics/rolling",
    "name": "Rolling",
    "category": "physics",
    "summary": {
      "fr": "Rolling — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Rolling — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Size",
        "type": "value",
        "id": "size"
      },
      {
        "name": "Rolling Plane Normal (Up)",
        "type": "vector",
        "id": "axis"
      }
    ],
    "outputs": [
      {
        "name": "Rotation",
        "type": "vector",
        "id": "rotation"
      },
      {
        "name": "Position (bobbed)",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Bob",
        "type": "value",
        "id": "bob"
      }
    ]
  },
  {
    "id": "math/spring",
    "name": "Spring",
    "category": "math",
    "summary": {
      "fr": "Spring — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Spring — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target",
        "type": "value",
        "id": "target"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      },
      {
        "name": "Bounciness",
        "type": "value",
        "id": "bounciness"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "vector/spring",
    "name": "Spring Vector",
    "category": "math",
    "summary": {
      "fr": "Spring Vector — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Spring Vector — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Target",
        "type": "vector",
        "id": "target"
      },
      {
        "name": "Points (Individual)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Influence (1=spring, 0=hold, continuous)",
        "type": "list",
        "id": "mask"
      },
      {
        "name": "Geometry (optional passthrough)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Smoothing",
        "type": "value",
        "id": "smoothing"
      },
      {
        "name": "Bounciness",
        "type": "value",
        "id": "bounciness"
      }
    ],
    "outputs": [
      {
        "name": "Vector",
        "type": "vector",
        "id": "vector"
      },
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Geometry (when Geometry is wired)",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "converter/mesh-to-points",
    "name": "Mesh to Points",
    "category": "converter",
    "summary": {
      "fr": "Mesh to Points — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Mesh to Points — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Points (Local)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Geometry (passthrough)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "converter/points-to-mesh",
    "name": "Points to Mesh",
    "category": "converter",
    "summary": {
      "fr": "Points to Mesh — Module nodal converter pour composition 3D et flux de signaux.",
      "en": "Points to Mesh — converter node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Points (Local)",
        "type": "list",
        "id": "points"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      }
    ]
  },
  {
    "id": "list/points-selection",
    "name": "Points Selection",
    "category": "list",
    "summary": {
      "fr": "Points Selection — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Points Selection — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry (shortcut)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Matrix (viewport placement)",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Points (passthrough)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Mask (1=selected)",
        "type": "list",
        "id": "mask"
      },
      {
        "name": "Matrix (passthrough)",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Geometry (passthrough)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Selected Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "list/points-influence",
    "name": "Points Influence",
    "category": "list",
    "summary": {
      "fr": "Points Influence — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Points Influence — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry (shortcut)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Points",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Matrix (viewport placement)",
        "type": "matrix",
        "id": "matrix"
      }
    ],
    "outputs": [
      {
        "name": "Points (passthrough)",
        "type": "list",
        "id": "points"
      },
      {
        "name": "Influence (0-1 per point)",
        "type": "list",
        "id": "influence"
      },
      {
        "name": "Matrix (passthrough)",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Geometry (passthrough)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Painted Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "particles/connect-nearby",
    "name": "Connect Nearby",
    "category": "particles",
    "summary": {
      "fr": "Connect Nearby — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Connect Nearby — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "Max Distance",
        "type": "value",
        "id": "maxDistance"
      },
      {
        "name": "Max Connections / Point",
        "type": "value",
        "id": "maxConnections"
      }
    ],
    "outputs": [
      {
        "name": "Lines (Geometry)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Connection Count",
        "type": "value",
        "id": "connectionCount"
      }
    ]
  },
  {
    "id": "particles/capture-trails",
    "name": "Capture Trails",
    "category": "particles",
    "summary": {
      "fr": "Capture Trails — Module nodal particles pour composition 3D et flux de signaux.",
      "en": "Capture Trails — particles node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positions",
        "type": "texture",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "History Length",
        "type": "value",
        "id": "historyLength"
      }
    ],
    "outputs": [
      {
        "name": "Trails (Geometry)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Segment Count",
        "type": "value",
        "id": "segmentCount"
      },
      {
        "name": "Point Lists (List of Lists)",
        "type": "list",
        "id": "trails"
      }
    ]
  },
  {
    "id": "math/distances",
    "name": "Distances",
    "category": "math",
    "summary": {
      "fr": "Distances — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Distances — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Instances / Candidates (List or Group)",
        "type": "any",
        "id": "instances"
      },
      {
        "name": "Target (Vector / Object / Matrix)",
        "type": "any",
        "id": "target"
      }
    ],
    "outputs": [
      {
        "name": "Distances",
        "type": "list",
        "id": "distances"
      },
      {
        "name": "Distances Sq",
        "type": "list",
        "id": "distancesSq"
      },
      {
        "name": "Min Distance",
        "type": "value",
        "id": "min"
      },
      {
        "name": "Max Distance",
        "type": "value",
        "id": "max"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "structure/hex-grid",
    "name": "Hex Grid",
    "category": "structure",
    "summary": {
      "fr": "Hex Grid — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Hex Grid — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Cols (X)",
        "type": "value",
        "id": "cols"
      },
      {
        "name": "Rows (Z/Y)",
        "type": "value",
        "id": "rows"
      },
      {
        "name": "Hex Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Spacing Multiplier",
        "type": "value",
        "id": "spacing"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      },
      {
        "name": "X Values",
        "type": "list",
        "id": "xValues"
      },
      {
        "name": "Y Values",
        "type": "list",
        "id": "yValues"
      },
      {
        "name": "Z Values",
        "type": "list",
        "id": "zValues"
      }
    ]
  },
  {
    "id": "texture/sample",
    "name": "Sample Texture",
    "category": "textureTools",
    "summary": {
      "fr": "Sample Texture — Module nodal textureTools pour composition 3D et flux de signaux.",
      "en": "Sample Texture — textureTools node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Texture",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Geometry (Fallback)",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Plane",
        "type": "text",
        "id": "plane"
      },
      {
        "name": "UV Scale",
        "type": "vector",
        "id": "uvScale"
      },
      {
        "name": "UV Offset",
        "type": "vector",
        "id": "uvOffset"
      }
    ],
    "outputs": [
      {
        "name": "Values",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "physics/curl-noise-3d",
    "name": "Curl Noise 3D (Fluid Turbulence)",
    "category": "physics",
    "summary": {
      "fr": "Curl Noise 3D (Fluid Turbulence) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Curl Noise 3D (Fluid Turbulence) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Frequency",
        "type": "value",
        "id": "frequency"
      },
      {
        "name": "Amplitude",
        "type": "value",
        "id": "amplitude"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      }
    ],
    "outputs": [
      {
        "name": "Vector Texture 3D",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Force Field",
        "type": "any",
        "id": "field"
      }
    ]
  },
  {
    "id": "physics/mesh-fluid-emitter",
    "name": "Mesh Fluid Emitter (Fire & Smoke)",
    "category": "physics",
    "summary": {
      "fr": "Mesh Fluid Emitter (Fire & Smoke) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Mesh Fluid Emitter (Fire & Smoke) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Density Rate",
        "type": "value",
        "id": "density"
      },
      {
        "name": "Temperature",
        "type": "value",
        "id": "temperature"
      },
      {
        "name": "Movement Boost",
        "type": "value",
        "id": "motionBoost"
      },
      {
        "name": "Movement Wind Strength",
        "type": "value",
        "id": "windStrength"
      },
      {
        "name": "Normalize Emission",
        "type": "value",
        "id": "normalizeEmission"
      },
      {
        "name": "Radius",
        "type": "value",
        "id": "radius"
      }
    ],
    "outputs": [
      {
        "name": "Fluid Emitter",
        "type": "any",
        "id": "emitter"
      }
    ]
  },
  {
    "id": "physics/fluid-solver-3d",
    "name": "Fluid Solver 3D (Fire & Smoke)",
    "category": "physics",
    "summary": {
      "fr": "Fluid Solver 3D (Fire & Smoke) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Fluid Solver 3D (Fire & Smoke) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Emitter",
        "type": "any",
        "id": "emitter"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Box Size",
        "type": "vector",
        "id": "boxSize"
      },
      {
        "name": "Resolution",
        "type": "vector",
        "id": "resolution"
      },
      {
        "name": "Buoyancy",
        "type": "value",
        "id": "buoyancy"
      },
      {
        "name": "Cooling Rate",
        "type": "value",
        "id": "cooling"
      },
      {
        "name": "Dissipation",
        "type": "value",
        "id": "dissipation"
      },
      {
        "name": "Wind Vector",
        "type": "vector",
        "id": "wind"
      },
      {
        "name": "Pressure Iterations",
        "type": "value",
        "id": "jacobiSteps"
      },
      {
        "name": "Force Field 1",
        "type": "any",
        "id": "field0"
      }
    ],
    "outputs": [
      {
        "name": "Velocity Field",
        "type": "texture",
        "id": "velocityField"
      },
      {
        "name": "Dye Field (RGBA)",
        "type": "texture",
        "id": "dyeField"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "material/volume-3d",
    "name": "Volume Material 3D (Fire Raymarcher)",
    "category": "physics",
    "summary": {
      "fr": "Volume Material 3D (Fire Raymarcher) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Volume Material 3D (Fire Raymarcher) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Dye Field (3D Texture)",
        "type": "texture",
        "id": "dyeField"
      },
      {
        "name": "Velocity Field (3D Texture)",
        "type": "texture",
        "id": "velocityField"
      },
      {
        "name": "Key Light",
        "type": "geometry",
        "id": "keyLight"
      },
      {
        "name": "Key Light Position",
        "type": "vector",
        "id": "keyLightPos"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Box Size",
        "type": "vector",
        "id": "boxSize"
      },
      {
        "name": "Fire Intensity",
        "type": "value",
        "id": "fireIntensity"
      },
      {
        "name": "Shadow Absorption",
        "type": "value",
        "id": "shadowAbsorption"
      },
      {
        "name": "Powder Strength",
        "type": "value",
        "id": "powderStrength"
      },
      {
        "name": "Glow Spread",
        "type": "value",
        "id": "glowSpread"
      },
      {
        "name": "Fire Ramp Scale",
        "type": "value",
        "id": "rampScale"
      },
      {
        "name": "Raymarch Steps",
        "type": "value",
        "id": "steps"
      },
      {
        "name": "Exposure",
        "type": "value",
        "id": "exposure"
      },
      {
        "name": "Fire Start Color",
        "type": "color",
        "id": "startColor"
      },
      {
        "name": "Fire Mid Color",
        "type": "color",
        "id": "midColor"
      },
      {
        "name": "Fire End Color",
        "type": "color",
        "id": "endColor"
      }
    ],
    "outputs": [
      {
        "name": "Volume Mesh",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Material",
        "type": "material",
        "id": "material"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "simulation/fire-fluid-volume",
    "name": "Volumetric Fire Sim (Macro)",
    "category": "physics",
    "summary": {
      "fr": "Volumetric Fire Sim (Macro) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Volumetric Fire Sim (Macro) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Emitter Mesh",
        "type": "geometry",
        "id": "emitterMesh"
      },
      {
        "name": "Key Light",
        "type": "geometry",
        "id": "keyLight"
      },
      {
        "name": "Key Light Position",
        "type": "vector",
        "id": "keyLightPos"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Box Size",
        "type": "vector",
        "id": "boxSize"
      },
      {
        "name": "Resolution",
        "type": "vector",
        "id": "resolution"
      },
      {
        "name": "Simulate",
        "type": "value",
        "id": "simulate"
      },
      {
        "name": "Simulation Speed",
        "type": "value",
        "id": "simSpeed"
      },
      {
        "name": "Density Rate",
        "type": "value",
        "id": "density"
      },
      {
        "name": "Temperature Rate",
        "type": "value",
        "id": "temperature"
      },
      {
        "name": "Emitter Radius",
        "type": "value",
        "id": "emitterRadius"
      },
      {
        "name": "Movement Boost",
        "type": "value",
        "id": "motionBoost"
      },
      {
        "name": "Movement Wind Strength",
        "type": "value",
        "id": "windStrength"
      },
      {
        "name": "Normalize Emission",
        "type": "value",
        "id": "normalizeEmission"
      },
      {
        "name": "Buoyancy",
        "type": "value",
        "id": "buoyancy"
      },
      {
        "name": "Smoke Weight",
        "type": "value",
        "id": "smokeWeight"
      },
      {
        "name": "Velocity Damping",
        "type": "value",
        "id": "velocityDamping"
      },
      {
        "name": "Fire Lifespan",
        "type": "value",
        "id": "fireLifespan"
      },
      {
        "name": "Smoke Lifespan",
        "type": "value",
        "id": "smokeLifespan"
      },
      {
        "name": "Turbulence Strength",
        "type": "value",
        "id": "turbulence"
      },
      {
        "name": "Turbulence Decay",
        "type": "value",
        "id": "turbulenceDecay"
      },
      {
        "name": "Turbulence Frequency",
        "type": "value",
        "id": "turbFrequency"
      },
      {
        "name": "Cooling Rate (override)",
        "type": "value",
        "id": "cooling"
      },
      {
        "name": "Dissipation (override)",
        "type": "value",
        "id": "dissipation"
      },
      {
        "name": "Wind Vector",
        "type": "vector",
        "id": "wind"
      },
      {
        "name": "Fire Intensity",
        "type": "value",
        "id": "fireIntensity"
      },
      {
        "name": "Glow Spread",
        "type": "value",
        "id": "glowSpread"
      },
      {
        "name": "Fire Ramp Scale",
        "type": "value",
        "id": "rampScale"
      },
      {
        "name": "Fire Hue Shift",
        "type": "value",
        "id": "fireHue"
      },
      {
        "name": "Saturation",
        "type": "value",
        "id": "saturation"
      },
      {
        "name": "Fire Start Color",
        "type": "color",
        "id": "startColor"
      },
      {
        "name": "Fire Mid Color",
        "type": "color",
        "id": "midColor"
      },
      {
        "name": "Fire End Color",
        "type": "color",
        "id": "endColor"
      },
      {
        "name": "Phase Asymmetry (g)",
        "type": "value",
        "id": "asymmetry"
      },
      {
        "name": "Powder Effect",
        "type": "value",
        "id": "powderStrength"
      },
      {
        "name": "Multi Scattering",
        "type": "value",
        "id": "multiScattering"
      },
      {
        "name": "Shadow Absorption",
        "type": "value",
        "id": "shadowAbsorption"
      },
      {
        "name": "Shadow Ambient",
        "type": "value",
        "id": "shadowAmbient"
      },
      {
        "name": "Key Light Intensity",
        "type": "value",
        "id": "keyLightIntensity"
      },
      {
        "name": "Color Retention",
        "type": "value",
        "id": "colorRetention"
      },
      {
        "name": "Smoke Ambient",
        "type": "value",
        "id": "smokeAmbient"
      },
      {
        "name": "Raymarch Steps",
        "type": "value",
        "id": "steps"
      },
      {
        "name": "Substeps",
        "type": "value",
        "id": "substeps"
      },
      {
        "name": "Render Resolution",
        "type": "value",
        "id": "renderResolution"
      },
      {
        "name": "Denoise Strength",
        "type": "value",
        "id": "denoise"
      },
      {
        "name": "Exposure",
        "type": "value",
        "id": "exposure"
      },
      {
        "name": "Force Field 1",
        "type": "any",
        "id": "field0"
      }
    ],
    "outputs": [
      {
        "name": "Fire Mesh",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Velocity Field (3D)",
        "type": "texture",
        "id": "velocityField"
      },
      {
        "name": "Fire Light",
        "type": "geometry",
        "id": "light"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "physics/wind-field",
    "name": "Wind Field",
    "category": "physics",
    "summary": {
      "fr": "Wind Field — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Wind Field — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Direction (°)",
        "type": "value",
        "id": "angle"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Gust Scale",
        "type": "value",
        "id": "positionFrequency"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "timeFrequency"
      },
      {
        "name": "Gustiness",
        "type": "value",
        "id": "gustiness"
      },
      {
        "name": "Sample Position",
        "type": "vector",
        "id": "samplePosition"
      }
    ],
    "outputs": [
      {
        "name": "Wind Field",
        "type": "any",
        "id": "field"
      },
      {
        "name": "Wind (Vector)",
        "type": "vector",
        "id": "wind"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      }
    ]
  },
  {
    "id": "structure/grass-field",
    "name": "Grass Field",
    "category": "structure",
    "summary": {
      "fr": "Grass Field — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Grass Field — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Wind Field",
        "type": "any",
        "id": "wind"
      },
      {
        "name": "Ground",
        "type": "geometry",
        "id": "ground"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Center (Follow)",
        "type": "vector",
        "id": "center"
      },
      {
        "name": "Density Map",
        "type": "texture",
        "id": "densityMap"
      },
      {
        "name": "Trample Map",
        "type": "texture",
        "id": "trampleMap"
      },
      {
        "name": "Size",
        "type": "value",
        "id": "size"
      },
      {
        "name": "Blade Height",
        "type": "value",
        "id": "bladeHeight"
      },
      {
        "name": "Blade Width",
        "type": "value",
        "id": "bladeWidth"
      },
      {
        "name": "Wind Influence",
        "type": "value",
        "id": "windInfluence"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Blade Count",
        "type": "value",
        "id": "bladeCount"
      },
      {
        "name": "Ground Shadow",
        "type": "texture",
        "id": "groundShadow"
      }
    ]
  },
  {
    "id": "object/tree",
    "name": "Tree (Parametric)",
    "category": "object",
    "summary": {
      "fr": "Tree (Parametric) — Module nodal object pour composition 3D et flux de signaux.",
      "en": "Tree (Parametric) — object node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Wind Field",
        "type": "any",
        "id": "wind"
      },
      {
        "name": "Ground",
        "type": "geometry",
        "id": "ground"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Seed",
        "type": "value",
        "id": "seed"
      },
      {
        "name": "Size",
        "type": "value",
        "id": "sizeScale"
      },
      {
        "name": "Trunk Height",
        "type": "value",
        "id": "trunkHeight"
      },
      {
        "name": "Trunk Radius",
        "type": "value",
        "id": "trunkRadius"
      },
      {
        "name": "Levels",
        "type": "value",
        "id": "levels"
      },
      {
        "name": "Branches / Node",
        "type": "value",
        "id": "childCount"
      },
      {
        "name": "Branch Angle (°)",
        "type": "value",
        "id": "branchAngle"
      },
      {
        "name": "Curvature (°)",
        "type": "value",
        "id": "curvature"
      },
      {
        "name": "Droop (°)",
        "type": "value",
        "id": "droop"
      },
      {
        "name": "Length Falloff",
        "type": "value",
        "id": "lengthFalloff"
      },
      {
        "name": "Radius Falloff",
        "type": "value",
        "id": "radiusFalloff"
      },
      {
        "name": "Leaves / Branch",
        "type": "value",
        "id": "leavesPerBranch"
      },
      {
        "name": "Leaf Size",
        "type": "value",
        "id": "leafSize"
      },
      {
        "name": "Leaf Width",
        "type": "value",
        "id": "leafAspect"
      },
      {
        "name": "Leaf Droop",
        "type": "value",
        "id": "leafDroop"
      },
      {
        "name": "Clumps / Branch",
        "type": "value",
        "id": "clumpsPerBranch"
      },
      {
        "name": "Clump Radius",
        "type": "value",
        "id": "clumpRadius"
      },
      {
        "name": "Season (0 = summer, 1 = late autumn)",
        "type": "value",
        "id": "season"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Branch Tips",
        "type": "list",
        "id": "tips"
      },
      {
        "name": "Branch Count",
        "type": "value",
        "id": "branchCount"
      }
    ]
  },
  {
    "id": "geometry/wind-sway",
    "name": "Wind Sway",
    "category": "structure",
    "summary": {
      "fr": "Wind Sway — Module nodal structure pour composition 3D et flux de signaux.",
      "en": "Wind Sway — structure node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Wind Field",
        "type": "any",
        "id": "wind"
      },
      {
        "name": "Influence",
        "type": "value",
        "id": "influence"
      },
      {
        "name": "Anchor Y",
        "type": "value",
        "id": "anchorY"
      },
      {
        "name": "Height",
        "type": "value",
        "id": "height"
      },
      {
        "name": "Stiffness",
        "type": "value",
        "id": "stiffness"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "texture/interaction-map",
    "name": "Interaction Map",
    "category": "texture",
    "summary": {
      "fr": "Interaction Map — Module nodal texture pour composition 3D et flux de signaux.",
      "en": "Interaction Map — texture node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Source (Object)",
        "type": "geometry",
        "id": "source"
      },
      {
        "name": "Positions",
        "type": "list",
        "id": "positions"
      },
      {
        "name": "Center (Follow)",
        "type": "vector",
        "id": "center"
      },
      {
        "name": "Size",
        "type": "value",
        "id": "size"
      },
      {
        "name": "Brush Radius",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "strength"
      },
      {
        "name": "Recovery (s)",
        "type": "value",
        "id": "recovery"
      }
    ],
    "outputs": [
      {
        "name": "Map",
        "type": "texture",
        "id": "texture"
      },
      {
        "name": "Center",
        "type": "vector",
        "id": "center"
      },
      {
        "name": "Size",
        "type": "value",
        "id": "size"
      },
      {
        "name": "Painted Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "io/gamepad",
    "name": "Gamepad",
    "category": "io",
    "summary": {
      "fr": "Gamepad — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Gamepad — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Player Index",
        "type": "value",
        "id": "index"
      },
      {
        "name": "Deadzone",
        "type": "value",
        "id": "deadzone"
      }
    ],
    "outputs": [
      {
        "name": "Connected",
        "type": "value",
        "id": "connected"
      },
      {
        "name": "Left Stick (XZ)",
        "type": "vector",
        "id": "leftStick"
      },
      {
        "name": "Right Stick (XZ)",
        "type": "vector",
        "id": "rightStick"
      },
      {
        "name": "Left X",
        "type": "value",
        "id": "leftX"
      },
      {
        "name": "Left Y",
        "type": "value",
        "id": "leftY"
      },
      {
        "name": "Right X",
        "type": "value",
        "id": "rightX"
      },
      {
        "name": "Right Y",
        "type": "value",
        "id": "rightY"
      },
      {
        "name": "Left Trigger",
        "type": "value",
        "id": "leftTrigger"
      },
      {
        "name": "Right Trigger",
        "type": "value",
        "id": "rightTrigger"
      },
      {
        "name": "D-Pad (XZ)",
        "type": "vector",
        "id": "dpad"
      },
      {
        "name": "A / Cross",
        "type": "value",
        "id": "a"
      },
      {
        "name": "B / Circle",
        "type": "value",
        "id": "b"
      },
      {
        "name": "X / Square",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Y / Triangle",
        "type": "value",
        "id": "y"
      },
      {
        "name": "Left Bumper",
        "type": "value",
        "id": "leftBumper"
      },
      {
        "name": "Right Bumper",
        "type": "value",
        "id": "rightBumper"
      },
      {
        "name": "Start",
        "type": "value",
        "id": "start"
      },
      {
        "name": "Any Button",
        "type": "value",
        "id": "anyButton"
      },
      {
        "name": "All Buttons",
        "type": "list",
        "id": "buttons"
      }
    ]
  },
  {
    "id": "io/action-map",
    "name": "Action Map",
    "category": "io",
    "summary": {
      "fr": "Action Map — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Action Map — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Positive 1",
        "type": "value",
        "id": "pos0"
      },
      {
        "name": "Negative 1",
        "type": "value",
        "id": "neg0"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      },
      {
        "name": "Active",
        "type": "value",
        "id": "active"
      },
      {
        "name": "Pressed",
        "type": "value",
        "id": "pressed"
      },
      {
        "name": "Released",
        "type": "value",
        "id": "released"
      }
    ]
  },
  {
    "id": "io/move-input",
    "name": "Move Input",
    "category": "io",
    "summary": {
      "fr": "Move Input — Module nodal io pour composition 3D et flux de signaux.",
      "en": "Move Input — io node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Speed Multiplier",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Enabled",
        "type": "value",
        "id": "enabled"
      }
    ],
    "outputs": [
      {
        "name": "Move (XZ)",
        "type": "vector",
        "id": "move"
      },
      {
        "name": "X (right)",
        "type": "value",
        "id": "x"
      },
      {
        "name": "Z (forward = -1)",
        "type": "value",
        "id": "z"
      },
      {
        "name": "Forward (+1 = forward)",
        "type": "value",
        "id": "forward"
      },
      {
        "name": "Magnitude",
        "type": "value",
        "id": "magnitude"
      },
      {
        "name": "Jump",
        "type": "value",
        "id": "jump"
      },
      {
        "name": "Jump Pressed",
        "type": "value",
        "id": "jumpPressed"
      },
      {
        "name": "Sprint",
        "type": "value",
        "id": "sprint"
      }
    ]
  },
  {
    "id": "math/integrate",
    "name": "Integrate",
    "category": "math",
    "summary": {
      "fr": "Integrate — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Integrate — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Rate (per second)",
        "type": "value",
        "id": "rate"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Damping",
        "type": "value",
        "id": "damping"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "value",
        "id": "value"
      }
    ]
  },
  {
    "id": "vector/integrate",
    "name": "Integrate Vector",
    "category": "math",
    "summary": {
      "fr": "Integrate Vector — Module nodal math pour composition 3D et flux de signaux.",
      "en": "Integrate Vector — math node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Rate (per second)",
        "type": "vector",
        "id": "rate"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Damping",
        "type": "value",
        "id": "damping"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      }
    ],
    "outputs": [
      {
        "name": "Value",
        "type": "vector",
        "id": "value"
      },
      {
        "name": "Length",
        "type": "value",
        "id": "length"
      }
    ]
  },
  {
    "id": "physics/capsule-controller",
    "name": "Capsule Controller",
    "category": "physics",
    "summary": {
      "fr": "Capsule Controller — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Capsule Controller — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Collider",
        "type": "geometry",
        "id": "collider"
      },
      {
        "name": "Move (XZ)",
        "type": "vector",
        "id": "move"
      },
      {
        "name": "Jump",
        "type": "value",
        "id": "jump"
      },
      {
        "name": "Walk Speed",
        "type": "value",
        "id": "walkSpeed"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      }
    ],
    "outputs": [
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Grounded",
        "type": "value",
        "id": "grounded"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Ground Normal",
        "type": "vector",
        "id": "groundNormal"
      }
    ]
  },
  {
    "id": "physics/cloth",
    "name": "Cloth",
    "category": "physics",
    "summary": {
      "fr": "Cloth — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Cloth — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Visible",
        "type": "value",
        "id": "visible"
      },
      {
        "name": "Gravity",
        "type": "vector",
        "id": "gravity"
      },
      {
        "name": "Wind",
        "type": "vector",
        "id": "wind"
      },
      {
        "name": "Stiffness",
        "type": "value",
        "id": "stiffness"
      },
      {
        "name": "Damping",
        "type": "value",
        "id": "damping"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      },
      {
        "name": "Pin 1",
        "type": "geometry",
        "id": "pin0"
      },
      {
        "name": "Collider 1",
        "type": "geometry",
        "id": "collider0"
      },
      {
        "name": "Force Field 1",
        "type": "any",
        "id": "field0"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "physics/world",
    "name": "Physics World",
    "category": "physics",
    "summary": {
      "fr": "Physics World — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Physics World — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Gravity",
        "type": "vector",
        "id": "gravity"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Paused",
        "type": "value",
        "id": "paused"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      }
    ],
    "outputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Ready",
        "type": "value",
        "id": "ready"
      },
      {
        "name": "Body Count",
        "type": "value",
        "id": "bodies"
      },
      {
        "name": "Steps This Frame",
        "type": "value",
        "id": "steps"
      }
    ]
  },
  {
    "id": "physics/rigid-body",
    "name": "Rigid Body",
    "category": "physics",
    "summary": {
      "fr": "Corps rigide Rapier 3D : le mode per-child simule automatiquement des centaines d'instances avec un seul node.",
      "en": "Rapier 3D rigid body: per-child mode automatically simulates hundreds of instances with a single node."
    },
    "inputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Force",
        "type": "vector",
        "id": "force"
      },
      {
        "name": "Kinematic Target",
        "type": "vector",
        "id": "target"
      },
      {
        "name": "Mass",
        "type": "value",
        "id": "mass"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Body Count",
        "type": "value",
        "id": "count"
      }
    ]
  },
  {
    "id": "physics/character",
    "name": "Character (Physics)",
    "category": "physics",
    "summary": {
      "fr": "Character (Physics) — Module nodal physics pour composition 3D et flux de signaux.",
      "en": "Character (Physics) — physics node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Move (XZ)",
        "type": "vector",
        "id": "move"
      },
      {
        "name": "Jump",
        "type": "value",
        "id": "jump"
      },
      {
        "name": "Walk Speed",
        "type": "value",
        "id": "walkSpeed"
      },
      {
        "name": "Time",
        "type": "value",
        "id": "time"
      },
      {
        "name": "Reset",
        "type": "value",
        "id": "reset"
      }
    ],
    "outputs": [
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Grounded",
        "type": "value",
        "id": "grounded"
      },
      {
        "name": "Velocity",
        "type": "vector",
        "id": "velocity"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      }
    ]
  },
  {
    "id": "physics/vehicle",
    "name": "Vehicle",
    "category": "physics",
    "summary": {
      "fr": "Voiture à 4 roues sur solveur raycast Rapier avec suspensions physiques, braquage et centre de gravité réglable.",
      "en": "4-wheel raycast vehicle with physical suspension, steering, and adjustable center of mass."
    },
    "inputs": [
      {
        "name": "World",
        "type": "any",
        "id": "world"
      },
      {
        "name": "Chassis",
        "type": "geometry",
        "id": "chassis"
      },
      {
        "name": "Throttle (-1…1)",
        "type": "value",
        "id": "throttle"
      },
      {
        "name": "Steer (-1 left … 1 right)",
        "type": "value",
        "id": "steer"
      },
      {
        "name": "Brake (0…1)",
        "type": "value",
        "id": "brake"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Position",
        "type": "vector",
        "id": "position"
      },
      {
        "name": "Wheel Matrices",
        "type": "list",
        "id": "wheels"
      },
      {
        "name": "Speed",
        "type": "value",
        "id": "speed"
      },
      {
        "name": "Wheels on Ground",
        "type": "value",
        "id": "grounded"
      }
    ]
  },
  {
    "id": "modifier/duotone",
    "name": "Dual Tone",
    "category": "transform",
    "summary": {
      "fr": "Dual Tone — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Dual Tone — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Shadow Color",
        "type": "color",
        "id": "shadowColor"
      },
      {
        "name": "Highlight Color",
        "type": "color",
        "id": "highlightColor"
      },
      {
        "name": "Balance",
        "type": "value",
        "id": "balance"
      },
      {
        "name": "Softness",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/halftone",
    "name": "Halftone",
    "category": "transform",
    "summary": {
      "fr": "Halftone — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Halftone — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Dot Radius (px)",
        "type": "value",
        "id": "radius"
      },
      {
        "name": "Screen Angle (°)",
        "type": "value",
        "id": "screenAngle"
      },
      {
        "name": "Scatter",
        "type": "value",
        "id": "scatter"
      },
      {
        "name": "Amount",
        "type": "value",
        "id": "amount"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/film-texture",
    "name": "Film Texture",
    "category": "transform",
    "summary": {
      "fr": "Film Texture — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Film Texture — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Grain",
        "type": "value",
        "id": "grain"
      },
      {
        "name": "Dust",
        "type": "value",
        "id": "dust"
      },
      {
        "name": "Scratches",
        "type": "value",
        "id": "scratches"
      },
      {
        "name": "Blotches",
        "type": "value",
        "id": "blotches"
      },
      {
        "name": "Rate (fps)",
        "type": "value",
        "id": "rate"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/dry-brush",
    "name": "Dry Brush",
    "category": "transform",
    "summary": {
      "fr": "Dry Brush — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Dry Brush — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Coverage",
        "type": "value",
        "id": "coverage"
      },
      {
        "name": "Speck Size",
        "type": "value",
        "id": "speckSize"
      },
      {
        "name": "Softness",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Stroke Length",
        "type": "value",
        "id": "stretch"
      },
      {
        "name": "Stroke Angle (°)",
        "type": "value",
        "id": "strokeAngle"
      },
      {
        "name": "Paper Color",
        "type": "color",
        "id": "paperColor"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/super8",
    "name": "Super 8 Projector",
    "category": "transform",
    "summary": {
      "fr": "Super 8 Projector — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Super 8 Projector — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Softness (px)",
        "type": "value",
        "id": "softness"
      },
      {
        "name": "Flicker",
        "type": "value",
        "id": "flicker"
      },
      {
        "name": "Gate Weave",
        "type": "value",
        "id": "weave"
      },
      {
        "name": "Warmth",
        "type": "value",
        "id": "warmth"
      },
      {
        "name": "Rate (fps)",
        "type": "value",
        "id": "rate"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "modifier/outline",
    "name": "Outline",
    "category": "transform",
    "summary": {
      "fr": "Outline — Module nodal transform pour composition 3D et flux de signaux.",
      "en": "Outline — transform node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      },
      {
        "name": "Color",
        "type": "color",
        "id": "edgeColor"
      },
      {
        "name": "Thickness",
        "type": "value",
        "id": "edgeThickness"
      },
      {
        "name": "Sharpness",
        "type": "value",
        "id": "sharpness"
      },
      {
        "name": "Side",
        "type": "value",
        "id": "outlineSide"
      },
      {
        "name": "Strength",
        "type": "value",
        "id": "edgeStrength"
      },
      {
        "name": "Alpha Threshold",
        "type": "value",
        "id": "alphaThreshold"
      },
      {
        "name": "Silhouette 3D",
        "type": "value",
        "id": "silhouette"
      },
      {
        "name": "Alpha Cutout",
        "type": "value",
        "id": "alphaEdge"
      }
    ],
    "outputs": [
      {
        "name": "Geometry",
        "type": "geometry",
        "id": "geometry"
      },
      {
        "name": "Matrix",
        "type": "matrix",
        "id": "matrix"
      }
    ]
  },
  {
    "id": "list/distance-gradient",
    "name": "Distance Gradient List",
    "category": "list",
    "summary": {
      "fr": "Distance Gradient List — Module nodal list pour composition 3D et flux de signaux.",
      "en": "Distance Gradient List — list node module for real-time 3D composition and signal flow."
    },
    "inputs": [
      {
        "name": "Values",
        "type": "list",
        "id": "values"
      },
      {
        "name": "Radius / Max",
        "type": "value",
        "id": "radius"
      }
    ],
    "outputs": [
      {
        "name": "Colors",
        "type": "list",
        "id": "list"
      }
    ]
  }
];

/**
 * TSUJI (辻) — Background 3D Scene (Full Three.js)
 * Low-key Japanese Geek / Akihabara Hardware / Modular Patchbay
 * Colors: Electric Cyan (#00f0ff), Cyber Pink (#ff007f), Terminal Green (#00ff66), White (#ffffff)
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js';

export class TsujiBackgroundScene {
  constructor(canvasId = 'three-bg-canvas') {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;

    this.currentMode = '01_NODAL_BUS';
    this.mouse = new THREE.Vector2(0, 0);
    this.targetMouse = new THREE.Vector2(0, 0);
    this.scrollY = 0;
    this.targetScrollY = 0;
    this.clock = new THREE.Clock();

    this.initScene();
    this.createGrid();
    this.createPatchNetwork();
    this.createParticleBus();
    this.createDltWarpMode();
    this.createOrganicBranchMode();
    this.createPhysicsBounceMode();

    this.setupEventListeners();
    this.setMode('01_NODAL_BUS');
    this.animate();
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x10141d, 0.016);

    // Caméra avec faible FOV pour un rendu très précis, presque orthographique "Feels 2D"
    this.camera = new THREE.PerspectiveCamera(
      32,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    this.camera.position.set(0, 0, 16);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance"
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Groupes pour les différents modes
    this.modeGroupNodal = new THREE.Group();
    this.modeGroupDlt = new THREE.Group();
    this.modeGroupGrowth = new THREE.Group();
    this.modeGroupPhysics = new THREE.Group();

    this.scene.add(this.modeGroupNodal);
    this.scene.add(this.modeGroupDlt);
    this.scene.add(this.modeGroupGrowth);
    this.scene.add(this.modeGroupPhysics);

    // FPS Meter
    this.fpsCounter = document.getElementById('fps-value');
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
  }

  // 1. Grille de circuits d'ingénierie sombre avec repères
  createGrid() {
    const size = 30;
    const divisions = 30;
    const gridHelper = new THREE.GridHelper(size, divisions, 0x2c384e, 0x18202d);
    gridHelper.rotation.x = Math.PI / 2.3;
    gridHelper.position.set(0, -2, -4);
    this.scene.add(gridHelper);
    this.grid = gridHelper;
  }

  // 2. Mode 01: Réseau de patchbay modulaire, câbles de signaux et impulsions électriques
  createPatchNetwork() {
    this.cables = [];
    this.pulses = [];

    // Modules électroniques / boîtiers de nœuds
    const moduleGeometry = new THREE.BoxGeometry(1.6, 0.9, 0.1);
    const moduleEdges = new THREE.EdgesGeometry(moduleGeometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x223046 });

    const nodePositions = [
      new THREE.Vector3(-4.5, 2.2, 0),
      new THREE.Vector3(-1.8, 3.0, 0.5),
      new THREE.Vector3(2.5, 2.0, -0.2),
      new THREE.Vector3(-3.0, -1.2, 0.8),
      new THREE.Vector3(1.2, -0.8, 0.2),
      new THREE.Vector3(4.8, -1.8, 0.4),
      new THREE.Vector3(-0.5, -3.2, 0.1),
      new THREE.Vector3(3.8, 2.8, 0.6)
    ];

    nodePositions.forEach((pos) => {
      const boxWire = new THREE.LineSegments(moduleEdges, lineMaterial);
      boxWire.position.copy(pos);
      this.modeGroupNodal.add(boxWire);

      // Micro-jack de connexion lumineux
      const jackGeo = new THREE.CircleGeometry(0.06, 8);
      const jackMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
      const jack = new THREE.Mesh(jackGeo, jackMat);
      jack.position.set(pos.x + 0.65, pos.y, pos.z + 0.06);
      this.modeGroupNodal.add(jack);
    });

    // Paires de connexions de câbles
    const connections = [
      { from: 0, to: 1, color: 0x00f0ff },
      { from: 1, to: 2, color: 0xff007f },
      { from: 0, to: 3, color: 0x00ff66 },
      { from: 3, to: 4, color: 0x00f0ff },
      { from: 4, to: 5, color: 0xff007f },
      { from: 2, to: 7, color: 0x00ff66 },
      { from: 4, to: 6, color: 0x00f0ff }
    ];

    connections.forEach((conn) => {
      const p1 = nodePositions[conn.from];
      const p2 = nodePositions[conn.to];

      // Courbe de Bézier 3D avec fléchissement naturel de câble
      const mid1 = new THREE.Vector3(
        p1.x + (p2.x - p1.x) * 0.4,
        p1.y - 0.9,
        (p1.z + p2.z) * 0.5 + 0.5
      );
      const mid2 = new THREE.Vector3(
        p1.x + (p2.x - p1.x) * 0.7,
        p2.y - 0.7,
        (p1.z + p2.z) * 0.5 + 0.3
      );

      const curve = new THREE.CubicBezierCurve3(p1, mid1, mid2, p2);
      const points = curve.getPoints(40);
      const cableGeo = new THREE.BufferGeometry().setFromPoints(points);
      const cableMat = new THREE.LineBasicMaterial({
        color: conn.color,
        transparent: true,
        opacity: 0.35
      });
      const cableLine = new THREE.Line(cableGeo, cableMat);
      this.modeGroupNodal.add(cableLine);

      // Impulsion électrique / paquet de données circulant sur le câble
      const pulseGeo = new THREE.BufferGeometry();
      const pulsePos = new Float32Array(3);
      pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
      const pulseMat = new THREE.PointsMaterial({
        color: conn.color,
        size: 0.16,
        transparent: true,
        blending: THREE.AdditiveBlending
      });
      const pulseMesh = new THREE.Points(pulseGeo, pulseMat);
      this.modeGroupNodal.add(pulseMesh);

      this.pulses.push({
        mesh: pulseMesh,
        curve: curve,
        speed: 0.25 + Math.random() * 0.35,
        progress: Math.random()
      });
    });
  }

  // 3. Nuage de particules de bus de données (réactif au curseur)
  createParticleBus() {
    this.particleCount = 180;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.particleCount * 3);
    const basePositions = new Float32Array(this.particleCount * 3);
    const colors = new Float32Array(this.particleCount * 3);

    const palette = [
      new THREE.Color(0x00f0ff), // Cyan
      new THREE.Color(0xff007f), // Pink
      new THREE.Color(0x00ff66), // Green
      new THREE.Color(0xffffff)  // White
    ];

    for (let i = 0; i < this.particleCount; i++) {
      const x = (Math.random() - 0.5) * 16;
      const y = (Math.random() - 0.5) * 10;
      const z = (Math.random() - 0.5) * 4;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      basePositions[i * 3] = x;
      basePositions[i * 3 + 1] = y;
      basePositions[i * 3 + 2] = z;

      const c = palette[i % palette.length];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });

    this.particleSystem = new THREE.Points(geometry, material);
    this.scene.add(this.particleSystem);
    this.particleBasePos = basePositions;
  }

  // 4. Mode 02: DLT Warp / Faisceau de vidéoprojection & coin de mapping
  createDltWarpMode() {
    // Projecteur source
    const projectorPos = new THREE.Vector3(-4, 3, 2);

    // Écran 3D calé en perspective (4 coins modulables)
    this.dltCorners = [
      new THREE.Vector3(0.5, 2.2, 0),
      new THREE.Vector3(4.2, 2.5, -0.5),
      new THREE.Vector3(4.0, -1.8, 0.2),
      new THREE.Vector3(0.2, -1.2, 0.8)
    ];

    // Faisceaux laser du projecteur vers chaque coin
    this.dltBeamLines = [];
    const beamMat = new THREE.LineBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.45
    });

    this.dltCorners.forEach((corner) => {
      const geo = new THREE.BufferGeometry().setFromPoints([projectorPos, corner]);
      const line = new THREE.Line(geo, beamMat);
      this.modeGroupDlt.add(line);
      this.dltBeamLines.push(line);
    });

    // Surface projetée en quad filaire
    const quadPoints = [
      this.dltCorners[0], this.dltCorners[1],
      this.dltCorners[1], this.dltCorners[2],
      this.dltCorners[2], this.dltCorners[3],
      this.dltCorners[3], this.dltCorners[0],
      this.dltCorners[0], this.dltCorners[2] // Diagonale de calage
    ];
    const quadGeo = new THREE.BufferGeometry().setFromPoints(quadPoints);
    const quadMat = new THREE.LineBasicMaterial({ color: 0xff007f });
    this.dltQuad = new THREE.LineSegments(quadGeo, quadMat);
    this.modeGroupDlt.add(this.dltQuad);
  }

  // 5. Mode 03: Arbre géométrique / Végétation paramétrique ployant sous le vent
  createOrganicBranchMode() {
    this.treeBranches = new THREE.Group();
    const branchMat = new THREE.LineBasicMaterial({ color: 0x00ff66 });

    // Générateur d'arbre fractal vectoriel simplifié
    const generateBranches = (origin, dir, length, depth) => {
      if (depth <= 0) return;
      const end = origin.clone().add(dir.clone().multiplyScalar(length));
      const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
      const branch = new THREE.Line(geo, branchMat);
      this.treeBranches.add(branch);

      const angle = 0.42;
      const dirLeft = dir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), angle);
      const dirRight = dir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -angle);
      const dirFront = dir.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), angle * 0.7);

      generateBranches(end, dirLeft, length * 0.72, depth - 1);
      generateBranches(end, dirRight, length * 0.72, depth - 1);
      generateBranches(end, dirFront, length * 0.72, depth - 1);
    };

    generateBranches(new THREE.Vector3(0, -3.2, 0), new THREE.Vector3(0, 1, 0), 2.2, 4);
    this.modeGroupGrowth.add(this.treeBranches);
  }

  // 6. Mode 04: Corps physiques Rapier simulés (cubes & sphères rebondissants)
  createPhysicsBounceMode() {
    this.physicsBodies = [];
    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.8, 0.8, 0.8));
    const sphereEdges = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.5, 1));

    const materials = [
      new THREE.LineBasicMaterial({ color: 0x00f0ff }),
      new THREE.LineBasicMaterial({ color: 0xff007f }),
      new THREE.LineBasicMaterial({ color: 0x00ff66 }),
      new THREE.LineBasicMaterial({ color: 0xffffff })
    ];

    for (let i = 0; i < 18; i++) {
      const isBox = i % 2 === 0;
      const mesh = new THREE.LineSegments(isBox ? boxEdges : sphereEdges, materials[i % materials.length]);
      mesh.position.set(
        (Math.random() - 0.5) * 8,
        2 + Math.random() * 5,
        (Math.random() - 0.5) * 2
      );

      this.modeGroupPhysics.add(mesh);
      this.physicsBodies.push({
        mesh: mesh,
        vy: 0,
        vx: (Math.random() - 0.5) * 0.02,
        rotSpeed: (Math.random() - 0.5) * 0.05,
        floorY: -2.8 + Math.random() * 0.4
      });
    }
  }

  setMode(modeKey) {
    this.currentMode = modeKey;

    this.modeGroupNodal.visible = (modeKey === '01_NODAL_BUS');
    this.modeGroupDlt.visible = (modeKey === '02_DLT_WARP');
    this.modeGroupGrowth.visible = (modeKey === '03_ORGANIC_GROWTH');
    this.modeGroupPhysics.visible = (modeKey === '04_RAPIER_PHYSICS');

    // Mise à jour de l'UI des boutons
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      if (btn.dataset.mode === modeKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  setupEventListeners() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('mousemove', (e) => {
      this.targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('scroll', () => {
      this.targetScrollY = window.scrollY;
    });

    // Boutons de changement de mode
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.dataset.mode;
        if (mode) this.setMode(mode);
      });
    });

    // Impulsion physique au clic sur le canvas
    window.addEventListener('click', (e) => {
      if (this.currentMode === '04_RAPIER_PHYSICS') {
        this.physicsBodies.forEach((body) => {
          body.vy = 0.12 + Math.random() * 0.08;
          body.vx = (Math.random() - 0.5) * 0.06;
        });
      }
    });
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();
    const elapsedTime = this.clock.getElapsedTime();

    // Lissage de la souris et du scroll (Inertie fluide)
    this.mouse.x += (this.targetMouse.x - this.mouse.x) * 0.06;
    this.mouse.y += (this.targetMouse.y - this.mouse.y) * 0.06;
    this.scrollY += (this.targetScrollY - this.scrollY) * 0.06;

    // Parallaxe caméra subtil "Feels 2D"
    this.camera.position.x = this.mouse.x * 0.7;
    this.camera.position.y = this.mouse.y * 0.5 - (this.scrollY * 0.003);
    this.camera.lookAt(0, -this.scrollY * 0.003, 0);

    // Rotation lente de la grille
    if (this.grid) {
      this.grid.position.x = -this.mouse.x * 0.3;
    }

    // 1. Animation des impulsions sur les câbles (Mode 01)
    if (this.modeGroupNodal.visible) {
      this.pulses.forEach((p) => {
        p.progress = (p.progress + delta * p.speed) % 1.0;
        const pt = p.curve.getPoint(p.progress);
        const posAttr = p.mesh.geometry.attributes.position;
        posAttr.setXYZ(0, pt.x, pt.y, pt.z);
        posAttr.needsUpdate = true;
      });
    }

    // 2. Animation des particules avec répulsion curseur
    const positions = this.particleSystem.geometry.attributes.position.array;
    const base = this.particleBasePos;
    const mouseWorldX = this.mouse.x * 8;
    const mouseWorldY = this.mouse.y * 5;

    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 3;
      let px = base[idx];
      let py = base[idx + 1] + Math.sin(elapsedTime * 1.5 + i) * 0.15;
      let pz = base[idx + 2];

      const dx = px - mouseWorldX;
      const dy = py - mouseWorldY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 2.5) {
        const force = (2.5 - dist) * 0.45;
        px += (dx / dist) * force;
        py += (dy / dist) * force;
      }

      positions[idx] = px;
      positions[idx + 1] = py;
      positions[idx + 2] = pz;
    }
    this.particleSystem.geometry.attributes.position.needsUpdate = true;

    // 3. Animation DLT Warp (Mode 02)
    if (this.modeGroupDlt.visible) {
      const wave = Math.sin(elapsedTime * 2) * 0.3;
      this.dltCorners[1].y = 2.5 + wave;
      this.dltCorners[2].x = 4.0 - wave * 0.5;

      const pProjector = new THREE.Vector3(-4, 3, 2);
      this.dltBeamLines.forEach((line, idx) => {
        line.geometry.setFromPoints([pProjector, this.dltCorners[idx]]);
      });
    }

    // 4. Animation du vent sur les branches (Mode 03)
    if (this.modeGroupGrowth.visible) {
      this.treeBranches.rotation.z = Math.sin(elapsedTime * 1.8) * 0.08 + this.mouse.x * 0.1;
      this.treeBranches.rotation.y = elapsedTime * 0.2;
    }

    // 5. Simulation physique basique (Mode 04)
    if (this.modeGroupPhysics.visible) {
      const gravity = -0.005;
      this.physicsBodies.forEach((body) => {
        body.vy += gravity;
        body.mesh.position.y += body.vy;
        body.mesh.position.x += body.vx;
        body.mesh.rotation.x += body.rotSpeed;
        body.mesh.rotation.y += body.rotSpeed * 0.8;

        if (body.mesh.position.y <= body.floorY) {
          body.mesh.position.y = body.floorY;
          body.vy = -body.vy * 0.72; // Rebond avec amortissement
        }
      });
    }

    // 6. Calcul du framerate télémétrique réel 60 FPS
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      if (this.fpsCounter) {
        this.fpsCounter.textContent = `${fps}.00`;
      }
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * TSUJI (辻) — DLT Simulator Interactive Three.js Scene
 * Direct Linear Transformation & Spatial Calibration for Video-Mapping
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js';

export class TsujiDltSimulator {
  constructor(canvasId = 'dlt-canvas') {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;

    this.initScene();
    this.createTargetGeometry();
    this.createProjectorFrustum();
    this.setupInteractivity();
    this.animate();
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0f16);

    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width || 600;
    this.height = rect.height || 420;

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 50);
    this.camera.position.set(4, 3, 6);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true
    });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.isDragging = false;
    this.prevMouse = { x: 0, y: 0 };
    this.rotation = { x: 0.3, y: 0.6 };
  }

  createTargetGeometry() {
    // Volume architectural physique (Coin de pièce / Cube filaire stylisé)
    const boxGeo = new THREE.BoxGeometry(2.4, 2.4, 2.4);
    const boxEdges = new THREE.EdgesGeometry(boxGeo);
    const boxMat = new THREE.LineBasicMaterial({ color: 0x223046 });
    this.roomBox = new THREE.LineSegments(boxEdges, boxMat);
    this.scene.add(this.roomBox);

    // 4 Coins clés de calage (Repères physiques dans l'espace 3D)
    this.anchorPoints = [
      new THREE.Vector3(-1.2, 1.2, 1.2),
      new THREE.Vector3(1.2, 1.2, 1.2),
      new THREE.Vector3(1.2, -1.2, 1.2),
      new THREE.Vector3(-1.2, -1.2, 1.2)
    ];

    // Marqueurs de calibration lumineux
    const markerGeo = new THREE.SphereGeometry(0.06, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x00ff66 });

    this.anchorPoints.forEach((pt) => {
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.copy(pt);
      this.roomBox.add(marker);
    });
  }

  createProjectorFrustum() {
    // Projecteur virtuel
    this.projectorPos = new THREE.Vector3(2.5, 2.2, 4.0);

    // Faisceaux pyramidaux
    const beamLinesGeo = new THREE.BufferGeometry();
    const beamPoints = [];

    this.anchorPoints.forEach((pt) => {
      beamPoints.push(this.projectorPos.clone());
      beamPoints.push(pt.clone());
    });

    beamLinesGeo.setFromPoints(beamPoints);
    this.beamMaterial = new THREE.LineBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.6
    });
    this.beamMesh = new THREE.LineSegments(beamLinesGeo, this.beamMaterial);
    this.scene.add(this.beamMesh);

    // Quad projeté sur la façade (Rose synth)
    const quadPoints = [
      this.anchorPoints[0], this.anchorPoints[1],
      this.anchorPoints[1], this.anchorPoints[2],
      this.anchorPoints[2], this.anchorPoints[3],
      this.anchorPoints[3], this.anchorPoints[0]
    ];
    const quadGeo = new THREE.BufferGeometry().setFromPoints(quadPoints);
    const quadMat = new THREE.LineBasicMaterial({ color: 0xff007f, linewidth: 2 });
    this.projectedQuad = new THREE.LineSegments(quadGeo, quadMat);
    this.roomBox.add(this.projectedQuad);
  }

  setupInteractivity() {
    // Rotation Orbit manuelle par glisser-déposer sur le canvas
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.prevMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.prevMouse.x;
      const dy = e.clientY - this.prevMouse.y;

      this.rotation.y += dx * 0.008;
      this.rotation.x += dy * 0.008;
      this.rotation.x = Math.max(-1.2, Math.min(1.2, this.rotation.x));

      this.prevMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Resize
    window.addEventListener('resize', () => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.camera.aspect = rect.width / rect.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(rect.width, rect.height);
    });

    // Bouton de perturbation / recalcul DLT
    const recomputeBtn = document.getElementById('btn-recompute-dlt');
    if (recomputeBtn) {
      recomputeBtn.addEventListener('click', () => {
        this.projectorPos.x = 2.0 + (Math.random() - 0.5) * 1.5;
        this.projectorPos.y = 1.8 + (Math.random() - 0.5) * 1.0;
        this.updateDltTelemetry();
      });
    }
  }

  updateDltTelemetry() {
    const errorElem = document.getElementById('dlt-rms-error');
    const focalElem = document.getElementById('dlt-focal-len');
    const shiftElem = document.getElementById('dlt-lens-shift');

    if (errorElem) {
      const rms = (0.24 + Math.random() * 0.08).toFixed(2);
      errorElem.textContent = `${rms} px`;
    }
    if (focalElem) {
      const focal = (35.2 + (this.projectorPos.z - 4.0) * 5.0).toFixed(1);
      focalElem.textContent = `${focal} mm`;
    }
    if (shiftElem) {
      const shiftY = ((this.projectorPos.y - 2.0) * 15).toFixed(1);
      shiftElem.textContent = `+${shiftY}%`;
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    if (!this.isDragging) {
      this.rotation.y += 0.003;
    }

    this.roomBox.rotation.x = this.rotation.x;
    this.roomBox.rotation.y = this.rotation.y;

    // Mise à jour des rayons du projecteur vers les ancres rotatives
    const beamPts = [];
    const worldMatrix = this.roomBox.matrixWorld;

    this.anchorPoints.forEach((pt) => {
      const worldPt = pt.clone().applyMatrix4(worldMatrix);
      beamPts.push(this.projectorPos.clone());
      beamPts.push(worldPt);
    });

    this.beamMesh.geometry.setFromPoints(beamPts);

    this.renderer.render(this.scene, this.camera);
  }
}

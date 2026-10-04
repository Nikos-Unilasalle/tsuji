/**
 * TSUJI (辻) — Application Web & Orchestration Bilingue
 * Low-key Japanese Geek // Node Graph Studio & Motion Design Engine
 */

import { TsujiBackgroundScene } from './scene/backgroundScene.js';
import { TsujiDltSimulator } from './scene/dltSimScene.js';
import { CATEGORY_DEFINITIONS, FULL_NODES_CATALOG } from './data/nodesCatalog.js';
import { I18N } from './i18n.js';

class TsujiApp {
  constructor() {
    this.currentLang = localStorage.getItem('tsuji_lang') || 'fr';
    this.selectedCategory = 'all';
    this.searchQuery = '';

    this.initThreeScenes();
    this.setupLanguageSwitcher();
    this.applyLanguage();
    this.renderCategoryChips();
    this.renderNodesGrid();
    this.setupSearch();
    this.setupNavigation();
  }

  initThreeScenes() {
    // 1. Scène Three.js Fullscreen en background
    try {
      this.bgScene = new TsujiBackgroundScene('three-bg-canvas');
    } catch (e) {
      console.warn('Three.js background initialization error:', e);
    }

    // 2. Simulateur DLT interactif
    try {
      this.dltSim = new TsujiDltSimulator('dlt-canvas');
    } catch (e) {
      console.warn('Three.js DLT simulator initialization error:', e);
    }
  }

  setupLanguageSwitcher() {
    const langBtns = document.querySelectorAll('.lang-btn');
    langBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const lang = e.currentTarget.dataset.lang;
        if (lang && lang !== this.currentLang) {
          this.setLanguage(lang);
        }
      });
    });
  }

  setLanguage(lang) {
    this.currentLang = lang;
    localStorage.setItem('tsuji_lang', lang);
    this.applyLanguage();
    this.renderCategoryChips();
    this.renderNodesGrid();
  }

  applyLanguage() {
    const t = I18N[this.currentLang] || I18N.fr;

    // Mise à jour de l'état actif des boutons FR/EN
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      if (btn.dataset.lang === this.currentLang) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Remplacement des éléments portant data-i18n
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (t[key]) {
        el.innerHTML = t[key];
      }
    });

    // Remplacement des placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (t[key]) {
        el.setAttribute('placeholder', t[key]);
      }
    });
  }

  renderCategoryChips() {
    const container = document.getElementById('category-chips-container');
    if (!container) return;

    const t = I18N[this.currentLang] || I18N.fr;
    const allLabel = t.allChip || 'ALL';

    let html = `<button class="cat-chip ${this.selectedCategory === 'all' ? 'active' : ''}" data-cat="all">${allLabel} [${FULL_NODES_CATALOG.length}]</button>`;

    Object.entries(CATEGORY_DEFINITIONS).forEach(([catId, catDef]) => {
      const count = FULL_NODES_CATALOG.filter((n) => n.category === catId).length;
      if (count > 0) {
        const label = catDef[this.currentLang] || catDef.en || catId;
        const isActive = this.selectedCategory === catId ? 'active' : '';
        html += `<button class="cat-chip ${isActive}" data-cat="${catId}">${label.toUpperCase()} [${count}]</button>`;
      }
    });

    container.innerHTML = html;

    container.querySelectorAll('.cat-chip').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        container.querySelectorAll('.cat-chip').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        this.selectedCategory = e.currentTarget.dataset.cat;
        this.renderNodesGrid();
      });
    });
  }

  setupSearch() {
    const input = document.getElementById('nodes-search-input');
    if (!input) return;

    input.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
      this.renderNodesGrid();
    });
  }

  renderNodesGrid() {
    const container = document.getElementById('nodes-cards-container');
    const counter = document.getElementById('nodes-count-display');
    if (!container) return;

    const t = I18N[this.currentLang] || I18N.fr;

    const filtered = FULL_NODES_CATALOG.filter((node) => {
      const matchCat = (this.selectedCategory === 'all' || node.category === this.selectedCategory);
      const summaryText = typeof node.summary === 'object'
        ? (node.summary[this.currentLang] || node.summary.fr || '')
        : (node.summary || '');

      const matchQuery = !this.searchQuery ||
        node.name.toLowerCase().includes(this.searchQuery) ||
        node.id.toLowerCase().includes(this.searchQuery) ||
        summaryText.toLowerCase().includes(this.searchQuery);

      return matchCat && matchQuery;
    });

    if (counter) {
      counter.textContent = `${filtered.length} / ${FULL_NODES_CATALOG.length} ${t.loadedNodes || 'NODES LOADED'}`;
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 3rem; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-subtle);">
          ${t.noSignalFound || '[NO NODAL SIGNAL FOUND FOR THIS CRITERIA]'}
        </div>
      `;
      return;
    }

    // Mapping des couleurs des types de sockets
    const socketColors = {
      value: '#00f0ff',
      vector: '#38bdf8',
      matrix: '#a855f7',
      color: '#ff007f',
      geometry: '#00ff66',
      texture: '#2dd4bf',
      curve: '#facc15',
      list: '#f97316',
      text: '#e2e8f0',
      any: '#94a3b8'
    };

    container.innerHTML = filtered.map((node) => {
      const catDef = CATEGORY_DEFINITIONS[node.category] || { color: '#00f0ff' };
      const catLabel = catDef[this.currentLang] || catDef.en || node.category;
      const summary = typeof node.summary === 'object'
        ? (node.summary[this.currentLang] || node.summary.en || '')
        : (node.summary || '');

      const inputsHtml = (node.inputs && node.inputs.length > 0)
        ? node.inputs.slice(0, 3).map((inp) => {
            const color = socketColors[inp.type] || '#ffffff';
            return `
              <div class="socket-row">
                <span style="color: var(--text-dim);">${inp.name || inp.id}</span>
                <span class="socket-pill" style="color: ${color};">
                  <span class="socket-dot" style="background: ${color};"></span>
                  ${inp.type}
                </span>
              </div>
            `;
          }).join('')
        : '<div class="socket-row"><span style="color: var(--text-muted); font-size: 0.7rem;">None / Local</span></div>';

      const outputsHtml = (node.outputs && node.outputs.length > 0)
        ? node.outputs.slice(0, 2).map((out) => {
            const color = socketColors[out.type] || '#ffffff';
            return `
              <div class="socket-row">
                <span style="color: var(--text-dim); font-weight: 400;">${out.name || out.id}</span>
                <span class="socket-pill" style="color: ${color};">
                  <span class="socket-dot" style="background: ${color};"></span>
                  ${out.type}
                </span>
              </div>
            `;
          }).join('')
        : '<div class="socket-row"><span style="color: var(--text-muted); font-size: 0.7rem;">Terminal Output</span></div>';

      return `
        <div class="node-card">
          <div>
            <div class="node-top">
              <span class="node-type-id">${node.id}</span>
              <span class="node-cat-badge" style="border-color: ${catDef.color}33; color: ${catDef.color};">${catLabel}</span>
            </div>
            <h3 class="node-name">${node.name}</h3>
            <p class="node-summary">${summary}</p>
          </div>

          <div class="node-sockets">
            <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.2rem;">SIGNALS [IN / OUT]</div>
            ${inputsHtml}
            ${outputsHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  setupNavigation() {
    const navLinks = document.querySelectorAll('.hud-nav a');
    const sections = document.querySelectorAll('section[id]');

    window.addEventListener('scroll', () => {
      let currentSection = '';
      const scrollPos = window.scrollY + 120;

      sections.forEach((sec) => {
        const top = sec.offsetTop;
        const height = sec.offsetHeight;
        if (scrollPos >= top && scrollPos < top + height) {
          currentSection = sec.getAttribute('id');
        }
      });

      navLinks.forEach((link) => {
        link.classList.remove('active');
        if (link.getAttribute('href') === `#${currentSection}`) {
          link.classList.add('active');
        }
      });
    });
  }
}

// Initialisation dès que le document est prêt
document.addEventListener('DOMContentLoaded', () => {
  window.tsujiApp = new TsujiApp();
});

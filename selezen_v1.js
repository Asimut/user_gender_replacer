(function () {
  'use strict';

  // Акуратно зливаємо конфіг, якщо він заданий інлайн
  const cfg = (function ensureConfig() {
    const defaults = {
      debug: false,
      genderReplacements: { female: {} },
      targetBlocks: []
    };
    if (!window.GenderReplacer || typeof window.GenderReplacer !== 'object') {
      window.GenderReplacer = {};
    }
    window.GenderReplacer.debug = Boolean(window.GenderReplacer.debug);
    window.GenderReplacer.genderReplacements = Object.assign(
      {}, defaults.genderReplacements, window.GenderReplacer.genderReplacements || {}
    );
    window.GenderReplacer.genderReplacements.female =
      window.GenderReplacer.genderReplacements.female || {};
    window.GenderReplacer.targetBlocks = Array.isArray(window.GenderReplacer.targetBlocks)
      ? window.GenderReplacer.targetBlocks
      : [];
    return window.GenderReplacer;
  })();

  // Фільтр логів — показуємо лише якщо cfg.debug = true
  (function installLogFilter() {
    const originalLog = console.log.bind(console);
    console.log = function (...args) {
      try {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[GenderReplacer]')) {
          if (cfg.debug) return originalLog(...args);
          return;
        }
      } catch (_) {}
      return originalLog(...args);
    };
  })();

  const API = window.GenderReplacer;

  // Внутрішній стан
  API._supportsLookbehind = (function () {
    try { new RegExp('(?<!a)b', 'u'); return true; } catch { return false; }
  })();
  API._lastSignature = null;
  API._stableChecks = 0;
  API._stableThreshold = 5;
  API.quickCheckId = null;
  API.intervalId = null;
  API.mainObserver = null;
  API.attributeObserver = null;
  API.textObserver = null;

  // ------------------------ Службові функції ------------------------
  API.isUserDataReady = function () {
    if (!window.UserVariables2 || !window.UserVariables2.data) return false;
    const data = window.UserVariables2.data;
    if (typeof data !== 'object' || data === null) return false;
    return ('gender' in data) || ('fullname' in data) || ('id' in data);
  };

  API.extractGenderFromDOM = function () {
    try {
      const genderKeywords = {
        female: ['жінка', 'женщина', 'woman', 'female'],
        male:   ['чоловік', 'мужчина', 'man', 'male']
      };
      const bodyText = (document.body.textContent || '').toLowerCase();

      for (const [gender, words] of Object.entries(genderKeywords)) {
        for (const w of words) {
          if (bodyText.includes(w)) {
            return gender;
          }
        }
      }
      return null;
    } catch (e) {
      console.error('[GenderReplacer] Помилка при визначенні статі з DOM:', e);
      return null;
    }
  };

  API.getUserGender = function () {
    let gender = null;

    if (API.isUserDataReady()) {
      const d = window.UserVariables2.data;
      for (const val of [d.gender, d.sex, d.Gender, d.Sex, d.user_gender, d.userGender]) {
        if (!val) continue;
        gender = String(val).toLowerCase().trim();
        if (['жінка','женщина','woman','female','f'].includes(gender)) return 'female';
        if (['чоловік','мужчина','man','male','m'].includes(gender))   return 'male';
      }
      const fromDom = API.extractGenderFromDOM();
      if (fromDom) return fromDom;
    }

    if (window.userData?.gender) {
      gender = String(window.userData.gender).toLowerCase().trim();
      if (gender) return gender;
    }

    try {
      const s = localStorage.getItem('userData') || localStorage.getItem('userGender');
      if (s) {
        const v = JSON.parse(s);
        gender = String(v.gender ?? v).toLowerCase().trim();
        if (gender) return gender;
      }
    } catch {}

    try {
      const s = sessionStorage.getItem('userData') || sessionStorage.getItem('userGender');
      if (s) {
        const v = JSON.parse(s);
        gender = String(v.gender ?? v).toLowerCase().trim();
        if (gender) return gender;
      }
    } catch {}

    if (window.Runtime?.getProgress) {
      try {
        const p = window.Runtime.getProgress();
        if (p?.userGender) {
          gender = String(p.userGender).toLowerCase().trim();
          if (gender) return gender;
        }
      } catch {}
    }

    return null;
  };

  // ------------------------ Пошук цільових блоків ------------------------
  API.findAllTargetBlocks = function () {
    const found = new Map();
    API.targetBlocks.forEach(blockId => {
      let els = document.querySelectorAll(`[data-block-id="${blockId}"]`);
      if (els.length === 0) {
        const altSelectors = [
          `[data-blockid="${blockId}"]`,
          `[data-block="${blockId}"]`,
          `[blockid="${blockId}"]`,
          `[id="${blockId}"]`,
          `[data-id="${blockId}"]`,
        ];
        for (const sel of altSelectors) {
          const alt = document.querySelectorAll(sel);
          if (alt.length) { els = alt; break; }
        }
      }
      if (els.length) found.set(blockId, Array.from(els));
    });
    return found;
  };

  // ------------------------ Замiни в текстових вузлах ------------------------
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  API.processBlock = function (block, blockId) {
    try {
      const replacements = API.genderReplacements.female || {};
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      let total = 0;

      textNodes.forEach((tn) => {
        const original = tn.nodeValue;
        let txt = original;
        let repl = 0;

        for (const [male, female] of Object.entries(replacements)) {
          const esc = escapeRegex(male);
          if (API._supportsLookbehind) {
            const re = new RegExp(`(?<![\\p{L}\\p{M}])${esc}(?![\\p{L}\\p{M}])`, 'giu');
            const m = txt.match(re);
            if (m) { txt = txt.replace(re, female); repl += m.length; }
          } else {
            const re = new RegExp(`(^|[^\\p{L}\\p{M}])(${esc})(?=([^\\p{L}\\p{M}]|$))`, 'giu');
            const m = txt.match(re);
            if (m) { txt = txt.replace(re, (_, p) => `${p || ''}${female}`); repl += m.length; }
          }
        }

        if (txt !== original) {
          tn.nodeValue = txt;
          total += repl;
        }
      });

      return total;
    } catch (e) {
      console.error(`[GenderReplacer] Помилка в блоці ${blockId}:`, e);
      return 0;
    }
  };

  API.computeSignature = function (gender, foundBlocks) {
    try {
      const parts = [`g:${gender}`];
      foundBlocks.forEach((elements, blockId) => {
        const lens = elements.map(el => (el.textContent || '').length).join(',');
        parts.push(`${blockId}:${lens}`);
      });
      return parts.join('|');
    } catch { return String(Date.now()); }
  };

  // ------------------------ Основна обробка ------------------------
  API.processAllBlocks = function () {
    try {
      if (!API.isUserDataReady()) return;
      const gender = API.getUserGender();
      if (gender !== 'female') return;

      const found = API.findAllTargetBlocks();
      const signature = API.computeSignature(gender, found);
      if (signature === API._lastSignature) {
        API._stableChecks += 1;
        if (API._stableChecks >= API._stableThreshold && API.intervalId) {
          clearInterval(API.intervalId);
          API.intervalId = null;
        }
        return;
      }
      API._lastSignature = signature;
      API._stableChecks = 0;

      if (found.size === 0) return;

      found.forEach((elements, blockId) => {
        elements.forEach((el, i) => {
          API.processBlock(el, `${blockId}[${i}]`);
        });
      });

    } catch (e) {
      console.error('[GenderReplacer] Критична помилка при обробці блоків:', e);
    }
  };

  // ------------------------ Наглядачі та події ------------------------
  API.handleMutations = function (mutations) {
    let shouldProcess = false;

    for (const m of mutations) {
      if (m.addedNodes) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.hasAttribute?.('data-block-id')) shouldProcess = true;
          }
        }
      }
      if (m.type === 'characterData') shouldProcess = true;
    }

    if (shouldProcess) setTimeout(() => API.processAllBlocks(), 150);
  };

  API.startRiseSpecificObserver = function () {
    ['#app', '.rise-player', '[data-rise]', '.course-container'].forEach(sel => {
      const c = document.querySelector(sel);
      if (!c) return;
      const o = new MutationObserver(m => API.handleMutations(m));
      o.observe(c, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  };

  API.startObserver = function () {
    API.mainObserver = new MutationObserver(m => API.handleMutations(m));
    API.attributeObserver = new MutationObserver(m => API.handleMutations(m));
    API.textObserver = new MutationObserver(m => API.handleMutations(m));

    API.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
    API.attributeObserver.observe(document.documentElement, { subtree: true, attributes: true });
    API.textObserver.observe(document.documentElement, { subtree: true, characterData: true });

    API.startRiseSpecificObserver();
  };

  API.startPeriodicCheck = function () {
    API.quickCheckId = setInterval(() => API.processAllBlocks(), 1000);
    setTimeout(() => { if (API.quickCheckId) { clearInterval(API.quickCheckId); } }, 10000);
    API.intervalId = setInterval(() => API.processAllBlocks(), 2000);
  };

  // ------------------------ Публічні утиліти ------------------------
  API.addTargetBlock = function (id) {
    if (!API.targetBlocks.includes(id)) {
      API.targetBlocks.push(id);
      setTimeout(() => API.processAllBlocks(), 100);
    }
  };
  API.addReplacement = function (male, female) {
    API.genderReplacements.female[male] = female;
  };
  API.forceProcess = function () { API.processAllBlocks(); };
  API.stop = function () {
    API.mainObserver?.disconnect();
    API.attributeObserver?.disconnect();
    API.textObserver?.disconnect();
    if (API.quickCheckId) clearInterval(API.quickCheckId);
    if (API.intervalId)   clearInterval(API.intervalId);
  };

  // ------------------------ Ініціалізація ------------------------
  API.init = function () {
    API.startObserver();
    API.startPeriodicCheck();
    API.processAllBlocks();
  };

  // Автозапуск
  setTimeout(() => {
    API.init();
    setTimeout(() => {
      const body = document.body.textContent || '';
      if (body.includes('Жінка')) { window.UserVariables2 ??= {}; (window.UserVariables2.data ??= {}).gender = 'female'; API.forceProcess(); }
      if (body.includes('Чоловік') || body.includes('Мужчина')) { window.UserVariables2 ??= {}; (window.UserVariables2.data ??= {}).gender = 'male'; API.forceProcess(); }
    }, 500);
    setTimeout(() => API.forceProcess(), 3000);
    setTimeout(() => API.forceProcess(), 5000);
  }, 100);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => API.forceProcess(), 300));
  } else {
    setTimeout(() => API.forceProcess(), 300);
  }
  window.addEventListener('load', () => setTimeout(() => API.forceProcess(), 500));
})();

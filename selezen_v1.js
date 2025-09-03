  (function () {
  'use strict';

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

  // ------------------------ Службові функції ------------------------
  API.isUserDataReady = function () {
    // Шукаємо правильні об’єкти
    const sources = [
      window.UserVariables?.data,
      window.UserVariables2?.data,
      window.userData
    ];
    
    for (const data of sources) {
      if (data && typeof data === 'object') {
        // Шукаємо правильні поля
        if ('gender' in data || 'user_firstname' in data || 'firstname' in data || 'user_id' in data) {
          return true;
        }
      }
    }
    return false;
  };

  API.getUserGender = function () {
    // Множинні джерела даних
    const sources = [
      window.UserVariables?.data,
      window.UserVariables2?.data,
      window.userData
    ];

    for (const data of sources) {
      if (!data || typeof data !== 'object') continue;
      
      // Пряме вказання статі
      for (const field of ['gender', 'sex', 'user_gender', 'userGender']) {
        if (data[field]) {
          const val = String(data[field]).toLowerCase().trim();
          if (['жінка','женщина','woman','female','f'].includes(val)) return 'female';
          if (['чоловік','мужчина','man','male','m'].includes(val)) return 'male';
        }
      }

      // Визначення статі за ім’ям 
      const name = data.user_firstname || data.firstname || data.fullname || data.name || '';
      if (name && typeof name === 'string') {
        const n = name.toLowerCase().trim();
        // Українські жіночі імена часто закінчуються на 'а', 'я', 'ія'
        if (n.match(/[ая]$|ія$/)) return 'female';
        // Чоловічі закінчення
        if (n.match(/[ийо]й$|[ьл]$/)) return 'male';
      }
    }

    // Пошук у DOM як резерв
    try {
      const bodyText = (document.body.textContent || '').toLowerCase();
      const femaleWords = ['жінка', 'женщина', 'woman', 'female'];
      const maleWords = ['чоловік', 'мужчина', 'man', 'male'];
      
      for (const word of femaleWords) {
        if (bodyText.includes(word)) return 'female';
      }
      for (const word of maleWords) {
        if (bodyText.includes(word)) return 'male';
      }
    } catch (e) {}

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

  // ------------------------ Заміни в текстових вузлах ------------------------
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

      if (cfg.debug && total > 0) {
        console.log(`[GenderReplacer] Блок ${blockId}: ${total} замін`);
      }

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
      if (!API.isUserDataReady()) {
        if (cfg.debug) console.log('[GenderReplacer] Дані користувача ще не готові');
        return;
      }
      
      const gender = API.getUserGender();
      if (gender !== 'female') {
        if (cfg.debug) console.log(`[GenderReplacer] Стать "${gender}" - заміни не потрібні`);
        return;
      }

      const found = API.findAllTargetBlocks();
      const signature = API.computeSignature(gender, found);
      if (signature === API._lastSignature) {
        API._stableChecks += 1;
        if (API._stableChecks >= API._stableThreshold && API.intervalId) {
          clearInterval(API.intervalId);
          API.intervalId = null;
          if (cfg.debug) console.log('[GenderReplacer] Стабільний стан досягнуто, зупиняю інтервал');
        }
        return;
      }
      API._lastSignature = signature;
      API._stableChecks = 0;

      if (found.size === 0) {
        if (cfg.debug) console.log('[GenderReplacer] Цільові блоки не знайдено:', API.targetBlocks);
        return;
      }

      let totalReplacements = 0;
      found.forEach((elements, blockId) => {
        elements.forEach((el, i) => {
          totalReplacements += API.processBlock(el, `${blockId}[${i}]`);
        });
      });

      if (cfg.debug) {
        console.log(`[GenderReplacer] Загалом замін: ${totalReplacements} в ${found.size} блоках`);
      }

    } catch (e) {
      console.error('[GenderReplacer] Критична помилка при обробці блоків:', e);
    }
  };

  // ------------------------ Спостерігачі та події ------------------------
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

  API.startObserver = function () {
    if (API.mainObserver) return;
    
    API.mainObserver = new MutationObserver(m => API.handleMutations(m));
    API.mainObserver.observe(document.documentElement, { 
      childList: true, 
      subtree: true, 
      characterData: true // Для відстеження змін тексту
    });

    // Специфічні спостерігачі для Rise
    ['#app', '.rise-player', '[data-rise]', '.course-container'].forEach(sel => {
      const c = document.querySelector(sel);
      if (c && !c._genderObserver) {
        const o = new MutationObserver(m => API.handleMutations(m));
        o.observe(c, { childList: true, subtree: true, attributes: true, characterData: true });
        c._genderObserver = o;
      }
    });
  };

  API.startPeriodicCheck = function () {
    // Швидка перевірка перші 10 секунд
    API.quickCheckId = setInterval(() => API.processAllBlocks(), 1000);
    setTimeout(() => { 
      if (API.quickCheckId) { 
        clearInterval(API.quickCheckId); 
        API.quickCheckId = null;
      } 
    }, 10000);
    
    // Основний інтервал
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
  
  API.forceProcess = function () { 
    if (cfg.debug) console.log('[GenderReplacer] Примусова обробка...');
    API.processAllBlocks(); 
  };
  
  API.stop = function () {
    API.mainObserver?.disconnect();
    if (API.quickCheckId) clearInterval(API.quickCheckId);
    if (API.intervalId) clearInterval(API.intervalId);
  };

  // ------------------------ Ініціалізація ------------------------
  API.init = function () {
    if (cfg.debug) console.log('[GenderReplacer] Ініціалізація...');
    API.startObserver();
    API.startPeriodicCheck();
    setTimeout(() => API.processAllBlocks(), 500);
  };

  // Чекаємо готовності UserVariables, потім запускаємо
  function waitForUserDataAndInit() {
    let attempts = 0;
    const maxAttempts = 20;
    
    const checkAndInit = () => {
      attempts++;
      
      if (API.isUserDataReady()) {
        API.init();
        return;
      }
      
      if (attempts >= maxAttempts) {
        if (cfg.debug) console.log('[GenderReplacer] Таймаут очікування даних користувача, запускаю без них');
        API.init();
        return;
      }
      
      setTimeout(checkAndInit, 500);
    };
    
    checkAndInit();
  }

  // Автозапуск
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(waitForUserDataAndInit, 100));
  } else {
    setTimeout(waitForUserDataAndInit, 100);
  }

})();


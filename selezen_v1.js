(function () {
  'use strict';

  // Нежно мёржим конфиг, если его положили инлайн
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

  // Фильтр “болтливых” логов — уважаем cfg.debug
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

  // Внутреннее состояние
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

  // ------------------------ Служебные функции ------------------------
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
            console.log(`[GenderReplacer] 🎯 Найдено ключевое слово "${w}" на странице`);
            return gender;
          }
        }
      }
      return null;
    } catch (e) {
      console.error('[GenderReplacer] ❌ Ошибка при извлечении гендера из DOM:', e);
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
        console.log(`[GenderReplacer] 📊 Гендер из UserVariables2: "${gender}"`);
        if (['жінка','женщина','woman','female','f'].includes(gender)) return 'female';
        if (['чоловік','мужчина','man','male','m'].includes(gender))   return 'male';
      }
      console.log('[GenderReplacer] ⚠️ Поле gender не найдено в UserVariables2.data');
      const fromDom = API.extractGenderFromDOM();
      if (fromDom) return fromDom;
    }

    if (window.userData?.gender) {
      gender = String(window.userData.gender).toLowerCase().trim();
      if (gender) {
        console.log(`[GenderReplacer] 📊 Гендер из window.userData: "${gender}"`);
        return gender;
      }
    }

    try {
      const s = localStorage.getItem('userData') || localStorage.getItem('userGender');
      if (s) {
        const v = JSON.parse(s);
        gender = String(v.gender ?? v).toLowerCase().trim();
        if (gender) {
          console.log(`[GenderReplacer] 📊 Гендер из localStorage: "${gender}"`);
          return gender;
        }
      }
    } catch {}

    try {
      const s = sessionStorage.getItem('userData') || sessionStorage.getItem('userGender');
      if (s) {
        const v = JSON.parse(s);
        gender = String(v.gender ?? v).toLowerCase().trim();
        if (gender) {
          console.log(`[GenderReplacer] 📊 Гендер из sessionStorage: "${gender}"`);
          return gender;
        }
      }
    } catch {}

    if (window.Runtime?.getProgress) {
      try {
        const p = window.Runtime.getProgress();
        if (p?.userGender) {
          gender = String(p.userGender).toLowerCase().trim();
          if (gender) {
            console.log(`[GenderReplacer] 📊 Гендер из SCORM: "${gender}"`);
            return gender;
          }
        }
      } catch {}
    }

    console.log('[GenderReplacer] ⚠️ Гендер не найден ни в одном источнике');
    return null;
  };

  // ------------------------ Поиск целевых блоков ------------------------
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

  // ------------------------ Замены в узлах ------------------------
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  API.processBlock = function (block, blockId) {
    try {
      const replacements = API.genderReplacements.female || {};
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      let total = 0;

      textNodes.forEach((tn, idx) => {
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
            if (m) { txt = txt.replace(re, (_, p, __) => `${p || ''}${female}`); repl += m.length; }
          }
        }

        if (txt !== original) {
          tn.nodeValue = txt;
          total += repl;
          if (API.debug) {
            console.log(`[GenderReplacer] 🔄 ЗАМЕНА в узле ${idx + 1}`);
          }
        }
      });

      return total;
    } catch (e) {
      console.error(`[GenderReplacer] ❌ Ошибка в блоке ${blockId}:`, e);
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

  // ------------------------ Основная обработка ------------------------
  API.processAllBlocks = function () {
    try {
      if (!API.isUserDataReady()) { if (API.debug) console.log('[GenderReplacer] ⏳ Данные пользователя еще не готовы'); return; }
      const gender = API.getUserGender();
      if (gender !== 'female') { if (API.debug) console.log('[GenderReplacer] ℹ️ Замена не требуется (гендер не female)'); return; }

      const found = API.findAllTargetBlocks();
      const signature = API.computeSignature(gender, found);
      if (signature === API._lastSignature) {
        API._stableChecks += 1;
        if (API._stableChecks >= API._stableThreshold && API.intervalId) {
          clearInterval(API.intervalId);
          API.intervalId = null;
          console.log('[GenderReplacer] 📴 Повторная обработка остановлена — страница стабильна');
        }
        if (API.debug) console.log('[GenderReplacer] ⏭️ Сигнатура не изменилась — пропускаем обработку');
        return;
      }
      API._lastSignature = signature;
      API._stableChecks = 0;

      if (found.size === 0) { if (API.debug) console.log('[GenderReplacer] ⚠️ Ни один целевой блок не найден'); return; }

      let total = 0;
      let processed = 0;
      found.forEach((elements, blockId) => {
        elements.forEach((el, i) => {
          try { total += API.processBlock(el, `${blockId}[${i}]`); processed++; } catch {}
        });
      });

      if (API.debug) {
        if (total > 0) console.log(`[GenderReplacer] ✅ Обработано блоков: ${processed}, замен: ${total}`);
        else console.log(`[GenderReplacer] ℹ️ Блоки найдены (${processed}), но замены не потребовались`);
      }
    } catch (e) {
      if (API.debug) console.error('[GenderReplacer] ❌ Критическая ошибка при обработке блоков:', e);
    }
  };

  // ------------------------ Наблюдатели и события ------------------------
  API.handleMutations = function (mutations, observerType) {
    let shouldProcess = false;
    const foundBlocks = new Set();

    for (const m of mutations) {
      if (m.addedNodes) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.hasAttribute?.('data-block-id')) {
              const id = n.getAttribute('data-block-id');
              if (API.targetBlocks.includes(id)) { foundBlocks.add(id); shouldProcess = true; }
            }
            API.targetBlocks.forEach(id => {
              if (n.querySelectorAll?.(`[data-block-id="${id}"]`).length) { foundBlocks.add(id); shouldProcess = true; }
            });
          }
        }
      }
      if (m.type === 'attributes' && m.target?.hasAttribute?.('data-block-id')) {
        const id = m.target.getAttribute('data-block-id');
        if (API.targetBlocks.includes(id)) { foundBlocks.add(id); shouldProcess = true; }
      }
      if (m.type === 'characterData' && m.target?.parentElement) {
        const host = m.target.parentElement.closest?.('[data-block-id]');
        const id = host?.getAttribute?.('data-block-id');
        if (id && API.targetBlocks.includes(id)) { foundBlocks.add(id); shouldProcess = true; }
      }
    }

    if (shouldProcess) {
      if (API.debug) console.log(`[GenderReplacer] 🔍 ${observerType}: найдены блоки [${Array.from(foundBlocks).join(', ')}]`);
      setTimeout(() => API.processAllBlocks(), 150);
    }
  };

  API.startRiseSpecificObserver = function () {
    ['#app', '.rise-player', '[data-rise]', '.course-container'].forEach(sel => {
      const c = document.querySelector(sel);
      if (!c) return;
      const o = new MutationObserver(m => API.handleMutations(m, `rise-${sel}`));
      o.observe(c, { childList: true, subtree: true, attributes: true, characterData: true });
      if (API.debug) console.log(`[GenderReplacer] 🎯 Rise наблюдатель установлен для: ${sel}`);
    });
  };

  API.startObserver = function () {
    if (API.debug) console.log('[GenderReplacer] 🔄 Запуск MultiObserver системы...');

    API.mainObserver = new MutationObserver(m => API.handleMutations(m, 'main'));
    API.attributeObserver = new MutationObserver(m => API.handleMutations(m, 'attributes'));
    API.textObserver = new MutationObserver(m => API.handleMutations(m, 'text'));

    API.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
    API.attributeObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-block-id','class','id'] });
    API.textObserver.observe(document.documentElement, { subtree: true, characterData: true });

    API.startRiseSpecificObserver();
    if (API.debug) console.log('[GenderReplacer] 👁️ MultiObserver система запущена (3 наблюдателя)');
  };

  API.setupRiseEventListeners = function () {
    ['rise:navigation:change', 'rise:lesson:loaded', 'rise:content:updated', 'rise:block:rendered']
      .forEach(ev => document.addEventListener(ev, () => {
        if (API.debug) console.log(`[GenderReplacer] 🎯 Rise событие: ${ev}`);
        setTimeout(() => API.processAllBlocks(), 200);
      }));
    window.addEventListener('hashchange', () => { if (API.debug) console.log('[GenderReplacer] 🔄 Изменение URL hash'); setTimeout(() => API.processAllBlocks(), 300); });
    window.addEventListener('popstate',   () => { if (API.debug) console.log('[GenderReplacer] 🔄 Popstate событие'); setTimeout(() => API.processAllBlocks(), 300); });
  };

  API.startPeriodicCheck = function () {
    API.quickCheckId = setInterval(() => API.processAllBlocks(), 1000);
    setTimeout(() => { if (API.quickCheckId) { clearInterval(API.quickCheckId); console.log('[GenderReplacer] ⚡ Быстрая проверка завершена'); } }, 10000);
    API.intervalId = setInterval(() => API.processAllBlocks(), 2000);
    API.setupRiseEventListeners();
    if (API.debug) console.log('[GenderReplacer] ⏰ Агрессивная периодическая проверка запущена');
  };

  // ------------------------ Публичные утилиты ------------------------
  API.addTargetBlock = function (id) {
    if (!API.targetBlocks.includes(id)) { API.targetBlocks.push(id); console.log(`[GenderReplacer] ➕ Добавлен блок: ${id}`); setTimeout(() => API.processAllBlocks(), 100); }
  };
  API.addReplacement = function (male, female) {
    API.genderReplacements.female[male] = female;
    console.log(`[GenderReplacer] ➕ Добавлена замена: "${male}" → "${female}"`);
  };
  API.forceProcess = function () { console.log('[GenderReplacer] 🔄 Принудительная обработка'); API.processAllBlocks(); };
  API.stop = function () {
    console.log('[GenderReplacer] 🛑 Остановка MultiObserver системы...');
    API.mainObserver?.disconnect(); console.log('[GenderReplacer] 🛑 Основной наблюдатель остановлен');
    API.attributeObserver?.disconnect(); console.log('[GenderReplacer] 🛑 Наблюдатель атрибутов остановлен');
    API.textObserver?.disconnect(); console.log('[GenderReplacer] 🛑 Текстовый наблюдатель остановлен');
    if (API.quickCheckId) { clearInterval(API.quickCheckId); console.log('[GenderReplacer] 🛑 Быстрая проверка остановлена'); }
    if (API.intervalId)   { clearInterval(API.intervalId);   console.log('[GenderReplacer] 🛑 Периодическая проверка остановлена'); }
    console.log('[GenderReplacer] ✅ MultiObserver система полностью остановлена');
  };

  // ------------------------ Инициализация ------------------------
  API.init = function () {
    console.log('[GenderReplacer] 🚀 Инициализация системы замены гендерных обращений');
    API.startObserver();
    API.startPeriodicCheck();
    API.processAllBlocks();
  };

  // Немедленная инициализация + дожим
  setTimeout(() => {
    if (API.debug) console.log('[GenderReplacer] ⚡ Немедленная инициализация');
    API.init();
    setTimeout(() => {
      // Автодетект из профиля (упрощённая версия)
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
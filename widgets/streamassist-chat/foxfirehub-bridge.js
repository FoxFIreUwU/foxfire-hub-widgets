/* foxfirehub-bridge.js — общий помощник для виджетов FoxFire Hub (v1)
 *
 * Просто скопируй этот файл в папку своего виджета (рядом с index.html и/или
 * settings.html) и подключи тегом:
 *   <script src="foxfirehub-bridge.js"></script>
 *
 * Даёт объект window.FoxFireBridge с несколькими независимыми функциями —
 * ничего не обязательно использовать целиком, бери только то, что нужно.
 * Ничего не ломает, если файл вообще не подключать: это просто обёртка над
 * тем же самым публичным контрактом (query-параметры, postMessage, Tauri-
 * событие), который и так можно реализовать вручную — см. SYSTEM_WIDGET_STYLE.md,
 * раздел 11, если хочешь понимать, что происходит "под капотом".
 *
 * Полностью самостоятельный файл: без зависимостей, без сборки, обычный
 * vanilla JS, работает и в index.html (окно виджета/оверлей OBS), и в
 * settings.html (встроенная страница настроек).
 */
(function (global) {
  "use strict";

  function readBool(v, fallback) {
    if (v === undefined || v === null) return fallback;
    return v === true || v === "true";
  }
  function readNum(v, fallback) {
    var n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Читает текущие query-параметры страницы в объект, типизируя каждое поле
   * по типу значения в defaults (boolean/number/string) — так же, как уже
   * делает и index.html, и settings.html вручную, только в одном месте.
   *
   *   const config = FoxFireBridge.getInitialConfig(DEFAULTS);
   */
  function getInitialConfig(defaults) {
    var params = new global.URLSearchParams(global.location.search);
    var cfg = {};
    Object.keys(defaults || {}).forEach(function (key) {
      cfg[key] = defaults[key];
      if (!params.has(key)) return;
      var raw = params.get(key);
      if (typeof defaults[key] === "boolean") cfg[key] = readBool(raw, defaults[key]);
      else if (typeof defaults[key] === "number") cfg[key] = readNum(raw, defaults[key]);
      else cfg[key] = raw;
    });
    return cfg;
  }

  // Запущена ли страница внутри FoxFire Hub вообще (окно виджета, открытое
  // кнопкой "Запустить", ИЛИ встроенная страница настроек) — по наличию
  // window.__TAURI__ (см. withGlobalTauri в tauri.conf.json самого Hub).
  // Как обычный файл (например, вставленный ссылкой в источник "Браузер" в
  // OBS) — window.__TAURI__ не существует.
  function hasTauri() {
    // Tauri v1: __TAURI__.tauri; Tauri v2: __TAURI__.core (или __TAURI_INTERNALS__).
    return !!(global.__TAURI__ && global.__TAURI__.event && (global.__TAURI__.tauri || global.__TAURI__.core)) || !!global.__TAURI_INTERNALS__;
  }

  // Встроена ли именно ЭТА страница как <iframe> внутрь окна Hub (так
  // открывается settingsEntry во вкладке "Загруженное") — отличается от
  // hasTauri(): окно виджета (index.html), запущенное кнопкой "Запустить",
  // тоже работает внутри Hub и видит window.__TAURI__, но оно НЕ встроено в
  // родительский документ как iframe, у него нет своего "родителя" в этом
  // смысле — isEmbeddedInHub() для него вернёт false, а hasTauri() — true.
  function isEmbeddedInHub() {
    try {
      return !!(global.parent && global.parent !== global);
    } catch (e) {
      return false;
    }
  }

  var CONFIG_UPDATE_EVENT = "foxfirehub:config-updated"; // Tauri-событие, Hub -> уже открытое окно виджета
  var SAVE_MESSAGE_TYPE = "foxfirehub:settings-saved"; // postMessage, встроенная страница настроек -> Hub

  /**
   * Сохраняет (или обновляет частично) настройки в Hub — работает только
   * если страница открыта как settingsEntry внутри вкладки "Загруженное"
   * (см. isEmbeddedInHub). Можно слать весь конфиг целиком или только
   * изменившиеся поля — Hub накладывает присланное поверх уже сохранённого.
   * Возвращает true, если сообщение реально было кому отправить.
   *
   *   FoxFireBridge.saveConfig("my-widget-id", { textColor: "#fff" });
   */
  function saveConfig(widgetId, config) {
    if (!isEmbeddedInHub()) return false;
    global.parent.postMessage({ type: SAVE_MESSAGE_TYPE, widgetId: widgetId, config: config }, "*");
    return true;
  }

  /**
   * Подписка на ЖИВЫЕ изменения настроек — для окна виджета (index.html),
   * уже запущенного кнопкой "Запустить", когда пользователь параллельно
   * меняет настройки в другом месте (вкладка "Загруженное", открытая
   * одновременно). Без этого окно подхватило бы новые значения только на
   * следующий перезапуск — начальный конфиг читается из query-параметров
   * один раз, при создании окна.
   *
   * callback вызывается по одному изменённому полю за раз:
   *   const stop = FoxFireBridge.onLiveConfigUpdate("my-widget-id", ({ key, value }) => {
   *     config[key] = value;
   *     applyConfig(config); // сам решаешь, что делать с изменением
   *   });
   *   // stop() — отписаться, если понадобится
   *
   * Работает только внутри FoxFire Hub (нужен window.__TAURI__) — вне Hub
   * (файл открыт отдельно, как в источнике "Браузер" OBS) просто ничего не
   * делает, это нормальный случай, а не ошибка.
   */
  function onLiveConfigUpdate(widgetId, callback) {
    if (!hasTauri() || typeof callback !== "function") {
      return function unsubscribe() {};
    }
    var unlisten = null;
    var stopped = false;
    global.__TAURI__.event
      .listen(CONFIG_UPDATE_EVENT, function (event) {
        var payload = event && event.payload;
        if (!payload || payload.widgetId !== widgetId) return;
        callback({ key: payload.key, value: payload.value });
      })
      .then(function (fn) {
        if (stopped) fn();
        else unlisten = fn;
      })
      .catch(function (err) {
        console.warn("FoxFireBridge: не удалось подписаться на живые обновления настроек", err);
      });
    return function unsubscribe() {
      stopped = true;
      if (unlisten) unlisten();
    };
  }

  /**
   * Необязательный снимок текущей темы Hub (акцентный цвет пользователя,
   * скругление, масштаб текста, светлая/тёмная/системная) — Hub кладёт его
   * сам в query-параметр __hubTheme, когда открывает settingsEntry или
   * запускает окно виджета (см. utils/appearance.ts → themeBridgeSnapshot в
   * самом Hub). Использовать не обязательно — просто способ подхватить
   * личный акцент пользователя вместо жёстко зашитого цвета, если у виджета
   * нет своей фиксированной фирменной палитры.
   *
   *   const theme = FoxFireBridge.getHubTheme();
   *   // { accent: "#e2820a", accentDark: "#ba6c08", radius: "16px", textScale: "100%", mode: "system" }
   */
  function getHubTheme() {
    var params = new global.URLSearchParams(global.location.search);
    var raw = params.get("__hubTheme");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /**
   * Кладёт тему Hub (см. getHubTheme) как CSS-переменные на :root:
   * --hub-accent, --hub-accent-dark, --hub-radius, --hub-text-scale, плюс
   * атрибут data-hub-theme="dark|light|system". В своём CSS используй их
   * через var(--hub-accent, #свой-цвет-по-умолчанию) — тогда всё продолжит
   * работать даже если тема недоступна (страница открыта не из Hub, или из
   * старой версии Hub, которая ещё не шлёт __hubTheme).
   * Возвращает true, если тема была и переменные выставлены.
   */
  function applyHubTheme(theme) {
    theme = theme || getHubTheme();
    if (!theme) return false;
    var root = global.document.documentElement.style;
    if (theme.accent) root.setProperty("--hub-accent", theme.accent);
    if (theme.accentDark) root.setProperty("--hub-accent-dark", theme.accentDark);
    if (theme.radius) root.setProperty("--hub-radius", theme.radius);
    if (theme.textScale) root.setProperty("--hub-text-scale", theme.textScale);
    if (theme.mode) global.document.documentElement.setAttribute("data-hub-theme", theme.mode);
    return true;
  }

  global.FoxFireBridge = {
    getInitialConfig: getInitialConfig,
    hasTauri: hasTauri,
    isEmbeddedInHub: isEmbeddedInHub,
    saveConfig: saveConfig,
    onLiveConfigUpdate: onLiveConfigUpdate,
    getHubTheme: getHubTheme,
    applyHubTheme: applyHubTheme
  };
})(window);

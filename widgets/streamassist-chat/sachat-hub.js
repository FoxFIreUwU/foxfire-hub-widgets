/* sachat-hub.js — «клей» между виджетом «Чат» (wchat.js) и FoxFire Hub.

   В программе StreamAssist чат читает Rust (src-tauri/src/chat/twitch.rs, emotes.rs, youtube.rs), а виджет
   только рисует. В Hub бэкенда StreamAssist нет, поэтому здесь то же самое сделано в браузере:
     • Twitch — анонимный IRC по WebSocket (justinfan…), разбор строк = порт twitch.rs (те же правила и те же проверки);
     • 7TV / BetterTTV — глобальные наборы, порт emotes.rs;
     • YouTube — без ключа через локальный сервер / команду Hub (как в unified-chat) или по API-ключу Google;
     • всё приводится к ЕДИНОМУ формату ChatMessage, который понимает wchat.js:
         { seq, id, platform:'twitch'|'youtube', kind:'message'|'superchat'|'member'|'system',
           author, color, badges:[{role,label}], parts:[{text,image?}], ts, amount }
   Текст сообщения — не HTML, а список частей «текст / картинка»: wchat.js строит их через textContent.

   Файл ничего не знает о странице: все обращения к сети и окну идут через `env`, поэтому разбор проверяется
   тестами в Node (tests/sachat-hub.test.js) без браузера. */
(function (root) {
  'use strict';

  var TWITCH_WS = 'wss://irc-ws.chat.twitch.tv:443';
  var SEEN_MAX = 4000;           // сколько последних идентификаторов помним для защиты от повторов
  var STALE_MS = 7 * 60 * 1000;  // Twitch шлёт PING раз в ~5 минут; тишина дольше 7 — соединение мёртвое

  // ——— Настройки подключения (то, что не относится к оформлению) —————————————————————————
  var YT_MODE_KEYLESS = 'Без ключа (через Hub)';
  var YT_MODE_API = 'API-ключ (официально)';
  var CONN_DEFAULTS = {
    twitchChannel: '',
    youtubeChannel: '',
    youtubeMode: YT_MODE_KEYLESS,
    youtubeApiKey: '',
    youtubeVideoIdOverride: '',
    thirdPartyEmotes: true
  };

  function cleanStr(v, max) {
    return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }
  function readBool(v, d) {
    if (v === undefined || v === null || v === '') return d;
    return v === true || v === 1 || v === '1' || v === 'true';
  }
  // Любой «сырой» объект (query-параметры, config.js, сообщение от Hub) → проверенные настройки подключения.
  function connFrom(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var mode = raw.youtubeMode === YT_MODE_API ? YT_MODE_API : YT_MODE_KEYLESS;
    return {
      twitchChannel: cleanStr(raw.twitchChannel, 120),
      youtubeChannel: cleanStr(raw.youtubeChannel, 200),
      youtubeMode: mode,
      youtubeApiKey: cleanStr(raw.youtubeApiKey, 100).replace(/[^A-Za-z0-9_\-]/g, ''),
      youtubeVideoIdOverride: cleanStr(raw.youtubeVideoIdOverride, 200),
      thirdPartyEmotes: readBool(raw.thirdPartyEmotes, CONN_DEFAULTS.thirdPartyEmotes)
    };
  }

  // Логин Twitch: допускаем и ссылку, и «#имя», и «@имя». Пусто — если непохоже на логин.
  function normTwitch(input) {
    var s = String(input || '').trim().toLowerCase();
    var m = /twitch\.tv\/([a-z0-9_]+)/.exec(s);
    if (m) s = m[1];
    s = s.replace(/^[#@]/, '');
    return /^[a-z0-9_]{1,25}$/.test(s) ? s : '';
  }
  // Video ID YouTube: из ссылки (watch?v=, youtu.be/, /live/) или как есть.
  function normVideoId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = /(?:[?&]v=|youtu\.be\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : s.slice(0, 64);
  }

  // ——— Twitch: разбор строки IRC (порт chat/twitch.rs) ———————————————————————————————
  function unescapeTag(v) {
    var out = '', i = 0;
    while (i < v.length) {
      var c = v[i++];
      if (c === '\\') {
        if (i >= v.length) break;
        var n = v[i++];
        out += n === 's' ? ' ' : n === ':' ? ';' : n === 'r' ? '\r' : n === 'n' ? '\n' : n;
      } else out += c;
    }
    return out;
  }
  function parseTags(raw) {
    var out = {};
    String(raw).split(';').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      out[kv.slice(0, i)] = unescapeTag(kv.slice(i + 1));
    });
    return out;
  }

  var BADGE_INFO = {
    broadcaster: ['broadcaster', 'Стример'],
    moderator: ['moderator', 'Модератор'],
    lead_moderator: ['lead_moderator', 'Ведущий модератор'],
    vip: ['vip', 'VIP'],
    subscriber: ['subscriber', 'Подписчик'],
    founder: ['subscriber', 'Фаундер'],
    partner: ['partner', 'Партнёр'],
    staff: ['staff', 'Staff'],
    admin: ['staff', 'Admin']
  };
  function parseBadges(raw) {
    var out = [];
    String(raw || '').split(',').forEach(function (entry) {
      var info = BADGE_INFO[entry.split('/')[0]];
      if (!info) return;
      if (out.some(function (b) { return b.label === info[1]; })) return;
      out.push({ role: info[0], label: info[1] });
    });
    return out;
  }
  // Цвет ника допускаем только вида #RRGGBB — он попадает в стиль элемента.
  function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || ''); }

  function stripAction(text) {
    if (text.indexOf('\u0001ACTION ') === 0) return text.slice(8).replace(/\u0001+$/, '');
    return text;
  }

  // Слова из «third» (7TV / BetterTTV) заменяются картинками, только целые слова.
  function pushText(parts, segment, third) {
    var buf = '';
    segment.split(' ').forEach(function (word, i) {
      if (i > 0) buf += ' ';
      var url = word && third ? third.get(word) : undefined;
      if (url) {
        if (buf) { parts.push({ text: buf }); buf = ''; }
        parts.push({ text: word, image: url });
      } else buf += word;
    });
    if (buf) parts.push({ text: buf });
  }
  // Позиции эмоутов Twitch считаются в СИМВОЛАХ (code points), а не в единицах UTF-16 и не в байтах.
  function renderParts(text, emotesTag, third) {
    var chars = Array.from(text), ranges = [];
    String(emotesTag || '').split('/').forEach(function (entry) {
      var i = entry.indexOf(':');
      if (i < 0) return;
      var id = entry.slice(0, i), list = entry.slice(i + 1);
      if (!id || !/^[A-Za-z0-9_]+$/.test(id)) return;
      list.split(',').forEach(function (pos) {
        var m = /^(\d+)-(\d+)$/.exec(pos);
        if (m) ranges.push([+m[1], +m[2], id]);
      });
    });
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var parts = [], cursor = 0;
    ranges.forEach(function (r) {
      var s = r[0], e = r[1];
      if (s < cursor || e < s || e >= chars.length) return;
      pushText(parts, chars.slice(cursor, s).join(''), third);
      parts.push({ text: chars.slice(s, e + 1).join(''), image: 'https://static-cdn.jtvnw.net/emoticons/v2/' + r[2] + '/default/dark/2.0' });
      cursor = e + 1;
    });
    if (cursor < chars.length) pushText(parts, chars.slice(cursor).join(''), third);
    return parts;
  }

  function tagTs(tags, now) {
    var n = parseInt(tags['tmi-sent-ts'], 10);
    return isFinite(n) ? n : now();
  }
  function systemMsg(id, text, ts) {
    return { id: id, platform: 'twitch', kind: 'system', author: '', color: null, badges: [], parts: [{ text: text }], ts: ts, amount: null };
  }
  function privmsg(prefix, params, tags, third, now) {
    var i = params.indexOf(' :');
    if (i < 0) return { t: 'ignore' };
    var text = stripAction(params.slice(i + 2));
    var nick = prefix.replace(/^:/, '').split('!')[0] || '';
    var author = tags['display-name'] || nick;
    if (!author) return { t: 'ignore' };
    var ts = tagTs(tags, now);
    return { t: 'chat', msg: {
      id: tags.id || (nick + '-' + ts + '-' + Array.from(text).length),
      platform: 'twitch', kind: 'message', author: author,
      color: validColor(tags.color) ? tags.color : null,
      badges: parseBadges(tags.badges),
      parts: renderParts(text, tags.emotes, third),
      ts: ts, amount: null
    } };
  }
  function clearchat(params, tags, now) {
    var i = params.indexOf(' :');
    var target = i >= 0 ? params.slice(i + 2).trim() : '';
    var text = !target ? 'чат полностью очищен модератором'
      : tags['ban-duration'] !== undefined ? target + ' получил(а) таймаут (' + tags['ban-duration'] + ' сек)'
      : target + ' забанен(а)';
    var ts = tagTs(tags, now);
    return { t: 'chat', msg: systemMsg('clearchat-' + ts + '-' + target, text, ts) };
  }
  function clearmsg(tags, now) {
    var login = tags.login || 'пользователь', ts = tagTs(tags, now);
    var id = tags['target-msg-id'] ? 'clearmsg-' + tags['target-msg-id'] : 'clearmsg-' + login + '-' + ts;
    return { t: 'chat', msg: systemMsg(id, 'сообщение от ' + login + ' удалено модератором', ts) };
  }
  function splitn3(s) {
    var a = s.indexOf(' ');
    if (a < 0) return [s, '', ''];
    var b = s.indexOf(' ', a + 1);
    if (b < 0) return [s.slice(0, a), s.slice(a + 1), ''];
    return [s.slice(0, a), s.slice(a + 1, b), s.slice(b + 1)];
  }
  // Одна строка IRC → { t:'ping'|'joined'|'reconnect'|'notice'|'chat'|'ignore', … }
  function parseLine(line, third, nowFn) {
    var now = nowFn || Date.now;
    line = String(line).replace(/[\r\n]+$/, '');
    if (line.indexOf('PING') === 0) {
      var payload = line.slice(4).trim();
      return { t: 'ping', payload: payload || ':tmi.twitch.tv' };
    }
    var tags = {}, rest = line;
    if (line[0] === '@') {
      var sp = line.indexOf(' ');
      if (sp < 0) return { t: 'ignore' };
      tags = parseTags(line.slice(1, sp));
      rest = line.slice(sp + 1);
    }
    var p = splitn3(rest), prefix = p[0], command = p[1], params = p[2];
    switch (command) {
      case '366': case 'JOIN': return { t: 'joined' };
      case 'RECONNECT': return { t: 'reconnect' };
      case 'NOTICE': { var i = params.indexOf(' :'); return { t: 'notice', text: i >= 0 ? params.slice(i + 2) : '' }; }
      case 'PRIVMSG': return privmsg(prefix, params, tags, third, now);
      case 'CLEARCHAT': return clearchat(params, tags, now);
      case 'CLEARMSG': return clearmsg(tags, now);
      default: return { t: 'ignore' };
    }
  }

  // ——— Сторонние эмоуты (порт chat/emotes.rs): только глобальные наборы 7TV и BetterTTV —————————
  function goodName(n) { var l = Array.from(n).length; return l >= 2 && l <= 30 && !/\s/.test(n); }
  function Emotes() { this.map = {}; this.enabled = true; }
  Emotes.prototype.get = function (w) {
    return this.enabled && Object.prototype.hasOwnProperty.call(this.map, w) ? this.map[w] : undefined;
  };
  Emotes.prototype.setAll = function (all) { this.map = all || {}; };

  function parse7tv(v) {
    var out = {};
    ((v && v.emotes) || []).forEach(function (e) {
      if (!e || typeof e.name !== 'string' || !goodName(e.name)) return;
      var host = e.data && e.data.host;
      if (!host || typeof host.url !== 'string' || !Array.isArray(host.files) || !host.files.length) return;
      var nm = function (f) { return f && typeof f.name === 'string' ? f.name : ''; };
      var pick = host.files.filter(function (f) { return /^2x/.test(nm(f)) && /\.webp$/.test(nm(f)); })[0] ||
        host.files.filter(function (f) { return /^2x/.test(nm(f)); })[0] || host.files[host.files.length - 1];
      var file = nm(pick);
      if (!file) return;
      var url = 'https:' + host.url + '/' + file;
      if (/^https:\/\//.test(url)) out[e.name] = url;
    });
    return out;
  }
  function parseBttv(v) {
    var out = {};
    if (Array.isArray(v)) v.forEach(function (e) {
      if (e && typeof e.code === 'string' && typeof e.id === 'string' && goodName(e.code) && /^[A-Za-z0-9]+$/.test(e.id)) {
        out[e.code] = 'https://cdn.betterttv.net/emote/' + e.id + '/2x';
      }
    });
    return out;
  }
  function fetchJson(env, url, ms) {
    return env.fetchTimeout(url, ms).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }
  // Что не загрузилось, того просто нет — чат от этого не ломается.
  function loadGlobalEmotes(env) {
    var all = {};
    return fetchJson(env, 'https://7tv.io/v3/emote-sets/global', 5000).then(
      function (v) { Object.assign(all, parse7tv(v)); }, function () { /* 7TV недоступен */ }
    ).then(function () {
      return fetchJson(env, 'https://api.betterttv.net/3/cached/emotes/global', 5000).then(function (v) {
        var b = parseBttv(v);
        Object.keys(b).forEach(function (k) { if (!(k in all)) all[k] = b[k]; });
      }, function () { /* BetterTTV недоступен */ });
    }).then(function () { return all; });
  }

  // ——— YouTube → ChatMessage ——————————————————————————————————————————————————————————
  var YT_ROLE = {
    owner: ['broadcaster', 'Владелец канала'],
    moderator: ['moderator', 'Модератор'],
    member: ['subscriber', 'Спонсор канала'],
    verified: ['partner', 'Подтверждён']
  };
  // Ответ Hub (/api/yt/poll или команда yt_chat_poll): { author, runs:[{text,emoji?}], badges:['owner'…], ts, superchat? }
  function fromYtPoll(m) {
    if (!m || typeof m !== 'object') return null;
    var parts = [];
    (Array.isArray(m.runs) ? m.runs : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var text = typeof r.text === 'string' ? r.text : '';
      if (typeof r.emoji === 'string' && /^https:\/\//i.test(r.emoji)) parts.push({ text: text, image: r.emoji });
      else if (text) parts.push({ text: text });
    });
    var paid = typeof m.superchat === 'string' && m.superchat ? m.superchat : null;
    if (!parts.length && !paid) return null;
    var badges = [];
    (Array.isArray(m.badges) ? m.badges : []).forEach(function (b) {
      var info = YT_ROLE[b];
      if (info) badges.push({ role: info[0], label: info[1] });
    });
    return {
      id: String(m.id || (m.author + '-' + m.ts)), platform: 'youtube', kind: paid ? 'superchat' : 'message',
      author: String(m.author || 'YouTube'), color: null, badges: badges, parts: parts,
      ts: typeof m.ts === 'number' && isFinite(m.ts) ? m.ts : Date.now(), amount: paid
    };
  }
  // Ответ официального API (liveChat/messages): item → ChatMessage.
  function fromYtApi(item) {
    var sn = (item && item.snippet) || {}, au = (item && item.authorDetails) || {};
    var text = typeof sn.displayMessage === 'string' ? sn.displayMessage : '';
    var paid = sn.superChatDetails && sn.superChatDetails.amountDisplayString ? String(sn.superChatDetails.amountDisplayString) : null;
    var member = sn.type === 'newSponsorEvent' || sn.type === 'memberMilestoneChatEvent';
    if (!text && !paid) return null;
    var badges = [];
    if (au.isChatOwner) badges.push({ role: 'broadcaster', label: 'Владелец канала' });
    if (au.isChatModerator) badges.push({ role: 'moderator', label: 'Модератор' });
    if (au.isChatSponsor) badges.push({ role: 'subscriber', label: 'Спонсор канала' });
    if (au.isVerified) badges.push({ role: 'partner', label: 'Подтверждён' });
    var ts = sn.publishedAt ? Date.parse(sn.publishedAt) : NaN;
    return {
      id: String(item.id || (au.displayName + '-' + sn.publishedAt)), platform: 'youtube',
      kind: paid ? 'superchat' : member ? 'member' : 'message',
      author: String(au.displayName || 'YouTube'), color: null, badges: badges,
      parts: text ? [{ text: text }] : [], ts: isFinite(ts) ? ts : Date.now(), amount: paid
    };
  }

  // ——— Лента: защита от повторов и нумерация (как ChatHub в chat/mod.rs) ———————————————————
  function createFeed() {
    var seq = 0, seen = Object.create(null), order = [];
    return {
      // Возвращает готовое сообщение с номером или null, если такое уже было.
      add: function (raw) {
        if (!raw || !Array.isArray(raw.parts)) return null;
        var key = raw.platform + ':' + raw.id;
        if (seen[key]) return null;
        seen[key] = true; order.push(key);
        if (order.length > SEEN_MAX) delete seen[order.shift()];
        raw.seq = ++seq;
        return raw;
      },
      reset: function () { seen = Object.create(null); order = []; }
    };
  }

  // ——— Подключения ————————————————————————————————————————————————————————————————————
  // env: { WebSocket, fetchTimeout(url, ms), tauriInvoke(), location, now() } — по умолчанию из окна.
  function defaultEnv() {
    var w = root;
    function tauriInvoke() {
      var t = w.__TAURI__;
      if (t && t.tauri && t.tauri.invoke) return t.tauri.invoke.bind(t.tauri);
      if (t && t.core && t.core.invoke) return t.core.invoke.bind(t.core);
      if (w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke) return w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
      return null;
    }
    return {
      WebSocket: w.WebSocket,
      fetchTimeout: function (url, ms) {
        var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, ms);
        return w.fetch(url, { signal: ctrl.signal }).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
      },
      tauriInvoke: tauriInvoke,
      location: w.location,
      now: Date.now
    };
  }

  function keylessTransport(env) {
    var loc = env.location;
    if (loc && loc.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(loc.hostname)) {
      return { name: 'local', poll: function (q) {
        var url = loc.origin + '/api/yt/poll?channel=' + encodeURIComponent(q.channel) + '&video=' + encodeURIComponent(q.video) + '&since=' + q.since;
        return env.fetchTimeout(url, 8000).then(function (res) {
          if (!res.ok) throw new Error('локальный сервер Hub ответил ' + res.status);
          return res.json();
        });
      } };
    }
    var inv = env.tauriInvoke && env.tauriInvoke();
    if (inv) return { name: 'tauri', poll: function (q) { return inv('yt_chat_poll', { channel: q.channel, videoId: q.video, since: q.since }); } };
    return null;
  }

  function createConnections(envIn, hooks) {
    var env = Object.assign(defaultEnv(), envIn || {});
    var third = new Emotes();
    var feed = createFeed();
    var timers = new Set();
    var cur = { twitch: null, youtube: null };   // что сейчас подключено: { key, stop }
    var emotesLoading = false, emotesLoaded = false, dead = false;

    function later(fn, ms) {
      var id = setTimeout(function () { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    }
    function status(platform, state, text) { if (hooks.onStatus) hooks.onStatus(platform, state, text || ''); }
    function deliver(raw) {
      var m = feed.add(raw);
      if (m && !dead) hooks.onMessage(m);
    }

    function loadEmotes() {
      if (emotesLoading || emotesLoaded) return;
      emotesLoading = true;
      loadGlobalEmotes(env).then(function (all) { third.setAll(all); emotesLoaded = true; }, function () { /* без сторонних эмоутов */ })
        .then(function () { emotesLoading = false; });
    }

    // ——— Twitch ———
    function startTwitch(channel) {
      var stopped = false, ws = null, delay = 1000, lastData = 0, watchdog = 0;
      function connect() {
        if (stopped || dead) return;
        status('twitch', 'connecting', 'подключение к #' + channel + '…');
        try { ws = new env.WebSocket(TWITCH_WS); } catch (e) {
          status('twitch', 'error', 'не удалось открыть соединение с Twitch');
          later(connect, delay = Math.min(delay * 2, 30000));
          return;
        }
        var mine = ws;
        mine.onopen = function () {
          lastData = env.now();
          mine.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          mine.send('PASS SCHMOOPIIE');
          mine.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
          mine.send('JOIN #' + channel);
        };
        mine.onmessage = function (ev) {
          lastData = env.now();
          String(ev.data).split('\r\n').forEach(function (line) {
            if (!line) return;
            var r = parseLine(line, third, env.now);
            if (r.t === 'ping') mine.send('PONG ' + r.payload);
            else if (r.t === 'joined') { delay = 1000; status('twitch', 'connected', '#' + channel); }
            else if (r.t === 'notice') status('twitch', 'error', r.text || 'сообщение от Twitch');
            else if (r.t === 'reconnect') { try { mine.close(); } catch (e) { /* уже закрыт */ } }
            else if (r.t === 'chat') deliver(r.msg);
          });
        };
        mine.onclose = function () {
          if (stopped || ws !== mine) return;
          status('twitch', 'connecting', 'переподключение…');
          later(connect, delay);
          delay = Math.min(delay * 2, 30000);
        };
        mine.onerror = function () {
          status('twitch', 'error', 'нет связи с чатом Twitch (проверьте интернет и файрвол)');
          try { mine.close(); } catch (e) { /* уже закрыт */ }
        };
      }
      watchdog = setInterval(function () {
        if (ws && lastData && env.now() - lastData > STALE_MS) { lastData = env.now(); try { ws.close(); } catch (e) { /* уже закрыт */ } }
      }, 60000);
      connect();
      return function stop() {
        stopped = true; clearInterval(watchdog);
        var w = ws; ws = null;
        if (w) { w.onclose = w.onerror = w.onmessage = null; try { w.close(); } catch (e) { /* уже закрыт */ } }
        status('twitch', 'idle', '');
      };
    }

    // ——— YouTube без ключа (через Hub) ———
    function runKeyless(c, transport, ref, giveUp) {
      var since = 0, fails = 0;
      function tick() {
        if (ref.stopped) return;
        var wait = 1500;
        Promise.resolve().then(function () {
          return transport.poll({ channel: c.youtubeChannel, video: normVideoId(c.youtubeVideoIdOverride), since: since });
        }).then(function (r) {
          if (ref.stopped) return;
          r = r || {};
          fails = 0;
          if (typeof r.next === 'number') since = r.next;
          if (r.state === 'connected') status('youtube', 'connected', r.message || '');
          else if (r.state === 'error') { status('youtube', 'error', r.message || 'ошибка чтения чата'); wait = 5000; }
          else if (r.state === 'offline') { status('youtube', 'idle', r.message || 'эфира сейчас нет, жду…'); wait = 4000; }
          else { status('youtube', 'connecting', r.message || 'ищу трансляцию…'); wait = 2500; }
          (Array.isArray(r.messages) ? r.messages : []).forEach(function (m) { deliver(fromYtPoll(m)); });
        }, function (err) {
          if (ref.stopped) return;
          fails++;
          status('youtube', 'error', 'нет связи с Hub: ' + (err && err.message ? err.message : err));
          wait = 5000;
          if (fails >= 5 && c.youtubeApiKey) { giveUp(); wait = -1; }
        }).then(function () { if (!ref.stopped && wait >= 0) later(tick, wait); });
      }
      tick();
    }

    // ——— YouTube по официальному API-ключу ———
    function apiJson(url) {
      return env.fetchTimeout(url, 10000).then(function (res) { return res.json().then(function (d) { return { status: res.status, data: d }; }); });
    }
    function runApi(c, ref) {
      var inv = env.tauriInvoke && env.tauriInvoke();
      var chanCache = null;
      function resolveChannelId() {
        if (chanCache) return Promise.resolve(chanCache);
        var h = c.youtubeChannel.trim(), m = /youtube\.com\/([^/?#]+)/.exec(h);
        if (m) h = m[1];
        var q = /^UC[\w-]{20,}$/.test(h) ? 'id=' + encodeURIComponent(h) : 'forHandle=' + encodeURIComponent(h[0] === '@' ? h : '@' + h);
        return apiJson('https://www.googleapis.com/youtube/v3/channels?part=id&' + q + '&key=' + encodeURIComponent(c.youtubeApiKey)).then(function (r) {
          if (r.data.error) throw new Error(r.data.error.message || 'ошибка YouTube API');
          chanCache = r.data.items && r.data.items[0] && r.data.items[0].id || null;
          return chanCache;
        });
      }
      function findVideo() {
        var ov = normVideoId(c.youtubeVideoIdOverride);
        if (ov) return Promise.resolve(ov);
        if (inv) return Promise.resolve(inv('resolve_youtube_live_video', { channel: c.youtubeChannel })).catch(function () { return null; });
        return resolveChannelId().then(function (id) {
          if (!id) return null;
          return apiJson('https://www.googleapis.com/youtube/v3/search?part=id&channelId=' + encodeURIComponent(id) + '&eventType=live&type=video&key=' + encodeURIComponent(c.youtubeApiKey))
            .then(function (r) { return r.data.error ? null : (r.data.items && r.data.items[0] && r.data.items[0].id && r.data.items[0].id.videoId) || null; });
        });
      }
      var retryIdle = inv ? 20000 : 5 * 60 * 1000;   // через Hub поиск бесплатный, через API — берегём квоту
      function loop() {
        if (ref.stopped) return;
        status('youtube', 'connecting', 'ищу трансляцию…');
        findVideo().then(function (video) {
          if (ref.stopped) return;
          if (!video) { status('youtube', 'idle', 'эфира сейчас нет, жду…'); later(loop, retryIdle); return; }
          return apiJson('https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=' + encodeURIComponent(video) + '&key=' + encodeURIComponent(c.youtubeApiKey)).then(function (r) {
            if (ref.stopped) return;
            if (r.data.error) throw new Error(r.data.error.message || 'ошибка YouTube API');
            var it = r.data.items && r.data.items[0];
            var chatId = it && it.liveStreamingDetails && it.liveStreamingDetails.activeLiveChatId;
            if (!chatId) { status('youtube', 'idle', 'у трансляции нет активного чата'); later(loop, retryIdle); return; }
            status('youtube', 'connected', 'API-ключ');
            poll(chatId, undefined);
          });
        }).catch(function (e) {
          if (ref.stopped) return;
          status('youtube', 'error', (e && e.message) || 'ошибка YouTube');
          later(loop, 20000);
        });
      }
      function poll(chatId, token) {
        if (ref.stopped) return;
        var url = 'https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=' + encodeURIComponent(chatId) +
          '&part=snippet,authorDetails&key=' + encodeURIComponent(c.youtubeApiKey) + (token ? '&pageToken=' + encodeURIComponent(token) : '');
        var wait = 5000;
        apiJson(url).then(function (r) {
          if (ref.stopped) return;
          var d = r.data;
          if (d.error) {
            var reason = d.error.errors && d.error.errors[0] && d.error.errors[0].reason || '';
            if (reason === 'liveChatEnded' || r.status === 403 || r.status === 404) { later(loop, 3000); wait = -1; return; }
            status('youtube', 'error', d.error.message || 'ошибка YouTube API');
            wait = 30000;   // скорее всего квота: чаще раза в 30 с не стучимся
            return;
          }
          (d.items || []).forEach(function (it) { deliver(fromYtApi(it)); });
          token = d.nextPageToken || token;
          wait = Math.max(2000, d.pollingIntervalMillis || 5000);
        }, function () { wait = 15000; }).then(function () { if (!ref.stopped && wait >= 0) later(function () { poll(chatId, token); }, wait); });
      }
      loop();
    }

    function startYoutube(c) {
      var ref = { stopped: false };
      var wantApi = c.youtubeMode === YT_MODE_API;
      var transport = wantApi ? null : keylessTransport(env);
      if (transport) runKeyless(c, transport, ref, function () { runApi(c, ref); });
      else if (!c.youtubeApiKey) {
        status('youtube', 'error', wantApi ? 'не указан API-ключ YouTube'
          : 'без ключа чат YouTube читается только через Hub: откройте виджет по ссылке из Hub (http://127.0.0.1…) или впишите API-ключ');
      } else runApi(c, ref);
      return function stop() { ref.stopped = true; status('youtube', 'idle', ''); };
    }

    return {
      third: third,
      // Применить настройки. Перезапускается только то, что реально изменилось.
      apply: function (rawConn) {
        if (dead) return;
        var c = connFrom(rawConn);
        third.enabled = c.thirdPartyEmotes;
        if (c.thirdPartyEmotes) loadEmotes();

        var tw = normTwitch(c.twitchChannel);
        var twKey = tw || (c.twitchChannel ? '!' + c.twitchChannel : '');
        if ((cur.twitch ? cur.twitch.key : '') !== twKey) {
          if (cur.twitch) cur.twitch.stop();
          cur.twitch = null;
          if (tw) cur.twitch = { key: twKey, stop: startTwitch(tw) };
          else if (c.twitchChannel) { cur.twitch = { key: twKey, stop: function () {} }; status('twitch', 'error', 'это не похоже на логин Twitch'); }
          else status('twitch', 'idle', '');
        }
        var ytOn = !!(c.youtubeChannel || normVideoId(c.youtubeVideoIdOverride));
        var ytKey = ytOn ? JSON.stringify([c.youtubeChannel, c.youtubeMode, c.youtubeApiKey, normVideoId(c.youtubeVideoIdOverride)]) : '';
        if ((cur.youtube ? cur.youtube.key : '') !== ytKey) {
          if (cur.youtube) cur.youtube.stop();
          cur.youtube = null;
          if (ytOn) cur.youtube = { key: ytKey, stop: startYoutube(c) };
          else status('youtube', 'idle', '');
        }
      },
      // Есть ли хоть один источник (для подсказки «Укажите канал»).
      hasSource: function () { return !!(cur.twitch || cur.youtube); },
      stop: function () {
        dead = true;
        timers.forEach(clearTimeout); timers.clear();
        if (cur.twitch) cur.twitch.stop();
        if (cur.youtube) cur.youtube.stop();
        cur.twitch = cur.youtube = null;
      }
    };
  }

  var api = {
    CONN_DEFAULTS: CONN_DEFAULTS, YT_MODE_KEYLESS: YT_MODE_KEYLESS, YT_MODE_API: YT_MODE_API,
    connFrom: connFrom, normTwitch: normTwitch, normVideoId: normVideoId,
    unescapeTag: unescapeTag, parseTags: parseTags, parseBadges: parseBadges, renderParts: renderParts, parseLine: parseLine,
    Emotes: Emotes, parse7tv: parse7tv, parseBttv: parseBttv, loadGlobalEmotes: loadGlobalEmotes,
    fromYtPoll: fromYtPoll, fromYtApi: fromYtApi, createFeed: createFeed, keylessTransport: keylessTransport,
    createConnections: createConnections
  };
  root.SAHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

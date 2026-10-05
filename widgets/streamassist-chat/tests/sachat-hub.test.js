// Проверки «клея» между чатом и Hub: разбор Twitch (повторяет тесты Rust-части StreamAssist twitch.rs / emotes.rs),
// YouTube, защита от повторов и подключения на подставных сокетах. Запуск: node --test tests/  (нужен только Node 18+).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../sachat-hub.js');

const none = new H.Emotes();
const chat = (line, third) => {
  const r = H.parseLine(line, third || none, () => 777);
  assert.equal(r.t, 'chat', 'ожидалось сообщение, получено ' + JSON.stringify(r));
  return r.msg;
};
const PRIV = '@badge-info=subscriber/8;badges=broadcaster/1,subscriber/6;color=#FF4500;display-name=Fox\\sFan;emotes=25:0-4,12-16;id=msg-1;tmi-sent-ts=1700000000123;user-id=42 :foxfan!foxfan@foxfan.tmi.twitch.tv PRIVMSG #channel :Kappa hello Kappa\r\n';

test('twitch: сообщение с метками', () => {
  const m = chat(PRIV);
  assert.equal(m.platform, 'twitch'); assert.equal(m.kind, 'message');
  assert.equal(m.author, 'Fox Fan'); assert.equal(m.color, '#FF4500');
  assert.equal(m.id, 'msg-1'); assert.equal(m.ts, 1700000000123);
  assert.deepEqual(m.badges.map((b) => b.label), ['Стример', 'Подписчик']);
  assert.deepEqual(m.badges.map((b) => b.role), ['broadcaster', 'subscriber']);
  assert.equal(m.parts.length, 3);
  assert.equal(m.parts[0].text, 'Kappa'); assert.match(m.parts[0].image, /\/emoticons\/v2\/25\//);
  assert.deepEqual(m.parts[1], { text: ' hello ' });
  assert.ok(m.parts[2].image);
});

test('twitch: позиции эмоутов считаются в символах, а не в байтах', () => {
  const m = chat('@emotes=555:7-11;id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :привет Kappa\r\n');
  assert.deepEqual(m.parts[0], { text: 'привет ' });
  assert.equal(m.parts[1].text, 'Kappa'); assert.ok(m.parts[1].image);
});

test('twitch: эмоут после эмодзи не съезжает (позиции в code points, не UTF-16)', () => {
  const m = chat('@emotes=25:2-6;id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :😀 Kappa\r\n');
  assert.deepEqual(m.parts[0], { text: '😀 ' });
  assert.equal(m.parts[1].text, 'Kappa');
});

test('twitch: неверные диапазоны эмоутов игнорируются', () => {
  const m = chat('@emotes=25:50-60/x!:1-2;id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :hello\r\n');
  assert.deepEqual(m.parts, [{ text: 'hello' }]);
});

test('7TV/BTTV: заменяются только целые слова', () => {
  const third = new H.Emotes(); third.setAll({ EZ: 'https://cdn/ez' });
  const m = chat('@id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :ez EZ EZEZ EZ\r\n', third);
  assert.deepEqual(m.parts.map((p) => [p.text, !!p.image]), [['ez ', false], ['EZ', true], [' EZEZ ', false], ['EZ', true]]);
  third.enabled = false;
  assert.ok(chat('@id=m2;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :EZ\r\n', third).parts.every((p) => !p.image));
});

test('twitch: запасные значения при пустых и плохих метках', () => {
  const m = chat('@color=red;display-name=;id=x :Nick!nick@nick.tmi.twitch.tv PRIVMSG #c :hi\r\n');
  assert.equal(m.author, 'Nick'); assert.equal(m.color, null);
  assert.ok(chat('@display-name=A;tmi-sent-ts=5 :a!a@a.tmi.twitch.tv PRIVMSG #c :hi\r\n').id.length > 0);
});

test('twitch: /me (ACTION) очищается', () => {
  const m = chat('@id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :\u0001ACTION машет рукой\u0001\r\n');
  assert.deepEqual(m.parts, [{ text: 'машет рукой' }]);
});

test('twitch: разметка в тексте остаётся текстом', () => {
  const m = chat('@id=m;tmi-sent-ts=1 :u!u@u.tmi.twitch.tv PRIVMSG #c :<img src=x onerror=alert(1)>\r\n');
  assert.deepEqual(m.parts, [{ text: '<img src=x onerror=alert(1)>' }]);
});

test('twitch: действия модераторов — служебные строки', () => {
  const t = chat('@ban-duration=600;tmi-sent-ts=10 :tmi.twitch.tv CLEARCHAT #c :badguy\r\n');
  assert.equal(t.kind, 'system'); assert.equal(t.parts[0].text, 'badguy получил(а) таймаут (600 сек)');
  assert.equal(chat('@tmi-sent-ts=11 :tmi.twitch.tv CLEARCHAT #c :badguy\r\n').parts[0].text, 'badguy забанен(а)');
  assert.equal(chat('@tmi-sent-ts=12 :tmi.twitch.tv CLEARCHAT #c\r\n').parts[0].text, 'чат полностью очищен модератором');
  const d = chat('@login=spammer;target-msg-id=abc-1;tmi-sent-ts=13 :tmi.twitch.tv CLEARMSG #c :text\r\n');
  assert.equal(d.parts[0].text, 'сообщение от spammer удалено модератором'); assert.equal(d.id, 'clearmsg-abc-1');
});

test('twitch: служебные строки', () => {
  const P = (l) => H.parseLine(l, none, () => 1);
  assert.deepEqual(P(':justinfan1.tmi.twitch.tv 366 justinfan1 #c :End of /NAMES list\r\n'), { t: 'joined' });
  assert.deepEqual(P('PING :tmi.twitch.tv\r\n'), { t: 'ping', payload: ':tmi.twitch.tv' });
  assert.deepEqual(P(':tmi.twitch.tv RECONNECT\r\n'), { t: 'reconnect' });
  assert.deepEqual(P(':tmi.twitch.tv NOTICE * :Login unsuccessful\r\n'), { t: 'notice', text: 'Login unsuccessful' });
  assert.deepEqual(P(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n'), { t: 'ignore' });
  assert.deepEqual(P('@a=b\r\n'), { t: 'ignore' });
  assert.deepEqual(P(''), { t: 'ignore' });
});

test('twitch: значения меток раскодируются', () => {
  const t = H.parseTags('a=x\\sy;b=1\\:2;c=back\\\\slash;d=');
  assert.equal(t.a, 'x y'); assert.equal(t.b, '1;2'); assert.equal(t.c, 'back\\slash'); assert.equal(t.d, '');
});

test('7TV: предпочитается 2x.webp; BTTV: берутся только допустимые записи', () => {
  const m = H.parse7tv({ emotes: [
    { name: 'EZ', data: { host: { url: '//cdn.7tv.app/emote/abc', files: [{ name: '1x.webp' }, { name: '2x.avif' }, { name: '2x.webp' }, { name: '4x.webp' }] } } },
    { name: 'OnlyLast', data: { host: { url: '//cdn.7tv.app/emote/def', files: [{ name: '1x.webp' }, { name: '4x.webp' }] } } },
    { name: 'x', data: { host: { url: '//cdn/a', files: [{ name: '2x.webp' }] } } },
    { name: 'NoHost', data: {} }] });
  assert.equal(m.EZ, 'https://cdn.7tv.app/emote/abc/2x.webp');
  assert.equal(m.OnlyLast, 'https://cdn.7tv.app/emote/def/4x.webp');
  assert.ok(!('x' in m) && !('NoHost' in m));
  const b = H.parseBttv([{ code: 'catJAM', id: '5f1b0186cf6d2144653d2970' }, { code: 'bad id', id: 'zz' }, { code: 'ok', id: '../../x' }]);
  assert.equal(b.catJAM, 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/2x');
  assert.deepEqual(Object.keys(b), ['catJAM']);
});

test('YouTube (Hub): сообщение, кастомный эмодзи, суперчат, роли', () => {
  const m = H.fromYtPoll({ id: 'y1', author: 'Заяц', badges: ['owner', 'member', 'nope'], ts: 5, superchat: '500 ₽',
    runs: [{ text: 'Держи ' }, { text: ':fox:', emoji: 'https://yt3.ggpht.com/a.png' }, { text: 'x', emoji: 'http://evil/x.png' }] });
  assert.equal(m.platform, 'youtube'); assert.equal(m.kind, 'superchat'); assert.equal(m.amount, '500 ₽');
  assert.deepEqual(m.badges.map((b) => b.role), ['broadcaster', 'subscriber']);
  assert.equal(m.parts[1].image, 'https://yt3.ggpht.com/a.png');
  assert.ok(m.parts.every((p) => !p.image || p.image.startsWith('https://')));
  assert.equal(H.fromYtPoll({ author: 'a', runs: [] }), null);
  assert.equal(H.fromYtPoll(null), null);
});

test('YouTube (API): роли, суперчат, новый участник, пустые события', () => {
  const m = H.fromYtApi({ id: 'a1', snippet: { displayMessage: 'Привет', publishedAt: '2026-10-01T10:00:00Z' }, authorDetails: { displayName: 'Иван', isChatModerator: true, isVerified: true } });
  assert.equal(m.kind, 'message'); assert.equal(m.ts, Date.parse('2026-10-01T10:00:00Z'));
  assert.deepEqual(m.badges.map((b) => b.role), ['moderator', 'partner']);
  assert.equal(H.fromYtApi({ id: 'a2', snippet: { displayMessage: 'x', superChatDetails: { amountDisplayString: '$5' } }, authorDetails: {} }).kind, 'superchat');
  assert.equal(H.fromYtApi({ id: 'a3', snippet: { type: 'newSponsorEvent', displayMessage: 'Welcome' }, authorDetails: {} }).kind, 'member');
  assert.equal(H.fromYtApi({ id: 'a4', snippet: { displayMessage: '' }, authorDetails: {} }), null);
});

test('лента: повторы отбрасываются, номера растут, одинаковый id на разных площадках — разные сообщения', () => {
  const f = H.createFeed();
  const mk = (platform, id) => ({ platform, id, kind: 'message', author: 'a', parts: [{ text: 'x' }], ts: 1 });
  assert.equal(f.add(mk('twitch', '1')).seq, 1);
  assert.equal(f.add(mk('twitch', '1')), null);
  assert.equal(f.add(mk('youtube', '1')).seq, 2);
  assert.equal(f.add({ platform: 'twitch', id: '2' }), null);
});

test('настройки подключения: проверка и разбор', () => {
  const c = H.connFrom({ twitchChannel: ' Foo\u0000 ', youtubeApiKey: 'AIza-_x<script>', youtubeMode: 'чужое', thirdPartyEmotes: 'false' });
  assert.equal(c.twitchChannel, 'Foo'); assert.equal(c.youtubeApiKey, 'AIza-_xscript');
  assert.equal(c.youtubeMode, H.YT_MODE_KEYLESS); assert.equal(c.thirdPartyEmotes, false);
  assert.equal(H.connFrom(null).thirdPartyEmotes, true);
  assert.equal(H.normTwitch('https://www.twitch.tv/Some_Name?x=1'), 'some_name');
  assert.equal(H.normTwitch('#foo'), 'foo'); assert.equal(H.normTwitch('bad name!'), ''); assert.equal(H.normTwitch(''), '');
  assert.equal(H.normVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5'), 'dQw4w9WgXcQ');
  assert.equal(H.normVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(H.normVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

// ——— Подключения на подставных сокетах ———
function fakeEnv() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { this.sent.push(s); }
    close() { if (this.closed) return; this.closed = true; this.onclose && this.onclose(); }
    push(text) { this.onmessage && this.onmessage({ data: text }); }
  }
  return { sockets, env: { WebSocket: FakeWS, now: Date.now, tauriInvoke: () => null, location: { protocol: 'file:', hostname: '' },
    fetchTimeout: () => Promise.reject(new Error('нет сети')) } };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

test('подключения: Twitch входит анонимно, отдаёт сообщения, отвечает на PING, не дублирует', async () => {
  const { sockets, env } = fakeEnv();
  const got = [], st = [];
  const c = H.createConnections(env, { onMessage: (m) => got.push(m), onStatus: (p, s, t) => st.push([p, s, t]) });
  c.apply({ twitchChannel: 'https://twitch.tv/MyChan', thirdPartyEmotes: false });
  await tick();
  const ws = sockets[0];
  assert.equal(ws.url, 'wss://irc-ws.chat.twitch.tv:443');
  assert.ok(ws.sent.includes('JOIN #mychan')); assert.ok(ws.sent.some((s) => /^NICK justinfan\d+$/.test(s)));
  assert.ok(ws.sent.includes('CAP REQ :twitch.tv/tags twitch.tv/commands'));
  ws.push(':justinfan1.tmi.twitch.tv 366 justinfan1 #mychan :End of /NAMES list\r\nPING :tmi.twitch.tv\r\n');
  assert.ok(ws.sent.includes('PONG :tmi.twitch.tv'));
  assert.deepEqual(st.filter((x) => x[1] === 'connected'), [['twitch', 'connected', '#mychan']]);
  ws.push(PRIV + PRIV);
  assert.equal(got.length, 1, 'повтор должен отсекаться'); assert.equal(got[0].seq, 1); assert.equal(got[0].author, 'Fox Fan');
  c.apply({ twitchChannel: 'mychan', thirdPartyEmotes: false });     // то же самое — не переподключаться
  await tick(); assert.equal(sockets.length, 1);
  c.apply({ twitchChannel: 'other', thirdPartyEmotes: false });      // другой канал — новое соединение
  await tick(); assert.equal(sockets.length, 2); assert.ok(ws.closed);
  c.apply({ twitchChannel: '' });
  await tick(); assert.ok(sockets[1].closed);
  c.stop();
});

test('подключения: после обрыва Twitch переподключается, а после stop() — нет', async () => {
  const { sockets, env } = fakeEnv();
  const c = H.createConnections(env, { onMessage() {}, onStatus() {} });
  c.apply({ twitchChannel: 'abc', thirdPartyEmotes: false });
  await tick();
  sockets[0].close();
  await tick(1100);
  assert.equal(sockets.length, 2, 'ждём новое соединение через ~1 с');
  c.stop();
  sockets[1].close();
  await tick(1200);
  assert.equal(sockets.length, 2);
});

test('подключения: непохожий на логин текст — понятная ошибка, а не подключение', async () => {
  const { sockets, env } = fakeEnv();
  const st = [];
  const c = H.createConnections(env, { onMessage() {}, onStatus: (p, s, t) => st.push([p, s, t]) });
  c.apply({ twitchChannel: 'не логин!', thirdPartyEmotes: false });
  await tick();
  assert.equal(sockets.length, 0); assert.ok(st.some((x) => x[0] === 'twitch' && x[1] === 'error'));
  c.stop();
});

test('подключения: YouTube без ключа читает ответы Hub, сообщения со своим номером; на ошибке сети переходит на ключ', async () => {
  const polls = [];
  const env = { WebSocket: function () {}, now: Date.now, tauriInvoke: () => (cmd, args) => {
    polls.push([cmd, args]);
    return Promise.resolve({ state: 'connected', message: 'эфир abc', next: polls.length, messages: [{ id: 'y' + polls.length, author: 'Зритель', runs: [{ text: 'привет' }], badges: [], ts: 1 }] });
  }, location: { protocol: 'file:', hostname: '' }, fetchTimeout: () => Promise.reject(new Error('нет сети')) };
  const got = [], st = [];
  const c = H.createConnections(env, { onMessage: (m) => got.push(m), onStatus: (p, s, t) => st.push([p, s, t]) });
  c.apply({ youtubeChannel: '@kanal', thirdPartyEmotes: false });
  await tick(20);
  assert.equal(polls[0][0], 'yt_chat_poll'); assert.deepEqual(polls[0][1], { channel: '@kanal', videoId: '', since: 0 });
  assert.equal(got[0].platform, 'youtube'); assert.equal(got[0].parts[0].text, 'привет');
  assert.ok(st.some((x) => x[0] === 'youtube' && x[1] === 'connected'));
  c.stop();
});

test('подключения: YouTube без ключа вне Hub честно говорит, что делать', async () => {
  const st = [];
  const env = { WebSocket: function () {}, now: Date.now, tauriInvoke: () => null, location: { protocol: 'file:', hostname: '' }, fetchTimeout: () => Promise.reject(new Error('x')) };
  const c = H.createConnections(env, { onMessage() {}, onStatus: (p, s, t) => st.push([p, s, t]) });
  c.apply({ youtubeChannel: '@kanal', thirdPartyEmotes: false });
  assert.ok(st.some((x) => x[0] === 'youtube' && x[1] === 'error' && /Hub/.test(x[2])));
  c.apply({ youtubeChannel: '@kanal', youtubeMode: H.YT_MODE_API, thirdPartyEmotes: false });
  assert.ok(st.some((x) => x[0] === 'youtube' && x[1] === 'error' && /API-ключ/.test(x[2])));
  c.stop();
});

test('локальный сервер Hub: адрес запроса собирается правильно', async () => {
  let asked = '';
  const env = { WebSocket: function () {}, now: Date.now, tauriInvoke: () => null, location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:47821' },
    fetchTimeout: (url) => { asked = url; return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: 'offline', message: 'эфира нет', next: 0, messages: [] }) }); } };
  const c = H.createConnections(env, { onMessage() {}, onStatus() {} });
  c.apply({ youtubeChannel: '@k b', youtubeVideoIdOverride: 'https://youtu.be/dQw4w9WgXcQ', thirdPartyEmotes: false });
  await tick(20);
  assert.equal(asked, 'http://127.0.0.1:47821/api/yt/poll?channel=%40k%20b&video=dQw4w9WgXcQ&since=0');
  c.stop();
});

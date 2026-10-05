// Проверки общего формата стиля и виджета «Чат». Запуск: npm run test:js (нужен только Node 18+).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SAW = require('../wstyle.js');
const chat = require('../wchat.js');
const def = SAW.get('chat');
const S = chat.schema;
const D = SAW.defaults(S);

test('схема: ключи уникальны, умолчания внутри допустимого, список разрешён', () => {
  const seen = new Set();
  SAW.allFields(S).forEach((f) => {
    assert.ok(!seen.has(f.key), 'повтор ключа ' + f.key); seen.add(f.key);
    if (f.type === 'num') assert.ok(f.def >= f.min && f.def <= f.max, f.key + ': умолчание вне диапазона');
    if (f.type === 'select') assert.ok(f.options.some((o) => o[0] === f.def), f.key + ': умолчания нет в списке');
    if (f.type === 'color') assert.match(f.def, /^#[0-9a-f]{6}$/);
    assert.doesNotThrow(() => SAW.fieldVisible(f, D));
  });
  assert.ok(S.sections.some((s) => s.lvl === 'g') && S.sections.some((s) => s.lvl === 'a'));
});

test('clean: число в диапазон, цвет только #RRGGBB, список только из разрешённых, лишнее выбрасывается', () => {
  const c = SAW.clean(S, { fs: 9999, gap: -5, textColor: 'red;}body{x:y', ac: '#ABCDEF', layout: 'evil', hack: 1, bots: '1', adur: 'abc' });
  assert.equal(c.fs, 72); assert.equal(c.gap, 0);
  assert.equal(c.textColor, D.textColor); assert.equal(c.ac, '#abcdef');
  assert.equal(c.layout, D.layout); assert.equal(c.bots, true); assert.equal(c.adur, D.adur);
  assert.equal(c.hack, undefined);
});

test('clean: шаг 0.1 / 0.05 округляется, текст без < > и управляющих символов', () => {
  const c = SAW.clean(S, { nameLs: 1.2345, lh: 1.2345, blockNames: 'a<b>\u0000c' });
  assert.equal(c.nameLs, 1.2); assert.equal(c.lh, 1.25); assert.equal(c.blockNames, 'abc');
});

test('diff / exportDoc / importDoc: туда и обратно, лишнего не тянут', () => {
  const doc = SAW.exportDoc('chat', S, { fs: 22, bxFillType: 'gradient', unknown: 5 });
  assert.equal(doc.format, 'sa-widget-style'); assert.deepEqual(doc.values, { fs: 22, bxFillType: 'gradient' });
  const r = SAW.importDoc('chat', S, JSON.stringify(doc));
  assert.ok(r.ok); assert.deepEqual(r.values, doc.values);
});

test('importDoc: понятные ошибки', () => {
  assert.equal(SAW.importDoc('chat', S, 'не json').ok, false);
  assert.match(SAW.importDoc('chat', S, '{"a":1}').error, /не стиль/);
  assert.match(SAW.importDoc('chat', S, { format: 'sa-widget-style', v: 1, widget: 'music', values: {} }).error, /другого виджета/);
  assert.match(SAW.importDoc('chat', S, { format: 'sa-widget-style', v: 99, widget: 'chat', values: {} }).error, /новой версии/);
  assert.equal(SAW.importDoc('chat', S, 'x'.repeat(200001)).ok, false);
});

test('безопасность: вредный текст во всех полях не попадает в CSS-переменные', () => {
  const evil = '";}</style><script>alert(1)</script>url(http://x)\u0000';
  const raw = {};
  SAW.allFields(S).forEach((f) => { raw[f.key] = f.type === 'bool' ? true : evil; });
  raw.ff = 'custom'; raw.ffCustom = evil;
  const { vars } = chat.compile(raw);
  Object.entries(vars).forEach(([k, val]) => {
    assert.ok(!/[<>]|url\(|;|}/.test(val), k + ' = ' + val);
  });
  assert.ok(vars['--ff'].startsWith('"'), 'свой шрифт идёт в кавычках');
});

test('compile: градиент, углы по отдельности, тени, масштаб', () => {
  const a = chat.compile({ bxFillType: 'gradient', bxFill: '#000000', bxFill2: '#ffffff', bxAngle: 45, bxFillOp: 50 }).vars;
  assert.equal(a['--bg'], 'linear-gradient(45deg,rgba(0,0,0,0.5),rgba(255,255,255,0.5))');
  const b = chat.compile({ bxREach: true, bxRtl: 1, bxRtr: 2, bxRbr: 3, bxRbl: 4 }).vars;
  assert.equal(b['--rad'], '1px 2px 3px 4px');
  const c = chat.compile({ bxShOn: true, bxInOn: true }).vars;
  assert.equal(c['--shadow'].split('),').length, 2);
  assert.equal(chat.compile({ bxFillType: 'none' }).vars['--bg'], 'transparent');
  const k = chat.compile({ scale: 200, fs: 20, gap: 8 }).vars;
  assert.equal(k['--fs'], '40px'); assert.equal(k['--gap'], '16px');
  assert.equal(chat.compile({ bxBw: 0 }).vars['--bd'], 'none');
});

test('compile: размытие фона только в окне программы, в OBS его нет', () => {
  assert.equal(chat.compile({ bxBlur: 12 }, { mode: 'obs' }).vars['--blur'], 'none');
  assert.equal(chat.compile({ bxBlur: 12 }).vars['--blur'], 'none');
  assert.equal(chat.compile({ bxBlur: 12 }, { mode: 'app' }).vars['--blur'], 'blur(12px)');
});

test('accept: боты, команды, площадка, системные строки, чёрный список', () => {
  const v = SAW.clean(S, { blockNames: 'Spammer' });
  const m = (o) => Object.assign({ platform: 'twitch', kind: 'chat', author: 'u', parts: [{ text: 'привет' }] }, o);
  assert.equal(chat.accept(m({}), v), true);
  assert.equal(chat.accept(m({ author: 'NightBot' }), v), false);
  assert.equal(chat.accept(m({ author: 'NightBot' }), SAW.clean(S, { bots: false })), true);
  assert.equal(chat.accept(m({ parts: [{ text: '!song x' }] }), v), false);
  assert.equal(chat.accept(m({ kind: 'superchat', parts: [{ text: '!x' }] }), v), true);
  assert.equal(chat.accept(m({ platform: 'youtube' }), SAW.clean(S, { src: 'twitch' })), false);
  assert.equal(chat.accept(m({ kind: 'system' }), v), false);
  assert.equal(chat.accept(m({ kind: 'system' }), SAW.clean(S, { showSys: true })), true);
  assert.equal(chat.accept(m({ author: 'spammer' }), v), false);
  assert.equal(chat.accept({ author: 'x' }, v), false);
});

test('готовые стили: все значения допустимы и ничего не теряется при очистке', () => {
  chat.presets.forEach((p) => {
    const c = SAW.clean(S, p.values);
    Object.keys(p.values).forEach((k) => {
      assert.ok(k in D, p.id + ': неизвестный ключ ' + k);
      assert.deepEqual(c[k], p.values[k], p.id + ': ' + k + ' изменилось при очистке');
    });
  });
});

test('applyPreset: фильтры и масштаб остаются, оформление заменяется', () => {
  const cur = { bots: false, max: 5, scale: 150, fs: 40, bxBw: 4 };
  const out = SAW.applyPreset(def, cur, chat.presets.find((p) => p.id === 'glass'));
  assert.equal(out.bots, false); assert.equal(out.max, 5); assert.equal(out.scale, 150);
  assert.equal(out.fs, 15); assert.equal(out.bxBw, 1);
});

test('migrate: старые настройки чата переносятся', () => {
  const m = def.migrate({ sz: 120, ac: 'Фиолетовый', bots: 1 });
  assert.equal(m.scale, 120); assert.equal(m.ac, '#8b5cf6'); assert.equal(m.sz, undefined);
  assert.equal(SAW.clean(S, m).bots, true);
});

test('register: повтор ключа — ошибка', () => {
  const F = SAW.F;
  assert.throws(() => SAW.register({ id: 'x', schema: { sections: [F.section('g', 'a', 'A', [F.bool('k', 'k', 1), F.bool('k', 'k', 1)])] } }), /повторяется/);
});

test('forKind: слой «Чат» находит описание виджета', () => {
  assert.equal(SAW.forKind('Чат').id, 'chat'); assert.equal(SAW.forKind('Часы'), null);
});

test('значки: «авто» следуют выравниванию блоков, ручной выбор не зависит от него', () => {
  const side = (o) => { const c = chat.compile(o).values; return [c.mSideR, c.bdPosR]; };
  assert.deepEqual(side({ align: 'left' }), ['left', 'before']);
  assert.deepEqual(side({ align: 'center' }), ['left', 'before']);
  assert.deepEqual(side({ align: 'right' }), ['right', 'after']);
  assert.deepEqual(side({ align: 'left', mSide: 'right', bdPos: 'after' }), ['right', 'after']);
  assert.deepEqual(side({ align: 'right', mSide: 'left', bdPos: 'before' }), ['left', 'before']);
});

test('все готовые стили задают сторону и положение значков одинаково явно', () => {
  chat.presets.forEach((p) => {
    ['mSide', 'mAlign', 'bdPos'].forEach((k) => assert.ok(k in p.values, p.id + ': нет ' + k));
    assert.equal(p.values.mSide, 'auto'); assert.equal(p.values.bdPos, 'auto');
  });
});

test('«Общие»: вид блока (заливка, рамка, углы, тень, подсветка), значок площадки и значки ролей — целиком в одной вкладке', () => {
  const tab = (id) => S.sections.find((s) => s.id === id).lvl;
  ['bxFill', 'bxBorder', 'bxCorners', 'bxShadow', 'bxInner', 'media', 'badges'].forEach((id) => assert.equal(tab(id), 'g', id));
  // отступы внутри блока и размытие фона (в OBS не работает) — редкие, живут в «Расширенных»
  ['bxPad', 'bxBlur'].forEach((id) => assert.equal(tab(id), 'a', id));
  // из остального в «Расширенных» не осталось ни одной настройки фона, рамки, тени, значка площадки или значков ролей
  S.sections.filter((s) => s.lvl === 'a').forEach((s) => s.fields.forEach((f) => {
    if (/^bx(Pt|Pr|Pb|Pl|Blur)$/.test(f.key)) return;
    assert.ok(!/^(bx|m[A-Z]|bd|bc[A-Z])/.test(f.key), 'в «Расширенных» осталось ' + f.key);
  }));
});

test('«Общие»: шрифт, ник, время, платные сообщения и действия модераторов — рядом со своими переключателями', () => {
  const sec = (id) => S.sections.find((s) => s.id === id);
  const where = (key) => S.sections.find((s) => s.fields.some((f) => f.key === key));
  ['ff', 'fw', 'fs', 'textColor'].forEach((k) => assert.equal(where(k).lvl, 'g', k));
  ['nameLine', 'nameColorMode', 'nameSize', 'nameCase'].forEach((k) => assert.equal(where(k).lvl, 'g', k));
  // переключатель и его настройки — в одном разделе, а не в разных вкладках
  assert.equal(where('showTime'), where('tmFmt'));
  assert.equal(where('showSys'), where('sysColor'));
  assert.equal(where('paidOn'), where('paidFill'));
  assert.equal(sec('sys').lvl, 'g'); assert.equal(sec('time').lvl, 'g'); assert.equal(sec('paid').lvl, 'g');
});

test('значки ролей: по умолчанию картинки; ведущий модератор не дублируется модератором; у остальных ролей запасной значок', () => {
  assert.equal(D.bdStyle, 'image');
  chat.presets.forEach((p) => assert.ok(!('bdStyle' in p.values), p.id + ': вид значков должен быть общим'));
  assert.equal(S.sections.find((s) => s.id === 'badges').fields.find((f) => f.key === 'bdStyle').options.some((o) => o[0] === 'icon'), true);
});

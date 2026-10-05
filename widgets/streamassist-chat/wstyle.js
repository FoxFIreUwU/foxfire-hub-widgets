/* wstyle.js — ОБЩИЙ ФОРМАТ СТИЛЯ ВИДЖЕТОВ (SAW, версия 1).
   Один и тот же файл работает и в окне программы (предпросмотр, панель настроек),
   и в оверлее для OBS. Здесь нет ни Tauri, ни сети, ни обращений к странице:
   только описание настроек (схема), проверка значений и перенос стиля в JSON.

   Как устроен формат (подробно — docs/WIDGET_FORMAT.md):
     • Виджет описывается СХЕМОЙ: список разделов, в каждом — поля (число, цвет, список…).
       Каждый раздел лежит либо в группе «Общие» (lvl 'g'), либо в «Расширенные» (lvl 'a').
     • Значения виджета — плоский объект { ключ: значение }. Хранятся только отличия от
       значений по умолчанию, поэтому старые сохранения не ломаются при добавлении полей.
     • clean() приводит любые чужие значения к безопасным: число — в пределах min…max,
       цвет — только #RRGGBB, список — только из разрешённых вариантов, текст — без
       управляющих символов. Так импортированный пресет не может внести чужой CSS.
     • Виджет = { id, name, v, schema, presets, ... } регистрируется через SAW.register().
   Общие «кирпичики» (SAW.blocks) — одинаковые разделы для всех виджетов: блок-подложка
   (заливка, рамка, углы, тень, отступы), текст, значок/аватар. Новый виджет берёт их готовыми. */
(function (root) {
  'use strict';

  var FORMAT = 'sa-widget-style';
  var VERSION = 1;
  var HEX6 = /^#[0-9a-fA-F]{6}$/;
  var widgets = {}, kinds = {};

  // ——— Поля ———————————————————————————————————————————————————————————————
  // Каждое поле: { key, label, type: num|color|select|bool|text, def, ... , when(values) }
  function num(key, label, def, min, max, o) {
    o = o || {};
    return { key: key, label: label, type: 'num', def: def, min: min, max: max,
      step: o.step || 1, unit: o.unit || '', hint: o.hint || '', when: o.when || null };
  }
  function color(key, label, def, o) {
    o = o || {};
    return { key: key, label: label, type: 'color', def: def, hint: o.hint || '', when: o.when || null };
  }
  function select(key, label, def, options, o) {
    o = o || {};
    return { key: key, label: label, type: 'select', def: def, options: options, hint: o.hint || '', when: o.when || null };
  }
  function bool(key, label, def, o) {
    o = o || {};
    return { key: key, label: label, type: 'bool', def: !!def, hint: o.hint || '', when: o.when || null };
  }
  function text(key, label, def, o) {
    o = o || {};
    return { key: key, label: label, type: 'text', def: def, max: o.max || 200, multi: !!o.multi,
      hint: o.hint || '', when: o.when || null };
  }
  function section(lvl, id, title, fields, o) {
    return { lvl: lvl, id: id, title: title, fields: fields, hint: (o && o.hint) || '', closed: !!(o && o.closed) };
  }

  // ——— Работа со схемой ———————————————————————————————————————————————————
  function allFields(schema) {
    var out = [];
    schema.sections.forEach(function (s) { s.fields.forEach(function (f) { out.push(f); }); });
    return out;
  }
  function defaults(schema) {
    var d = {};
    allFields(schema).forEach(function (f) { d[f.key] = f.def; });
    return d;
  }
  function cleanText(s, max) {
    // без управляющих символов; < и > тоже убираем — в разметку этот текст не попадает,
    // но так проще убедиться, что он безопасен везде
    return String(s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max);
  }
  function cleanOne(f, raw) {
    if (raw === undefined || raw === null) return f.def;
    switch (f.type) {
      case 'num': {
        var n = typeof raw === 'number' ? raw : parseFloat(raw);
        if (!isFinite(n)) return f.def;
        n = Math.min(f.max, Math.max(f.min, n));
        var st = f.step < 1 ? 1 / f.step : 1;      // шаг 0.1 → округляем до десятых
        return Math.round(n * st) / st;
      }
      case 'color': return typeof raw === 'string' && HEX6.test(raw) ? raw.toLowerCase() : f.def;
      case 'bool': return raw === true || raw === 1 || raw === '1' || raw === 'true';
      case 'select': {
        var ok = f.options.some(function (o) { return o[0] === raw; });
        return ok ? raw : f.def;
      }
      case 'text': return typeof raw === 'string' ? cleanText(raw, f.max) : f.def;
    }
    return f.def;
  }
  // Полный набор значений: всё, чего нет или что испорчено, берётся по умолчанию.
  function clean(schema, raw) {
    var out = {};
    raw = raw && typeof raw === 'object' ? raw : {};
    allFields(schema).forEach(function (f) { out[f.key] = cleanOne(f, raw[f.key]); });
    return out;
  }
  // Только отличия от умолчаний — именно это хранится и переносится.
  function diff(schema, values) {
    var out = {};
    allFields(schema).forEach(function (f) {
      var v = values[f.key];
      if (v !== undefined && v !== f.def) out[f.key] = v;
    });
    return out;
  }
  function fieldVisible(f, values) {
    try { return !f.when || !!f.when(values); } catch (e) { return true; }
  }

  // ——— Перенос стиля (JSON) ———————————————————————————————————————————————
  function exportDoc(id, schema, values) {
    return { format: FORMAT, v: VERSION, widget: id, values: diff(schema, clean(schema, values)) };
  }
  // Возвращает { ok:true, values } или { ok:false, error } (текст ошибки — для пользователя).
  function importDoc(id, schema, textOrObj) {
    var doc = textOrObj;
    if (typeof textOrObj === 'string') {
      if (textOrObj.length > 200000) return { ok: false, error: 'Текст слишком большой для стиля' };
      try { doc = JSON.parse(textOrObj); } catch (e) { return { ok: false, error: 'Это не JSON: проверьте, что скопирован весь текст стиля' }; }
    }
    if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) return { ok: false, error: 'Это не стиль виджета StreamAssist' };
    if (doc.widget !== id) return { ok: false, error: 'Этот стиль сделан для другого виджета («' + cleanText(doc.widget, 40) + '»)' };
    if (typeof doc.v !== 'number' || doc.v > VERSION) return { ok: false, error: 'Стиль сделан в более новой версии программы' };
    return { ok: true, values: diff(schema, clean(schema, doc.values)) };
  }

  // ——— Цвета и числа для CSS ——————————————————————————————————————————————
  function rgba(hex, alphaPct) {
    var h = HEX6.test(hex) ? hex : '#000000';
    var a = Math.min(100, Math.max(0, +alphaPct));
    if (!isFinite(a)) a = 100;
    return 'rgba(' + parseInt(h.slice(1, 3), 16) + ',' + parseInt(h.slice(3, 5), 16) + ',' +
      parseInt(h.slice(5, 7), 16) + ',' + (Math.round(a * 10) / 1000) + ')';
  }
  // Безопасное имя шрифта из свободного поля: буквы, цифры, пробел, дефис.
  function fontName(s) {
    var n = String(s || '').replace(/[^\p{L}\p{N} \-]/gu, '').trim().slice(0, 60);
    return n;
  }

  // ——— Общие разделы-«кирпичики» ——————————————————————————————————————————
  // p — префикс ключей, чтобы у разных частей одного виджета не было совпадений.
  var blocks = {
    // Подложка: заливка, рамка, углы, тень, внутренняя подсветка, отступы, размытие.
    box: function (p, d) {
      d = d || {};
      return [
        section('a', p + 'Fill', 'Заливка', [
          select(p + 'FillType', 'Тип заливки', d.fillType || 'solid', [['solid', 'Цвет'], ['gradient', 'Градиент'], ['none', 'Без заливки']]),
          color(p + 'Fill', 'Цвет', d.fill || '#0b0b10'),
          color(p + 'Fill2', 'Второй цвет градиента', d.fill2 || '#1d4fd8', { when: function (v) { return v[p + 'FillType'] === 'gradient'; } }),
          num(p + 'Angle', 'Угол градиента', d.angle === undefined ? 90 : d.angle, 0, 360, { unit: '°', when: function (v) { return v[p + 'FillType'] === 'gradient'; } }),
          num(p + 'FillOp', 'Непрозрачность', d.fillOp === undefined ? 85 : d.fillOp, 0, 100, { unit: '%' })
        ]),
        section('a', p + 'Border', 'Рамка', [
          num(p + 'Bw', 'Толщина', d.bw || 0, 0, 16, { unit: 'px', step: 0.5 }),
          color(p + 'Bc', 'Цвет', d.bc || '#ffffff'),
          num(p + 'Bop', 'Непрозрачность', d.bop === undefined ? 30 : d.bop, 0, 100, { unit: '%' }),
          select(p + 'Bs', 'Линия', d.bs || 'solid', [['solid', 'Сплошная'], ['dashed', 'Штрихи'], ['dotted', 'Точки'], ['double', 'Двойная (от 3 px)']])
        ]),
        section('a', p + 'Corners', 'Углы', [
          bool(p + 'REach', 'Каждый угол отдельно', !!d.rEach),
          num(p + 'R', 'Скругление', d.r === undefined ? 16 : d.r, 0, 120, { unit: 'px', when: function (v) { return !v[p + 'REach']; } }),
          num(p + 'Rtl', 'Левый верхний', d.r === undefined ? 16 : d.r, 0, 120, { unit: 'px', when: function (v) { return !!v[p + 'REach']; } }),
          num(p + 'Rtr', 'Правый верхний', d.r === undefined ? 16 : d.r, 0, 120, { unit: 'px', when: function (v) { return !!v[p + 'REach']; } }),
          num(p + 'Rbr', 'Правый нижний', d.r === undefined ? 16 : d.r, 0, 120, { unit: 'px', when: function (v) { return !!v[p + 'REach']; } }),
          num(p + 'Rbl', 'Левый нижний', d.r === undefined ? 16 : d.r, 0, 120, { unit: 'px', when: function (v) { return !!v[p + 'REach']; } })
        ]),
        section('a', p + 'Shadow', 'Тень', [
          bool(p + 'ShOn', 'Включить тень', !!d.shOn),
          num(p + 'ShX', 'Сдвиг по горизонтали', 0, -60, 60, { unit: 'px', when: function (v) { return !!v[p + 'ShOn']; } }),
          num(p + 'ShY', 'Сдвиг по вертикали', 6, -60, 60, { unit: 'px', when: function (v) { return !!v[p + 'ShOn']; } }),
          num(p + 'ShBlur', 'Размытие', 18, 0, 120, { unit: 'px', when: function (v) { return !!v[p + 'ShOn']; } }),
          num(p + 'ShSpread', 'Растяжение', 0, -40, 80, { unit: 'px', when: function (v) { return !!v[p + 'ShOn']; } }),
          color(p + 'ShColor', 'Цвет', '#000000', { when: function (v) { return !!v[p + 'ShOn']; } }),
          num(p + 'ShOp', 'Непрозрачность', 45, 0, 100, { unit: '%', when: function (v) { return !!v[p + 'ShOn']; } })
        ]),
        section('a', p + 'Inner', 'Подсветка внутри (эффект стекла)', [
          bool(p + 'InOn', 'Включить', !!d.inOn),
          color(p + 'InColor', 'Цвет', '#ffffff', { when: function (v) { return !!v[p + 'InOn']; } }),
          num(p + 'InOp', 'Непрозрачность', 18, 0, 100, { unit: '%', when: function (v) { return !!v[p + 'InOn']; } }),
          num(p + 'InY', 'Сдвиг по вертикали', 1, -30, 30, { unit: 'px', when: function (v) { return !!v[p + 'InOn']; } }),
          num(p + 'InBlur', 'Размытие', 0, 0, 60, { unit: 'px', when: function (v) { return !!v[p + 'InOn']; } }),
          num(p + 'InSpread', 'Растяжение', 0, -20, 30, { unit: 'px', when: function (v) { return !!v[p + 'InOn']; } })
        ], { hint: 'Светлая кромка внутри блока: заменяет размытие фона, которое в OBS не работает.' }),
        section('a', p + 'Pad', 'Отступы внутри блока', [
          num(p + 'Pt', 'Сверху', d.pt === undefined ? 8 : d.pt, 0, 120, { unit: 'px' }),
          num(p + 'Pr', 'Справа', d.pr === undefined ? 14 : d.pr, 0, 120, { unit: 'px' }),
          num(p + 'Pb', 'Снизу', d.pb === undefined ? 8 : d.pb, 0, 120, { unit: 'px' }),
          num(p + 'Pl', 'Слева', d.pl === undefined ? 14 : d.pl, 0, 120, { unit: 'px' })
        ]),
        section('a', p + 'Blur', 'Размытие фона', [
          num(p + 'Blur', 'Сила размытия', 0, 0, 40, { unit: 'px' })
        ], { hint: 'В OBS размытие фона рисует чёрный блок (ошибка OBS), поэтому в оверлее и в предпросмотре оно не применяется. Используется только в окне программы.' })
      ];
    }
  };

  // ——— Реестр виджетов ————————————————————————————————————————————————————
  // def: { id, name, v, schema:{ sections:[…] }, presets:[{id,name,values}], … }
  function register(def) {
    if (!def || !def.id || !def.schema || !def.schema.sections) throw new Error('SAW.register: нужен id и schema');
    var ids = {};
    allFields(def.schema).forEach(function (f) {
      if (ids[f.key]) throw new Error('SAW.register: ключ «' + f.key + '» повторяется в виджете ' + def.id);
      ids[f.key] = 1;
    });
    widgets[def.id] = def;
    if (def.kind) kinds[def.kind] = def.id;
    return def;
  }
  // Применить готовый стиль: всё оформление сбрасывается к умолчанию и заменяется стилем,
  // а «настройки поведения» (def.keep — фильтры, число сообщений, масштаб) остаются как были.
  function applyPreset(def, current, preset) {
    var out = {};
    (def.keep || []).forEach(function (k) { if (current && current[k] !== undefined) out[k] = current[k]; });
    var over = diff(def.schema, clean(def.schema, preset.values));
    Object.keys(over).forEach(function (k) { if ((def.keep || []).indexOf(k) < 0) out[k] = over[k]; });
    return out;
  }

  root.SAW = {
    FORMAT: FORMAT, VERSION: VERSION,
    F: { num: num, color: color, select: select, bool: bool, text: text, section: section },
    blocks: blocks,
    allFields: allFields, defaults: defaults, clean: clean, diff: diff, fieldVisible: fieldVisible,
    exportDoc: exportDoc, importDoc: importDoc,
    rgba: rgba, fontName: fontName, cleanText: cleanText,
    register: register, applyPreset: applyPreset,
    forKind: function (k) { return widgets[kinds[k]] || null; },
    get: function (id) { return widgets[id] || null; },
    has: function (id) { return !!widgets[id]; },
    list: function () { return Object.keys(widgets); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SAW;
})(typeof window !== 'undefined' ? window : globalThis);

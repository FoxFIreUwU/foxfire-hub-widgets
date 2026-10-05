/* wpanel.js — панель настроек для ЛЮБОГО виджета на общем формате (wstyle.js).
   Сама ничего не знает о конкретных виджетах: строит вкладки «Общие / Расширенные», разделы,
   поля, поиск, сброс и перенос стиля из его схемы. Только окно программы (в оверлее не нужен).
   Текст полей ставится через textContent, значения проходят SAW.clean — разметка не вставляется.

   Использование: SAW.panel.mount(контейнер, описание виджета, ctl), где ctl — связь с хранилищем:
     ctl.get()            → текущие значения (объект, хранит только отличия от умолчаний)
     ctl.set(patch, tag)  → записать поля (tag нужен «отмене», чтобы склеивать правки одного поля)
     ctl.del(keys, tag)   → вернуть поля к умолчанию
     ctl.preset(preset)   → применить готовый стиль
     ctl.replace(values)  → заменить значения целиком (импорт) */
(function (root) {
  'use strict';
  var SAW = root.SAW;

  function h(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function fmt(n) { return String(Math.round(n * 100) / 100); }

  function mount(box, def, ctl) {
    var schema = def.schema;
    var ui = { tab: 'g', q: '', open: {}, note: '', exportText: '' };
    var HINT_OPEN = { g: true, a: false };

    function vals() { return SAW.clean(schema, ctl.get()); }
    function raw() { return ctl.get() || {}; }

    // Перерисовка может вызваться снова изнутри себя: когда сфокусированное поле убирается со страницы,
    // оно теряет фокус и успевает отправить своё «change». Поэтому: фокус снимаем заранее,
    // а повторный вызов во время сборки откладываем до её конца.
    var busy = false, again = false;
    function render() {
      if (busy) { again = true; return; }
      var a = document.activeElement;
      if (a && a !== document.body && box.contains(a) && a.className !== 'wp-q' && a.blur) a.blur();
      busy = true;
      try { build(); } finally { busy = false; }
      if (again) { again = false; render(); }
    }
    function build() {
      var v = vals(), rawv = raw();
      var root = h('div', 'wp');

      // готовые стили
      if (def.presets && def.presets.length) {
        var pr = h('div', 'wp-pre');
        pr.appendChild(h('div', 'wp-t', 'Готовые стили'));
        var row = h('div', 'wp-prow');
        def.presets.forEach(function (p) {
          var b = h('button', 'wp-pb', p.name);
          b.type = 'button';
          b.title = 'Заменит оформление. Фильтры и число сообщений останутся.';
          b.onclick = function () { ctl.preset(p); ui.note = 'Применён стиль «' + p.name + '»'; render(); };
          row.appendChild(b);
        });
        pr.appendChild(row);
        root.appendChild(pr);
      }

      // вкладки + поиск
      var tabs = h('div', 'seg wp-tabs');
      [['g', 'Общие'], ['a', 'Расширенные']].forEach(function (t) {
        var b = h('button', ui.tab === t[0] && !ui.q ? 'on' : '', t[1]);
        b.type = 'button';
        b.onclick = function () { ui.tab = t[0]; ui.q = ''; render(); };
        tabs.appendChild(b);
      });
      root.appendChild(tabs);
      var sr = h('input', 'wp-q'); sr.type = 'search'; sr.placeholder = 'Найти настройку…'; sr.value = ui.q;
      sr.setAttribute('aria-label', 'Найти настройку');
      sr.oninput = function () { ui.q = sr.value.trim().toLowerCase(); var pos = sr.selectionStart; render(); var n = root.parentNode && root.parentNode.querySelector('.wp-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* поле не поддерживает выделение */ } } };
      root.appendChild(sr);
      if (ui.tab === 'a' && !ui.q) root.appendChild(h('p', 'mu wp-lead', 'Здесь можно настроить каждый пиксель: рамку, углы, тени, отступы, шрифты, значки.'));

      // разделы
      var shown = 0;
      schema.sections.forEach(function (s) {
        if (!ui.q && s.lvl !== ui.tab) return;
        var fields = s.fields.filter(function (f) {
          if (ui.q) return f.label.toLowerCase().indexOf(ui.q) >= 0 || s.title.toLowerCase().indexOf(ui.q) >= 0;
          return SAW.fieldVisible(f, v);
        });
        if (!fields.length) return;
        shown++;
        var d = h('details', 'wp-sec');
        d.open = ui.q ? true : (ui.open[s.id] !== undefined ? ui.open[s.id] : (s.closed ? false : HINT_OPEN[s.lvl]));
        d.ontoggle = function () { if (!ui.q) ui.open[s.id] = d.open; };
        var changed = s.fields.filter(function (f) { return rawv[f.key] !== undefined && SAW.clean(schema, rawv)[f.key] !== f.def; }).length;
        var sm = h('summary', '', s.title);
        if (ui.q && s.lvl === 'a') sm.appendChild(h('span', 'wp-tag', 'расширенные'));
        if (changed) sm.appendChild(h('span', 'wp-cnt', String(changed)));
        d.appendChild(sm);
        if (s.hint) d.appendChild(h('p', 'mu wp-hint', s.hint));
        fields.forEach(function (f) { d.appendChild(field(f, v, rawv)); });
        if (changed) {
          var rb = h('button', 'wp-rs', 'Сбросить раздел'); rb.type = 'button';
          rb.onclick = function () { ctl.del(s.fields.map(function (f) { return f.key; }), 'sec' + s.id); render(); };
          d.appendChild(rb);
        }
        root.appendChild(d);
      });
      if (!shown) root.appendChild(h('p', 'mu', ui.q ? 'Ничего не найдено' : 'Здесь пока нет настроек'));

      // перенос стиля
      var tr = h('details', 'wp-sec wp-tr');
      tr.appendChild(h('summary', '', 'Перенос стиля'));
      tr.appendChild(h('p', 'mu wp-hint', 'Стиль — это обычный текст. Его можно сохранить в файл, отправить другу или вставить на другой сцене.'));
      var ta = h('textarea', 'wp-ta'); ta.rows = 5; ta.spellcheck = false; ta.value = ui.exportText;
      ta.setAttribute('aria-label', 'Текст стиля'); ta.oninput = function () { ui.exportText = ta.value; };
      var b1 = h('button', '', 'Показать мой стиль'); b1.type = 'button';
      b1.onclick = function () { ui.exportText = JSON.stringify(SAW.exportDoc(def.id, schema, raw()), null, 1); ui.note = ''; ta.value = ui.exportText; ta.select(); };
      var b2 = h('button', '', 'Применить стиль из поля'); b2.type = 'button';
      b2.onclick = function () {
        var r = SAW.importDoc(def.id, schema, ta.value);
        if (!r.ok) { ui.note = r.error; render(); return; }
        ctl.replace(Object.assign(KEEPED(), r.values)); ui.note = 'Стиль применён'; ui.exportText = ''; render();
      };
      var br = h('div', 'wp-btns'); br.appendChild(b1); br.appendChild(b2);
      tr.appendChild(ta); tr.appendChild(br);
      root.appendChild(tr);
      if (ui.note) { var nt = h('p', 'wp-note', ui.note); nt.setAttribute('role', 'status'); root.appendChild(nt); }

      box.replaceChildren(root);
    }
    // при импорте поведенческие настройки (фильтры) не трогаем, как и у готовых стилей
    function KEEPED() {
      var o = {}, r = raw();
      (def.keep || []).forEach(function (k) { if (r[k] !== undefined) o[k] = r[k]; });
      return o;
    }

    function field(f, v, rawv) {
      var cur = v[f.key], isDef = cur === f.def, w;
      function label(parent) {
        var l = h('label', 'wp-l'); l.appendChild(h('span', '', f.label));
        if (f.unit) l.appendChild(h('em', '', f.unit));
        parent.appendChild(l); return l;
      }
      function reset(parent) {
        var b = h('button', 'wp-r', '↺'); b.type = 'button'; b.title = 'Вернуть по умолчанию: ' + (f.type === 'bool' ? (f.def ? 'вкл' : 'выкл') : f.def);
        b.setAttribute('aria-label', 'Вернуть по умолчанию: ' + f.label);
        b.onclick = function () { ctl.del([f.key], f.key); render(); };
        parent.appendChild(b);
      }
      function put(value, again) { ctl.set((function () { var o = {}; o[f.key] = value; return o; })(), f.key); if (again) render(); }

      if (f.type === 'bool') {
        w = h('div', 'trow wp-f');
        w.appendChild(h('span', '', f.label));
        var cb = h('input', 'sw'); cb.type = 'checkbox'; cb.checked = !!cur;
        cb.setAttribute('aria-label', f.label);
        cb.onchange = function () { put(cb.checked, true); };
        w.appendChild(cb);
      } else if (f.type === 'num') {
        w = h('div', 'wp-f wp-n');
        label(w);
        var line = h('div', 'wp-nl');
        var rg = h('input'); rg.type = 'range'; rg.min = f.min; rg.max = f.max; rg.step = f.step; rg.value = cur;
        rg.setAttribute('aria-label', f.label);
        var nb = h('input', 'wp-nb'); nb.type = 'number'; nb.min = f.min; nb.max = f.max; nb.step = f.step; nb.value = fmt(cur);
        nb.setAttribute('aria-label', f.label + ' — точное значение');
        rg.oninput = function () { nb.value = fmt(+rg.value); put(+rg.value, false); };
        rg.onchange = function () { render(); };
        nb.onchange = function () {
          var n = parseFloat(nb.value);
          if (!isFinite(n)) { render(); return; }
          put(Math.min(f.max, Math.max(f.min, n)), true);
        };
        line.appendChild(rg); line.appendChild(nb); w.appendChild(line);
      } else if (f.type === 'color') {
        w = h('div', 'wp-f');
        label(w);
        var cr = h('div', 'wp-cl');
        var pk = h('input', 'wp-cp'); pk.type = 'color'; pk.value = cur; pk.setAttribute('aria-label', f.label);
        var hx = h('input', 'wp-hx'); hx.type = 'text'; hx.maxLength = 7; hx.value = cur; hx.setAttribute('aria-label', f.label + ' — код цвета');
        pk.oninput = function () { hx.value = pk.value; put(pk.value, false); };
        pk.onchange = function () { render(); };
        hx.onchange = function () {
          var t = hx.value.trim(); if (t[0] !== '#') t = '#' + t;
          if (/^#[0-9a-fA-F]{6}$/.test(t)) put(t.toLowerCase(), true); else hx.value = cur;
        };
        cr.appendChild(pk); cr.appendChild(hx); w.appendChild(cr);
      } else if (f.type === 'select') {
        w = h('div', 'wp-f');
        label(w);
        var sl = h('select'); sl.setAttribute('aria-label', f.label);
        f.options.forEach(function (o) { var op = h('option', '', o[1]); op.value = o[0]; if (o[0] === cur) op.selected = true; sl.appendChild(op); });
        sl.onchange = function () { put(sl.value, true); };
        w.appendChild(sl);
      } else {
        w = h('div', 'wp-f');
        label(w);
        var tx = f.multi ? h('textarea', 'wp-ta') : h('input'); if (f.multi) tx.rows = 3; else tx.type = 'text';
        tx.maxLength = f.max; tx.value = cur; tx.setAttribute('aria-label', f.label);
        tx.onchange = function () { put(tx.value, true); };
        w.appendChild(tx);
      }
      if (f.hint) w.appendChild(h('p', 'mu wp-hint', f.hint));
      if (!isDef) reset(w);
      return w;
    }

    render();
    return { refresh: render };
  }

  SAW.panel = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);

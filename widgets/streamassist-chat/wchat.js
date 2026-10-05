/* wchat.js — виджет «Чат» на общем формате стиля (wstyle.js).
   Файл общий для окна программы (предпросмотр) и оверлея OBS: никаких вызовов Tauri и сети.
   Сообщения приходят уже разобранными (ChatMessage из Rust: parts «текст / картинка», badges, kind…)
   и строятся через createElement/textContent — чужая разметка в страницу попасть не может.

   Состав:
     SCHEMA   — все настройки (Общие / Расширенные), см. docs/WIDGET_FORMAT.md
     PRESETS  — готовые стили (по присланным образцам)
     compile  — значения → набор CSS-переменных и классов (чистая функция, есть тесты)
     accept   — фильтр сообщений (чистая функция, есть тесты)
     create   — живой виджет: push / update / clear / destroy
   В OBS размытие фона (backdrop-filter) не применяется — mode 'obs' (по умолчанию). */
(function (root) {
  'use strict';
  var SAW = root.SAW;
  if (!SAW) throw new Error('wchat.js: сначала подключите wstyle.js');
  var F = SAW.F, N = F.num, C = F.color, S = F.select, B = F.bool, T = F.text, SEC = F.section;

  // ——— Схема ——————————————————————————————————————————————————————————————
  // Вся подложка блока (заливка и градиент, рамка, углы, тень, подсветка, отступы, размытие) — в «Общих», целиком.
  // Правило: одна тема — одна вкладка. Раньше цвет и градиент были в «Общих», а рамка и тень — в «Расширенных».
  var box = SAW.blocks.box('bx', { fill: '#0b0b10', fillOp: 85, r: 16, pt: 8, pr: 14, pb: 8, pl: 14 });
  var BOX_TITLES = { bxFill: 'Фон блока: заливка и градиент', bxBorder: 'Фон блока: рамка', bxCorners: 'Фон блока: углы',
    bxShadow: 'Фон блока: тень', bxInner: 'Фон блока: подсветка внутри', bxPad: 'Фон блока: отступы внутри', bxBlur: 'Фон блока: размытие' };
  // «Общие»: заливка, углы, рамка, тень, подсветка — всё, чем собирают вид блока. В «Расширенные» уходят отступы внутри
  // и размытие фона (в OBS оно не работает) — их трогают редко. Раскрыта только заливка, остальное разворачивается по клику.
  var BOX_ADV = { bxPad: 1, bxBlur: 1 };
  box.forEach(function (s) {
    s.lvl = BOX_ADV[s.id] ? 'a' : 'g'; s.title = BOX_TITLES[s.id] || s.title;
    if (s.id !== 'bxFill') s.closed = true;
  });
  var boxG = box.filter(function (s) { return s.lvl === 'g'; }), boxA = box.filter(function (s) { return s.lvl === 'a'; });
  var isInline = function (v) { return v.nameLine === 'inline'; };
  var mediaOn = function (v) { return !!v.showMedia; };

  // Значок площадки / аватар — всё про него в одном месте: показывать ли, сторона, высота, размер, цвета, рамка.
  var MEDIA = [
    SEC('g', 'media', 'Значок площадки / аватар', [
      B('showMedia', 'Показывать значок площадки', true),
      S('mSide', 'Сторона', 'auto', [['auto', 'Автоматически (как выравнивание блоков)'], ['left', 'Слева'], ['right', 'Справа']], { when: mediaOn,
        hint: 'Автоматически: блоки прижаты влево или стоят по центру — значок слева, блоки прижаты вправо — справа. В этом режиме вместе со значком зеркально меняются отступы, градиент, углы и сдвиг тени. Если выбрать сторону вручную, всё применяется как задано, без зеркала.' }),
      S('mAlign', 'По высоте блока', 'center', [['start', 'Сверху'], ['center', 'По центру'], ['end', 'Снизу']], { when: mediaOn }),
      S('mKind', 'Что показывать', 'platform', [['platform', 'Значок площадки'], ['letter', 'Первая буква ника']], { when: mediaOn }),
      N('mSize', 'Размер', 40, 12, 160, { unit: 'px', when: mediaOn }),
      S('mShape', 'Форма', 'circle', [['circle', 'Круг'], ['rounded', 'Скруглённый квадрат'], ['square', 'Квадрат']], { when: mediaOn }),
      N('mRadius', 'Скругление квадрата', 10, 0, 80, { unit: 'px', when: function (v) { return v.showMedia && v.mShape === 'rounded'; } }),
      N('mGap', 'Расстояние до текста', 12, 0, 80, { unit: 'px', when: mediaOn }),
      B('mUsePlat', 'Фон — цвет площадки', false, { when: mediaOn }),
      C('mBg', 'Цвет фона', '#ffffff', { when: function (v) { return v.showMedia && !v.mUsePlat; } }),
      N('mBgOp', 'Непрозрачность фона', 12, 0, 100, { unit: '%', when: mediaOn }),
      B('mIcPlat', 'Значок цветом площадки', false, { when: mediaOn }),
      C('mIc', 'Цвет значка / буквы', '#ffffff', { when: function (v) { return v.showMedia && !v.mIcPlat; } }),
      N('mBw', 'Рамка: толщина', 0, 0, 12, { unit: 'px', step: 0.5, when: mediaOn }),
      C('mBc', 'Рамка: цвет', '#ffffff', { when: mediaOn }),
      N('mBop', 'Рамка: непрозрачность', 20, 0, 100, { unit: '%', when: mediaOn })
    ], { closed: true })
  ];
  // Значки ролей (стример, модератор, VIP…) — тоже целиком в одном месте.
  var bdOn = function (v) { return !!v.showBadges; };
  var BADGES = [
    SEC('g', 'badges', 'Значки ролей (модератор, VIP…)', [
      B('showBadges', 'Показывать значки ролей', true),
      S('bdPos', 'Сторона', 'auto', [['auto', 'Автоматически (как выравнивание блоков)'], ['before', 'Слева от ника'], ['after', 'Справа от ника']], { when: bdOn,
        hint: 'Автоматически: блоки прижаты влево или стоят по центру — значки слева от ника, блоки прижаты вправо — справа от ника.' }),
      S('bdStyle', 'Вид', 'image', [['image', 'Картинки (стример, модератор — как на Twitch)'], ['icon', 'Цветной значок'], ['pill', 'Подпись'], ['dot', 'Точка']], { when: bdOn,
        hint: 'Картинки есть у стримера, модератора и ведущего модератора. Остальные роли (VIP, подписчик…) в этом виде рисуются цветным значком — цвета ниже.' }),
      N('bdSize', 'Размер', 16, 6, 60, { unit: 'px', when: bdOn }),
      N('bdRadius', 'Скругление', 4, 0, 30, { unit: 'px', when: bdOn }),
      C('bcBroadcaster', 'Цвет: стример', '#ffb703', { when: bdOn }),
      C('bcModerator', 'Цвет: модератор', '#3ea6ff', { when: bdOn }),
      C('bcVip', 'Цвет: VIP', '#c084fc', { when: bdOn }),
      C('bcSub', 'Цвет: подписчик / спонсор', '#e2820a', { when: bdOn }),
      C('bcPartner', 'Цвет: подтверждённый', '#22c55e', { when: bdOn }),
      C('bcStaff', 'Цвет: сотрудник', '#ef4444', { when: bdOn })
    ], { closed: true })
  ];

  var WEIGHTS = [['300', 'Тонкий'], ['400', 'Обычный'], ['500', 'Средний'], ['600', 'Полужирный'], ['700', 'Жирный'], ['800', 'Очень жирный'], ['900', 'Чёрный']];
  var CASES = [['normal', 'Как написано'], ['upper', 'ЗАГЛАВНЫЕ'], ['lower', 'строчные']];
  var FONTS = [['sys', 'Системный'], ['inter', 'Inter'], ['segoe', 'Segoe UI'], ['arial', 'Arial'], ['verdana', 'Verdana'], ['georgia', 'Georgia'], ['mono', 'Consolas'], ['impact', 'Impact'], ['custom', 'Свой (впишите название ниже)']];
  var STACKS = {
    sys: 'system-ui,"Segoe UI",Roboto,Arial,sans-serif',
    inter: 'Inter,"Segoe UI",system-ui,sans-serif',
    segoe: '"Segoe UI",system-ui,sans-serif',
    arial: 'Arial,Helvetica,sans-serif',
    verdana: 'Verdana,Geneva,sans-serif',
    georgia: 'Georgia,"Times New Roman",serif',
    mono: 'Consolas,"Courier New",monospace',
    impact: 'Impact,"Arial Black",sans-serif'
  };

  // Порядок «Общих» — как стример настраивает чат: сначала общий вид, текст и ник, потом фон блока (рамка, тень…),
  // значки, расположение, что показывать, особые сообщения (платные, действия модераторов, время), появление.
  // Что нужно редко — в «Расширенных». Раскрыты только главные разделы, остальные разворачиваются по клику.
  var SCHEMA = { sections: [
    // ——— ОБЩИЕ ———
    SEC('g', 'look', 'Внешний вид', [
      S('layout', 'Как выглядят сообщения', 'bubbles', [['bubbles', 'Каждое — отдельный блок'], ['panel', 'Одна общая панель'], ['plain', 'Без фона (просто текст)']]),
      N('scale', 'Масштаб всего виджета', 100, 50, 200, { unit: '%' }),
      C('ac', 'Цвет акцента', '#ff7a1a'),
      B('showEmotes', 'Смайлы картинками', true)
    ]),
    SEC('g', 'txt', 'Текст', [
      S('ff', 'Шрифт', 'sys', FONTS),
      T('ffCustom', 'Название своего шрифта', '', { max: 60, when: function (v) { return v.ff === 'custom'; }, hint: 'Шрифт должен быть установлен на этом компьютере: OBS берёт его из Windows.' }),
      S('fw', 'Толщина', '500', WEIGHTS),
      N('fs', 'Размер текста', 18, 10, 72, { unit: 'px' }),
      C('textColor', 'Цвет текста', '#ffffff')
    ]),
    SEC('g', 'nick', 'Ник', [
      S('nameLine', 'Где ник', 'stack', [['stack', 'Над текстом'], ['inline', 'В одной строке с текстом']]),
      S('nameColorMode', 'Цвет ника', 'author', [['author', 'Как в чате'], ['platform', 'По площадке'], ['accent', 'Цвет акцента'], ['fixed', 'Один цвет']]),
      C('nameColor', 'Цвет ника (один цвет)', '#ffffff', { when: function (v) { return v.nameColorMode === 'fixed'; } }),
      N('nameSize', 'Размер ника', 16, 8, 72, { unit: 'px' }),
      S('nameCase', 'Регистр ника', 'normal', CASES)
    ])
  ].concat(boxG).concat(MEDIA).concat(BADGES).concat([
    SEC('g', 'place', 'Расположение', [
      S('align', 'Выравнивание блоков', 'left', [['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]),
      S('dir', 'Новые сообщения', 'bottom', [['bottom', 'Снизу'], ['top', 'Сверху']])
    ]),
    SEC('g', 'flt', 'Какие сообщения', [
      S('src', 'Площадка', 'all', [['all', 'Twitch и YouTube'], ['twitch', 'Только Twitch'], ['youtube', 'Только YouTube']]),
      N('max', 'Сколько сообщений на экране', 12, 1, 40),
      N('life', 'Убирать сообщение через (0 — не убирать)', 0, 0, 600, { unit: 'сек' }),
      B('bots', 'Скрывать сообщения ботов', true),
      B('hideCmd', 'Скрывать команды (начинаются с «!»)', true)
    ]),
    SEC('g', 'paid', 'Платные сообщения (суперчат, новые участники)', [
      B('paidOn', 'Выделять', true),
      C('paidFill', 'Цвет фона', '#ffb703', { when: function (v) { return v.paidOn; } }),
      N('paidOp', 'Непрозрачность фона', 95, 0, 100, { unit: '%', when: function (v) { return v.paidOn; } }),
      C('paidText', 'Цвет текста', '#1a1200', { when: function (v) { return v.paidOn; } })
    ], { closed: true }),
    SEC('g', 'sys', 'Действия модераторов', [
      B('showSys', 'Показывать (бан, таймаут…)', false),
      C('sysColor', 'Цвет', '#a0a0b0', { when: function (v) { return v.showSys; } }),
      N('sysSize', 'Размер', 14, 6, 40, { unit: 'px', when: function (v) { return v.showSys; } }),
      B('sysItalic', 'Курсив', true, { when: function (v) { return v.showSys; } })
    ], { closed: true }),
    SEC('g', 'time', 'Время сообщения', [
      B('showTime', 'Показывать время', false),
      S('tmFmt', 'Формат', '24', [['24', '14:36'], ['12', '2:36 PM']], { when: function (v) { return v.showTime; } }),
      N('tmSize', 'Размер', 13, 6, 40, { unit: 'px', when: function (v) { return v.showTime; } }),
      C('tmColor', 'Цвет', '#9aa0b4', { when: function (v) { return v.showTime; } })
    ], { closed: true }),
    SEC('g', 'anim', 'Появление', [
      S('an', 'Анимация', 'up', [['up', 'Снизу'], ['down', 'Сверху'], ['left', 'Слева'], ['right', 'Справа'], ['scale', 'Увеличение'], ['fade', 'Плавно'], ['none', 'Без анимации']]),
      N('adur', 'Длительность', 250, 0, 2000, { unit: 'мс', step: 10 })
    ], { closed: true })
  ]).concat([
    // ——— РАСШИРЕННЫЕ ———
    SEC('a', 'pos', 'Положение и размеры', [
      S('anchor', 'Где держатся сообщения', 'bottom', [['top', 'Вверху виджета'], ['center', 'По центру'], ['bottom', 'Внизу виджета']]),
      N('maxW', 'Максимальная ширина блока (0 — вся ширина)', 0, 0, 2400, { unit: 'px' }),
      N('minW', 'Минимальная ширина блока', 0, 0, 2400, { unit: 'px' }),
      N('gap', 'Расстояние между сообщениями', 8, 0, 120, { unit: 'px' }),
      S('textAlign', 'Выравнивание текста внутри блока', 'left', [['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]),
      N('outT', 'Отступ от края виджета: сверху', 0, 0, 400, { unit: 'px' }),
      N('outR', 'Отступ от края виджета: справа', 0, 0, 400, { unit: 'px' }),
      N('outB', 'Отступ от края виджета: снизу', 0, 0, 400, { unit: 'px' }),
      N('outL', 'Отступ от края виджета: слева', 0, 0, 400, { unit: 'px' })
    ])
  ]).concat(boxA).concat([
    SEC('a', 'text', 'Текст: интервалы, тень, обводка', [
      N('lh', 'Высота строки', 1.3, 0.8, 2.5, { step: 0.05 }),
      N('ls', 'Расстояние между буквами', 0, -3, 12, { unit: 'px', step: 0.1 }),
      N('ws', 'Расстояние между словами', 0, -5, 30, { unit: 'px', step: 0.5 }),
      S('tcase', 'Регистр', 'normal', CASES),
      B('italic', 'Курсив', false),
      B('tShOn', 'Тень текста', false),
      N('tShX', 'Тень: сдвиг по горизонтали', 0, -20, 20, { unit: 'px', when: function (v) { return v.tShOn; } }),
      N('tShY', 'Тень: сдвиг по вертикали', 1, -20, 20, { unit: 'px', when: function (v) { return v.tShOn; } }),
      N('tShBlur', 'Тень: размытие', 3, 0, 40, { unit: 'px', when: function (v) { return v.tShOn; } }),
      C('tShColor', 'Тень: цвет', '#000000', { when: function (v) { return v.tShOn; } }),
      N('tShOp', 'Тень: непрозрачность', 70, 0, 100, { unit: '%', when: function (v) { return v.tShOn; } }),
      N('otW', 'Обводка текста: толщина', 0, 0, 10, { unit: 'px', step: 0.5 }),
      C('otColor', 'Обводка текста: цвет', '#000000', { when: function (v) { return v.otW > 0; } })
    ]),
    SEC('a', 'name', 'Ник: толщина, интервалы', [
      S('nameWeight', 'Толщина', '700', WEIGHTS),
      N('nameLs', 'Расстояние между буквами', 0, -2, 12, { unit: 'px', step: 0.1 }),
      S('nameSep', 'Разделитель после ника', 'none', [['none', 'Нет'], ['colon', ':'], ['dash', '—'], ['arrow', '›']], { when: isInline })
    ]),
    SEC('a', 'anim2', 'Анимация подробно', [
      S('aease', 'Характер движения', 'out', [['out', 'Плавное замедление'], ['linear', 'Равномерно'], ['inout', 'Разгон и торможение'], ['spring', 'С отскоком']]),
      N('adist', 'Расстояние сдвига', 16, 0, 300, { unit: 'px' }),
      N('aout', 'Исчезновение', 300, 0, 3000, { unit: 'мс', step: 10 })
    ]),
    SEC('a', 'flt2', 'Фильтры подробно', [
      T('botNames', 'Имена ботов (через запятую)', 'nightbot, streamelements, streamlabs, moobot, fossabot, wizebot', { max: 600, multi: true }),
      T('blockNames', 'Скрывать этих людей (через запятую)', '', { max: 600, multi: true })
    ])
  ]) };

  // Эти настройки НЕ сбрасываются при выборе готового стиля (это поведение, а не оформление).
  var KEEP = ['scale', 'max', 'life', 'bots', 'hideCmd', 'showSys', 'src', 'botNames', 'blockNames'];

  // ——— Готовые стили (по присланным образцам) ————————————————————————————
  var PRESETS = [
    { id: 'bubbles', name: 'Тёмные пузыри', values: {
      layout: 'bubbles', fs: 20, fw: '600', nameColorMode: 'fixed', nameColor: '#ffffff', nameSize: 15, nameWeight: '800', nameCase: 'upper', nameLs: 0.4,
      bxFill: '#000000', bxFillOp: 90, bxR: 20, bxPt: 9, bxPr: 16, bxPb: 11, bxPl: 16, gap: 12, align: 'left', nameLine: 'stack',
      bdSize: 15, bdRadius: 4, showMedia: false, lh: 1.25, mSide: 'auto', mAlign: 'center', bdPos: 'auto' } },
    { id: 'glass', name: 'Стеклянная капсула', values: {
      layout: 'bubbles', fs: 15, fw: '500', textColor: '#c9c9d6', nameColorMode: 'fixed', nameColor: '#ffffff', nameSize: 18, nameWeight: '700',
      bxFill: '#12121c', bxFillOp: 58, bxR: 36, bxBw: 1, bxBc: '#ffffff', bxBop: 30, bxPt: 10, bxPr: 26, bxPb: 10, bxPl: 10,
      bxShOn: true, bxShY: 8, bxShBlur: 26, bxShOp: 40, bxInOn: true, bxInOp: 14, bxInY: 1, gap: 10,
      showMedia: true, mSize: 46, mShape: 'circle', mBg: '#05050a', mBgOp: 85, mBw: 1, mBop: 16, mGap: 14, mIcPlat: false, showBadges: false, lh: 1.25, mSide: 'auto', mAlign: 'center', bdPos: 'auto' } },
    { id: 'music', name: 'Градиентная капсула', values: {
      layout: 'bubbles', fs: 12, fw: '600', tcase: 'upper', ls: 0.6, textColor: '#b4c2f0', nameColorMode: 'fixed', nameColor: '#ffffff', nameSize: 17, nameWeight: '800', nameCase: 'upper', nameLs: 0.5,
      bxFillType: 'gradient', bxFill: '#0a1a4a', bxFill2: '#2563eb', bxAngle: 270, bxFillOp: 100, bxR: 40, bxPt: 10, bxPr: 26, bxPb: 10, bxPl: 10,
      bxShOn: true, bxShY: 6, bxShBlur: 22, bxShColor: '#1d4ed8', bxShOp: 35, gap: 10,
      showMedia: true, mSize: 46, mShape: 'circle', mBg: '#000000', mBgOp: 100, mIcPlat: true, mGap: 20, showBadges: false, lh: 1.2, mSide: 'auto', mAlign: 'center', bdPos: 'auto' } },
    { id: 'card', name: 'Карточка', values: {
      layout: 'bubbles', fs: 19, fw: '800', nameColorMode: 'fixed', nameColor: '#d9cff0', nameSize: 12, nameWeight: '600', nameCase: 'upper', nameLs: 1.3,
      bxFill: '#7352a8', bxFillOp: 80, bxR: 24, bxPt: 16, bxPr: 28, bxPb: 16, bxPl: 16, gap: 12,
      bxInOn: true, bxInOp: 10, showMedia: true, mSize: 54, mShape: 'circle', mBg: '#ffffff', mBgOp: 14, mGap: 16, mIcPlat: false, showBadges: false, lh: 1.25, mSide: 'auto', mAlign: 'center', bdPos: 'auto' } },
    { id: 'classic', name: 'Классика без фона', values: {
      layout: 'plain', fs: 20, fw: '600', nameLine: 'inline', nameSep: 'colon', nameSize: 20, nameWeight: '800', nameColorMode: 'author',
      tShOn: true, tShY: 1, tShBlur: 3, tShOp: 90, gap: 5, showMedia: false, bxPt: 0, bxPr: 0, bxPb: 0, bxPl: 0, bdSize: 17, lh: 1.25, mSide: 'auto', mAlign: 'center', bdPos: 'auto' } }
  ];

  // ——— Расчёт стиля (чистая функция) ———————————————————————————————————————
  var PLATFORMS = { twitch: { name: 'Twitch', color: '#9146ff' }, youtube: { name: 'YouTube', color: '#ff4e45' } };
  var CASE = { normal: 'none', upper: 'uppercase', lower: 'lowercase' };
  var ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' };
  var VALIGN = { start: 'flex-start', center: 'center', end: 'flex-end' };
  var ANCHOR = { top: 'flex-start', center: 'center', bottom: 'flex-end' };
  var EASE = { out: 'cubic-bezier(.16,1,.3,1)', linear: 'linear', inout: 'ease-in-out', spring: 'cubic-bezier(.34,1.56,.64,1)' };
  var ANIM = { up: 'sachat-up', down: 'sachat-down', left: 'sachat-left', right: 'sachat-right', scale: 'sachat-scale', fade: 'sachat-fade', none: 'none' };
  var SEPS = { none: '', colon: ':', dash: '—', arrow: '›' };

  function compile(raw, opts) {
    var v = SAW.clean(SCHEMA, raw);
    var app = !!(opts && opts.mode === 'app');
    var k = v.scale / 100;
    function px(n) { return (Math.round(n * k * 100) / 100) + 'px'; }
    var rgba = SAW.rgba;
    var vars = {}, name;

    // Сторона значка площадки: «авто» — справа, только если блоки прижаты вправо. В авто-режиме оформление зеркалится
    // вместе со значком (за основу взят значок слева), чтобы справа получалось то же самое, а не «кривое».
    var side = v.mSide === 'auto' ? (v.align === 'right' ? 'right' : 'left') : v.mSide;
    v.mSideR = side;
    // Значки ролей (модератор, VIP…): «авто» — справа от ника, только если блоки прижаты вправо.
    v.bdPosR = v.bdPos === 'auto' ? (v.align === 'right' ? 'after' : 'before') : v.bdPos;
    var flip = v.mSide === 'auto' && side === 'right' && v.showMedia && v.layout === 'bubbles';

    var fam = v.ff === 'custom' && SAW.fontName(v.ffCustom) ? '"' + SAW.fontName(v.ffCustom) + '",' + STACKS.sys : (STACKS[v.ff] || STACKS.sys);
    vars['--fs'] = px(v.fs); vars['--tc'] = v.textColor; vars['--ac'] = v.ac; vars['--ff'] = fam;
    vars['--fw'] = v.fw; vars['--lh'] = String(v.lh); vars['--ls'] = px(v.ls); vars['--ws'] = px(v.ws);
    vars['--fst'] = v.italic ? 'italic' : 'normal'; vars['--tt'] = CASE[v.tcase]; vars['--ta'] = v.textAlign;
    vars['--tsh'] = v.tShOn ? px(v.tShX) + ' ' + px(v.tShY) + ' ' + px(v.tShBlur) + ' ' + rgba(v.tShColor, v.tShOp) : 'none';
    vars['--tsw'] = px(v.otW); vars['--tsc'] = v.otColor;

    vars['--anchor'] = ANCHOR[v.anchor]; vars['--align'] = ALIGN[v.align];
    vars['--gap'] = px(v.gap);
    vars['--maxw'] = v.maxW > 0 ? px(v.maxW) : '100%'; vars['--minw'] = px(v.minW);
    vars['--pw'] = v.maxW > 0 ? px(v.maxW) : '100%';
    vars['--out'] = px(v.outT) + ' ' + px(v.outR) + ' ' + px(v.outB) + ' ' + px(v.outL);
    vars['--hgap'] = px(6);

    // подложка
    var bg = 'transparent';
    if (v.bxFillType === 'solid') bg = rgba(v.bxFill, v.bxFillOp);
    else if (v.bxFillType === 'gradient') bg = 'linear-gradient(' + (flip ? (360 - v.bxAngle) % 360 : v.bxAngle) + 'deg,' + rgba(v.bxFill, v.bxFillOp) + ',' + rgba(v.bxFill2, v.bxFillOp) + ')';
    vars['--bg'] = bg;
    vars['--bd'] = v.bxBw > 0 ? px(v.bxBw) + ' ' + v.bxBs + ' ' + rgba(v.bxBc, v.bxBop) : 'none';
    vars['--rad'] = v.bxREach ? (flip ? px(v.bxRtr) + ' ' + px(v.bxRtl) + ' ' + px(v.bxRbl) + ' ' + px(v.bxRbr) : px(v.bxRtl) + ' ' + px(v.bxRtr) + ' ' + px(v.bxRbr) + ' ' + px(v.bxRbl)) : px(v.bxR);
    var sh = [];
    if (v.bxShOn) sh.push(px(flip ? -v.bxShX : v.bxShX) + ' ' + px(v.bxShY) + ' ' + px(v.bxShBlur) + ' ' + px(v.bxShSpread) + ' ' + rgba(v.bxShColor, v.bxShOp));
    if (v.bxInOn) sh.push('inset 0 ' + px(v.bxInY) + ' ' + px(v.bxInBlur) + ' ' + px(v.bxInSpread) + ' ' + rgba(v.bxInColor, v.bxInOp));
    vars['--shadow'] = sh.length ? sh.join(',') : 'none';
    vars['--pad'] = flip ? px(v.bxPt) + ' ' + px(v.bxPl) + ' ' + px(v.bxPb) + ' ' + px(v.bxPr) : px(v.bxPt) + ' ' + px(v.bxPr) + ' ' + px(v.bxPb) + ' ' + px(v.bxPl);
    vars['--blur'] = app && v.bxBlur > 0 ? 'blur(' + px(v.bxBlur) + ')' : 'none';

    // ник, значки, время
    vars['--nfs'] = px(v.nameSize); vars['--nfw'] = v.nameWeight; vars['--ntt'] = CASE[v.nameCase]; vars['--nls'] = px(v.nameLs);
    vars['--bs'] = px(v.bdSize); vars['--br'] = px(v.bdRadius);
    vars['--tmc'] = v.tmColor; vars['--tmfs'] = px(v.tmSize);

    // аватар / значок площадки
    vars['--ms'] = px(v.mSize); vars['--mgap'] = px(v.mGap); vars['--mal'] = VALIGN[v.mAlign];
    vars['--mr'] = v.mShape === 'circle' ? '50%' : v.mShape === 'rounded' ? px(v.mRadius) : '0';
    vars['--mbg'] = rgba(v.mBg, v.mBgOp);
    vars['--mbd'] = v.mBw > 0 ? px(v.mBw) + ' solid ' + rgba(v.mBc, v.mBop) : 'none';
    vars['--mic'] = v.mIc;

    // платные и системные
    vars['--pdbg'] = rgba(v.paidFill, v.paidOp); vars['--pdtc'] = v.paidText;
    vars['--sysc'] = v.sysColor; vars['--sysfs'] = px(v.sysSize); vars['--sysfst'] = v.sysItalic ? 'italic' : 'normal';

    // анимация
    vars['--aname'] = ANIM[v.an]; vars['--adur'] = v.adur + 'ms'; vars['--aease'] = EASE[v.aease];
    vars['--adist'] = px(v.adist); vars['--aout'] = v.aout + 'ms';

    var classes = ['is-' + v.layout, 'name-' + v.nameLine, 'dir-' + v.dir];
    if (v.paidOn) classes.push('paid-on');
    return { values: v, vars: vars, classes: classes };
  }

  // ——— Фильтр сообщений (чистая функция) ——————————————————————————————————
  function nameList(s) {
    return String(s || '').split(/[,;\n]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  }
  function plainText(m) { return (m.parts || []).map(function (p) { return p.text; }).join(''); }
  function accept(m, v) {
    if (!m || !Array.isArray(m.parts)) return false;
    if (m.kind === 'system') return !!v.showSys && (v.src === 'all' || v.src === m.platform);
    if (v.src !== 'all' && v.src !== m.platform) return false;
    var a = String(m.author || '').toLowerCase();
    if (v.bots && nameList(v.botNames).indexOf(a) >= 0) return false;
    if (nameList(v.blockNames).indexOf(a) >= 0) return false;
    if (v.hideCmd && m.kind !== 'superchat' && m.kind !== 'member' && /^\s*!/.test(plainText(m))) return false;
    return true;
  }

  // ——— Стили страницы ———————————————————————————————————————————————————————
  var CSS = [
    '.sachat{position:relative;width:100%;height:100%;box-sizing:border-box;overflow:visible;display:flex;flex-direction:column;justify-content:var(--anchor);padding:var(--out);color:var(--tc);font-family:var(--ff);font-size:var(--fs);font-weight:var(--fw);font-style:var(--fst);line-height:var(--lh);letter-spacing:var(--ls);word-spacing:var(--ws);text-align:var(--ta);text-shadow:var(--tsh);-webkit-text-stroke:var(--tsw) var(--tsc);paint-order:stroke fill}',
    '.sachat *{box-sizing:border-box}',
    '.sachat-list{display:flex;flex-direction:column;gap:var(--gap);min-height:0;max-height:100%;overflow:visible;align-items:var(--align);width:100%}',
    '.sachat.dir-bottom .sachat-list{justify-content:flex-end}.sachat.dir-top .sachat-list{justify-content:flex-start}',
    '.sachat-msg{display:flex;align-items:var(--mal);gap:var(--mgap);flex:0 0 auto;width:fit-content;max-width:var(--maxw);min-width:var(--minw)}',
    '.sachat.is-bubbles .sachat-msg.k-chat,.sachat.is-bubbles .sachat-msg.k-paid{background:var(--bg);border:var(--bd);border-radius:var(--rad);box-shadow:var(--shadow);padding:var(--pad);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur)}',
    '.sachat.is-panel .sachat-list{align-self:var(--align);width:var(--pw);background:var(--bg);border:var(--bd);border-radius:var(--rad);box-shadow:var(--shadow);padding:var(--pad);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur)}',
    '.sachat.is-panel .sachat-msg{width:100%;max-width:none;min-width:0}',
    '.sachat.is-plain .sachat-msg{padding:0}',
    '.sachat.paid-on .sachat-msg.k-paid{background:var(--pdbg);color:var(--pdtc);border-radius:var(--rad);padding:var(--pad)}',
    '.sachat.is-panel.paid-on .sachat-msg.k-paid,.sachat.is-plain.paid-on .sachat-msg.k-paid{border-radius:calc(var(--rad))}',
    '.sachat-body{min-width:0;flex:1 1 auto;overflow-wrap:anywhere}',
    '.sachat-head{display:flex;flex-wrap:wrap;align-items:center}',
    '.sachat-head>*{margin-right:var(--hgap)}.sachat-head>*:last-child{margin-right:0}',
    '.sachat.name-inline .sachat-head,.sachat.name-inline .sachat-text{display:inline}',
    '.sachat.name-inline .sachat-head>*{display:inline-flex;vertical-align:middle}',
    '.sachat.name-inline .sachat-head>.sachat-name{display:inline;vertical-align:baseline}',
    '.sachat-name{font-size:var(--nfs);font-weight:var(--nfw);text-transform:var(--ntt);letter-spacing:var(--nls);line-height:1.2}',
    '.sachat-text{text-transform:var(--tt)}',
    '.sachat-emote{height:1.5em;width:auto;vertical-align:middle}',
    '.sachat-time{white-space:nowrap;flex:0 0 auto;color:var(--tmc);font-size:var(--tmfs);font-weight:500;text-shadow:none}',
    '.sachat-amt{white-space:nowrap;flex:0 0 auto;font-weight:800;padding:0 .4em;border-radius:.4em;background:rgba(0,0,0,.22)}',
    '.sachat-bd{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:#fff;text-shadow:none;-webkit-text-stroke:0}',
    '.sachat-bd.image{width:var(--bs);height:var(--bs);border-radius:var(--br);display:block;object-fit:cover}',
    '.sachat-bd.icon{width:var(--bs);height:var(--bs);border-radius:var(--br)}',
    '.sachat-bd.icon svg{width:68%;height:68%;fill:currentColor}',
    '.sachat-bd.pill{height:calc(var(--bs)*1.1);padding:0 .55em;border-radius:var(--br);font-size:calc(var(--bs)*.68);font-weight:700;line-height:1;text-transform:none;letter-spacing:0}',
    '.sachat-bd.dot{width:calc(var(--bs)*.62);height:calc(var(--bs)*.62);border-radius:50%}',
    '.sachat-media{flex:0 0 auto;width:var(--ms);height:var(--ms);border-radius:var(--mr);background:var(--mbg);border:var(--mbd);display:grid;place-items:center;overflow:hidden;color:var(--mic);text-shadow:none;-webkit-text-stroke:0}',
    '.sachat-media svg{width:56%;height:56%;fill:currentColor}',
    '.sachat-media .ltr{font-weight:800;font-size:calc(var(--ms)*.46);line-height:1;text-transform:uppercase}',
    '.sachat-msg.k-sys{display:block;width:100%;max-width:var(--maxw);padding:2px 4px;color:var(--sysc);font-size:var(--sysfs);font-style:var(--sysfst);background:none;border:0;box-shadow:none}',
    '.sachat-msg.is-new{animation:var(--aname) var(--adur) var(--aease) both}',
    '.sachat-msg.is-out{opacity:0;transition:opacity var(--aout) linear}',
    '@keyframes sachat-up{from{opacity:0;transform:translateY(var(--adist))}to{opacity:1;transform:none}}',
    '@keyframes sachat-down{from{opacity:0;transform:translateY(calc(var(--adist)*-1))}to{opacity:1;transform:none}}',
    '@keyframes sachat-left{from{opacity:0;transform:translateX(calc(var(--adist)*-1))}to{opacity:1;transform:none}}',
    '@keyframes sachat-right{from{opacity:0;transform:translateX(var(--adist))}to{opacity:1;transform:none}}',
    '@keyframes sachat-scale{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}',
    '@keyframes sachat-fade{from{opacity:0}to{opacity:1}}'
  ].join('\n');
  function ensureCss(doc) {
    if (doc.getElementById('sachat-css')) return;
    var st = doc.createElement('style');
    st.id = 'sachat-css'; st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  // ——— Отрисовка одного сообщения ——————————————————————————————————————————
  // Основные значки ролей — готовые картинки 72×72, встроены в код (data:), поэтому работают офлайн и в OBS.
  var BADGE_IMG = {
    broadcaster: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAACvklEQVR42u3c30rbUBwH8O85LnFddhFBRnsR0CfQC0Eab9a9gH/q5lsMmXqtvdYO9xgdG84nmBdrymCwvIGFCO1AaRirlYbmtwtR1OnaxDbG9Pe9KqSlJ5/+cn4n9LQCN1JLj78UQiwIiHkAExiO2EKQ3fG9QqbuVq8eEBcPDnVd11LKJkGsYogjQbt/Wl5h0nXdS6BDXdefpdSvAKbBAQD7tNXOTbquKwFASymbjHMt08/PTSBqaX1CCvWQTf6NT35OSqFsMcXtEUIsSAhMMcUdQBDz4lfmBTHF/7oah4EYiIEYiIEYiIGGM0+CPFkxTTx9vQLVnMOIYUQ60I7joG1ZaL7fhu840a2me11Ja2vr0NY2YvGpNos7aBa343OJxQkn6vF0rSBpGBj//iOW80MjvwivYj1sBcWpcm4m9WYl9GsV04T+ae/+k7SaNWMLpJhzoWC0dxtQzd7OqytQ1N0qSIKMLShMqDb/GBMWJvFA94VJLFC/YBIH1G+YxAANCiYxQGM9rGX4bp6BGIiBGIiBGIjDQAzEQAzEQAzEQAzESQ7Q79W36Azwu/pHD3T2sYST2ZmBQSXmEruAauQX0a6UGeiueBULbn6pb1CJnaT7BZX4LnZfqK5AnSMnticfZFK+BmV9A4j6A+RZ5RhXRzlcRS3n0VheOofqkq4bqJSsibHPe7EEOpmdGegaqLcKqliR7QcMkmZxZ+A4PU/SUW6ajNt4Av1ebMQwoK2tQ8k+wDbgIwdtq4yzUmng+xJDA/HNKoeBGIiBGIiBGIiBhguoygx3rKIBWxJonyluj0+wJRF9YYrbQ5AFmakfHxDoA3PcxKHdTL1elQAwOuptQZDNLJf52Wp5hcsuNlZ1XVX1clxJIALtnrbar679ydvV1NLpCcDfkoKmADH94JUezbtUO4L2BdF+pn58cPXQXxL2D3UMil8FAAAAAElFTkSuQmCC',
    lead_moderator: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAE4ElEQVR42u3cv08bZxgH8O+9NpJlpHKpUkVi6L2R6ECH2BWRmkgNYFGpLIAtFHXDpuwkaedimz8gId0JmB0ZR6raIch2MjRDkewuLEjcZaBDLXGOGquSf1wG18EQDPfjfe+Mfc+EbHx3/uh53vd93jtZwNlIeyfRwBzQCAMCRT+EphUgCAWQgSQi/8ntbwknMKIIvI2jITxEX4ewBlJLIgL1BCgtiqj/m4WgBeFGM6M8jRAiUEnzlbdxF6c9iYQgGt54M4PSPopG9dBVOSeIECJoVOOuRIeoI0ygCW5pdSw1bY64Y8+FQYmtZ/NTHE4f4HD6ANR/NZZYxE6c7PgLUD899bcLdAbnotf6EugiiKuARJzCuSpIxEmcs/8rDoj9AWQmK6if4smtx70PJA6ISN/ZNlUy4eHZrssiwhone28XQTFg+vPBoUBvAlnF+VBqg7T3gFjhNMciqfeANsbWmeAAgGQwg3gvD4h1nGcID88xu6DgJwFdGbsx9gzHMyUcTh/geKaEJ7cecxngBWx7NCs4MWmB+UWFXk4hV8obXkLk/skj9GqqOzKIFw4AbNxeN9WaTH42gZgUZXotHnxPEkYH5N+++ZVpWZ13jocjy6B+ipuDEnzEB+qnSN+9fH2l1srIHGWYXYvX6AfSd7cxeX3ClhmkmaHGsvSad8jZEhO93dcvtcfO38+dBYq8nodckbsSR67I2GFYXqaA5IqM0MtvoVbVrsPhcV3E/MVMdQ1SC4dHZpue5gvlYlcg8cSxvJLuBqTFP5e4jomWW40WklMDN+/u38viIIVyETd/H8Hk9QkExQCon0IalED9lPv+Du/jW+rF9HbbMWkB8dEVLsdXqyq+2r3NLYMNtxpmvkCulEe5qmL6xnfMj+/z+BAenkVRLUKuKFcvg9rjeKbEdc9ZrsgolIuQ3ylQKjIKahGFctHSJOKFjZE5eo4opx2AVjmf18xuKlt49NePpqBsfXjBqZkuJi0ge2/XVPbaCuTkeikoBkwh2QYUHApwm8l4IhG7cLLju11xU7CFpHezn/QTzikknbfGSb/htM942fEXzgFFpWjX4rQipWw5sw6KSlFsjq3r7+XUIlJvUqB+irnhWVueFUruryKxv2r/StoMTujV6S2TxOgK1xlPLw7zXowFDgDkSnlcGxBx59OvHcVhmkFGcXaOMljcW+q4eBQHRBzPlBzFYTZIG8VJKVuIvJ6/cGWtVlWmrYkZHCZAZnBiez/o7N0UR3EsA/HEAQDlneIojiUg3jgsun+rOKaBHowsc8cBmo+zOIljCig+uoI1A4/rmsUBmjcDzGQRKxzDQPHRFSQMLOCs4LRmssgf84b2kVjiGAKyG6c9i/TenGSNoxvIKRwjSDxwdAHFPo8awknurzLF0YPEC0cX0IMvlh2r//OQHhV/svWcl2536L21y/tCW7H5JtUs+y9/RkrZ4n7OS5tVPTf77MJxIi4tsct23XoZRxfQ2sEvHRdrvY6jC6j1BFdK2fowg+RKeSzuLfU8jq4xqN+DAJBdhg6hCQUCQci4Ep3qSysQ1LHjSnSqr3qS4H4tB0146mp8VF5PEYHcnMU8tQQEreCqnIw98NQSJ9N8BCqERsjNpP8zx1MLnf6Rt/ZIg6LuSYAIAWh989tCMjQhAw07uF/Ltb/xHmh6a7Ia1CUAAAAAAElFTkSuQmCC',
    moderator: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAADsElEQVR42u2cv07bUBTGv3sTllYqXrqwNEOWLBDK1KGUlAcIUYU60wcIlAdI7ExVBxTYqz5ARVNGhiiUqUMrAktEhdSwFamDaSukisS3QwSYKH/859r3WPhMUezE9/58vu+cey2ZoT8+YAEsuQRm5QGWwl0IIZpgrAneNVBA236IXX+qQQN4GRZbw50OVsXvjoEVmDeAatDQTTbARBZx9DLqj5XDCkze+4aXYzj2JGJZPEiWexlUQwpW4kdMZUBYLMfRTegxiWGZZC1xgM3EJIZKLc9j7xkZqWSURruaLqI6vSE3ST6ORsAjcyvvPYKeKYV+3UgA0iY0NJ7WoU1oMaBBUc6UkLqvZtVDHtBquoi1dFHZ9UkDUuU7kQCk0nciAUil75AHpNp3SAOi4DtkAVHxHbKAqPgOSUCUfIccIGq+QwoQRd8hBYii75ABRNV3SACi7DvKAVH3HeWAqPuOUkBUfMe8NPH6aH3seQzbCRGm7xwsflMurfbFKXL7z9G+OKWTQVR8Z/NkC7P1OUdwACC0xz6qfce8NGG0KqiebLn6XSiAVPuOG0lJk9hquojs5Pin1qr7HbeSkgKonCmhOr2Bxnx9JCSVvnNVpdaO1mFemuGV+XKmdJ0R2oQ2EpIq32lfnGK2Pufab3wDssO5lSUDIKnyHb+S8twHDYLTn9K5/UU0zw+V9Dteq5QUQOPg2AdZ+PIC7x+/C1VafqqUFEDZyRk05mkuLjdPtqC3Kr6M2LcHNc8PkdtfDGwQKquU1LUYlUwKUlK+qhiFTJJdpaT3QaoghSUpadsdYcotTElJW4uFlUlhS0rqflCQkFRJSprEgpSbSklJzaCryE/lpcFRLan+8L1h5nQZomotpRSQLDiUJCVNYrLgAMDK11ck4XgGJBMOANSebDvavo0EINlwgPE7k5EB5BaO0apgtj7nqI+hCokHCUdvVVw1kxQh8SDheOm4qUHiQcPxCmlpKh8NQMzFnw2D4xbSuP8hBUhvVWA4GKzTSY2DRAmOYw8aB8ntpIZBogbHVRUbBsnrpPohUYQDAAm85LrTk/d+fQYDsPDwmZRJ/fx3ht2zXRz/Pcab729JdtKe9oOuqhrFO04C0F0KDtx+oVActhCiySHETkximL5Yk0PwTzGJYfrqGhzLnT0IthnT6JcXq6KAdq8PSnR0MNGMqVx7zwESHeOmUSzABLNycSZBQLAqEtZzFOwvebNHDaneW6nEDBjLKhtouJdrQ/AdCOxgubNnP/If0eYiZ8z2rLsAAAAASUVORK5CYII='
  };
  var NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    twitch: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z',
    youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    broadcaster: 'M12 5a7 7 0 100 14 7 7 0 000-14z',
    moderator: 'M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z',
    lead_moderator: 'M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z',
    vip: 'M12 2.5l8.5 8.5L12 21.5 3.5 11z',
    subscriber: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z',
    partner: 'M9.2 16.6L4.9 12.3l-1.6 1.6 5.9 5.9L21.2 7.8l-1.6-1.6z',
    staff: 'M12 2l8.7 5v10L12 22l-8.7-5V7z'
  };
  function svg(d) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d);
    s.appendChild(p); return s;
  }
  function hexOk(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null; }
  function isLight(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170;
  }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function timeText(ts, fmt) {
    var d = new Date(ts); if (isNaN(d.getTime())) return '';
    var h = d.getHours(), m = pad2(d.getMinutes());
    if (fmt === '12') return (h % 12 || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
    return pad2(h) + ':' + m;
  }
  var ROLE_KEY = { broadcaster: 'bcBroadcaster', moderator: 'bcModerator', lead_moderator: 'bcModerator', vip: 'bcVip', subscriber: 'bcSub', partner: 'bcPartner', staff: 'bcStaff' };

  function emote(part) {
    var url = part.image;
    if (typeof url !== 'string' || url.indexOf('https://') !== 0) return document.createTextNode(part.text);
    var img = el('img', 'sachat-emote');
    img.src = url; img.alt = part.text; img.title = part.text; img.loading = 'lazy';
    img.addEventListener('error', function () { img.replaceWith(document.createTextNode(part.text)); });
    return img;
  }
  function nameColor(m, v) {
    switch (v.nameColorMode) {
      case 'platform': return (PLATFORMS[m.platform] || {}).color || v.ac;
      case 'accent': return v.ac;
      case 'fixed': return v.nameColor;
      default: return hexOk(m.color) || v.ac;
    }
  }
  function renderMsg(m, v) {
    var d = el('div', 'sachat-msg');
    d.setAttribute('data-seq', String(m.seq));
    if (m.kind === 'system') {
      d.className += ' k-sys';
      d.textContent = ((PLATFORMS[m.platform] || {}).name ? PLATFORMS[m.platform].name + ': ' : '') + plainText(m);
      return d;
    }
    var paid = (m.kind === 'superchat' || m.kind === 'member') && v.paidOn;
    d.className += paid ? ' k-paid' : ' k-chat';

    var media = null;
    if (v.showMedia) {
      media = el('div', 'sachat-media');
      var plat = PLATFORMS[m.platform] || { color: v.ac };
      if (v.mUsePlat) media.style.background = SAW.rgba(plat.color, v.mBgOp);
      if (v.mKind === 'letter') {
        var l = el('span', 'ltr');
        l.textContent = Array.from(String(m.author || '?'))[0] || '?';
        l.style.color = v.mIcPlat ? plat.color : (hexOk(m.color) || v.mIc);
        media.appendChild(l);
      } else {
        if (ICONS[m.platform]) media.appendChild(svg(ICONS[m.platform]));
        media.style.color = v.mIcPlat ? plat.color : v.mIc;
      }
      media.title = (PLATFORMS[m.platform] || {}).name || '';
    }

    var body = el('div', 'sachat-body'), head = el('div', 'sachat-head');
    if (v.showTime) { var t = el('span', 'sachat-time'); t.textContent = timeText(m.ts, v.tmFmt); head.appendChild(t); }
    function addBadges() {
      if (!v.showBadges) return;
      var roles = (m.badges || []).map(function (b) { return b.role; });
      (m.badges || []).forEach(function (b) {
        if (b.role === 'moderator' && roles.indexOf('lead_moderator') >= 0) return;   // ведущий модератор — уже модератор
        var role = ROLE_KEY[b.role] ? b.role : 'dot', c = v[ROLE_KEY[b.role]] || v.ac;
        var s, img = v.bdStyle === 'image' ? BADGE_IMG[b.role] : null;
        if (img) {                                  // готовая картинка роли
          s = el('img', 'sachat-bd image'); s.src = img; s.alt = b.label || ''; s.title = b.label || '';
          head.appendChild(s); return;
        }
        s = el('span', 'sachat-bd ' + (v.bdStyle === 'image' ? 'icon' : v.bdStyle));   // у роли нет картинки — цветной значок
        s.style.background = c; s.title = b.label || '';
        if (v.bdStyle === 'icon' || v.bdStyle === 'image') { s.style.color = isLight(c) ? '#111' : '#fff'; s.appendChild(svg(ICONS[role] || ICONS.broadcaster)); }
        else if (v.bdStyle === 'pill') { s.style.color = isLight(c) ? '#111' : '#fff'; s.textContent = b.label || ''; }
        head.appendChild(s);
      });
    }
    if (v.bdPosR === 'before') addBadges();
    var who = el('b', 'sachat-name');
    who.textContent = String(m.author || '') + (v.nameLine === 'inline' && SEPS[v.nameSep] ? SEPS[v.nameSep] : '');
    if (!paid) who.style.color = nameColor(m, v);
    head.appendChild(who);
    if (v.bdPosR === 'after') addBadges();
    if (m.amount) { var a = el('span', 'sachat-amt'); a.textContent = String(m.amount); head.appendChild(a); }
    body.appendChild(head);
    if (v.nameLine === 'inline') body.appendChild(document.createTextNode(' '));

    var tx = el('div', 'sachat-text');
    (m.parts || []).forEach(function (p) {
      tx.appendChild(p.image && v.showEmotes ? emote(p) : document.createTextNode(p.text));
    });
    body.appendChild(tx);

    var mside = v.mSideR || (v.mSide === 'right' ? 'right' : 'left');
    if (media && mside === 'left') d.appendChild(media);
    d.appendChild(body);
    if (media && mside === 'right') d.appendChild(media);
    return d;
  }

  // ——— Живой виджет ———————————————————————————————————————————————————————
  // opts: { mode:'obs'|'app', w, h, k }  — w/h/k нужны только предпросмотру: виджет рисуется
  // в натуральном размере w×h пикселей оверлея и уменьшается на k, чтобы пиксели совпали с OBS.
  function create(host, values, opts) {
    opts = opts || {};
    ensureCss(host.ownerDocument || document);
    var rootEl = el('div', 'sachat'), listEl = el('div', 'sachat-list');
    rootEl.appendChild(listEl); host.appendChild(rootEl);
    var st = { c: compile(values, opts), list: [], have: {}, timers: {}, dead: false };

    function applyLook() {
      st.c = compile(st.vals, opts);
      var vs = st.c.vars;
      Object.keys(vs).forEach(function (k) { rootEl.style.setProperty(k, vs[k]); });
      rootEl.className = 'sachat ' + st.c.classes.join(' ');
    }
    function size(o) {
      if (o && o.w && o.h) {
        rootEl.style.width = o.w + 'px'; rootEl.style.height = o.h + 'px';
        rootEl.style.transform = 'scale(' + (o.k || 1) + ')'; rootEl.style.transformOrigin = '0 0';
      }
    }
    st.vals = values; applyLook(); size(opts);

    function visible() {
      var v = st.c.values, out = st.list.filter(function (m) { return accept(m, v); });
      return out.slice(-v.max);
    }
    function clearTimers() { Object.keys(st.timers).forEach(function (k) { clearTimeout(st.timers[k]); }); st.timers = {}; }
    function drop(seq) {
      var i = st.list.findIndex(function (m) { return m.seq === seq; });
      if (i >= 0) st.list.splice(i, 1);
      delete st.timers[seq];
      var n = listEl.querySelector('[data-seq="' + seq + '"]');
      if (!n) return;
      var out = st.c.values.aout;
      if (out > 0) { n.classList.add('is-out'); setTimeout(function () { if (n.parentNode) n.remove(); }, out + 30); }
      else n.remove();
    }
    function arm(m) {
      var life = st.c.values.life;
      if (life > 0 && !st.timers[m.seq]) st.timers[m.seq] = setTimeout(function () { drop(m.seq); }, life * 1000);
    }
    // Сообщения не режутся пополам: что не помещается в блок целиком — убирается (самое старое).
    // Считаем по offsetHeight (без transform), поэтому анимация появления не влияет на расчёт.
    function fit() {
      if (st.dead || !listEl.isConnected) return;
      var cs = getComputedStyle(listEl), gap = parseFloat(cs.rowGap) || 0,
          room = listEl.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0),
          top = st.c.values.dir === 'top', kids = listEl.children, total = 0, i;
      if (!(room > 0)) return;
      for (i = 0; i < kids.length; i++) total += kids[i].offsetHeight + (i ? gap : 0);
      while (total > room + 0.5 && kids.length > 1) {
        var old = top ? listEl.lastChild : listEl.firstChild;
        total -= old.offsetHeight + gap; old.remove();
      }
    }
    listEl.addEventListener('load', fit, true);   // картинка (смайл) догрузилась и изменила высоту
    function paint(fresh) {
      var v = st.c.values, vis = visible(), nodes;
      if (v.dir === 'top') vis = vis.slice().reverse();
      nodes = vis.map(function (m) {
        var n = renderMsg(m, v);
        if (fresh && fresh === m.seq) n.classList.add('is-new');
        return n;
      });
      listEl.replaceChildren.apply(listEl, nodes);
      fit();
    }
    var api = {
      push: function (m) {
        if (st.dead || !m || st.have[m.seq] || !Array.isArray(m.parts)) return;
        st.have[m.seq] = true;
        var i = st.list.length;
        while (i > 0 && st.list[i - 1].ts > m.ts) i--;
        st.list.splice(i, 0, m);
        if (st.list.length > 120) { var gone = st.list.shift(); delete st.have[gone.seq]; }
        if (!accept(m, st.c.values)) return;
        var v = st.c.values, tail = i === st.list.length - 1;
        if (tail) {
          var n = renderMsg(m, v); n.classList.add('is-new');
          if (v.dir === 'top') listEl.insertBefore(n, listEl.firstChild); else listEl.appendChild(n);
          while (listEl.children.length > v.max) {
            var old = v.dir === 'top' ? listEl.lastChild : listEl.firstChild; old.remove();
          }
          fit();
        } else paint(m.seq);
        arm(m);
      },
      setMessages: function (arr) {
        clearTimers(); st.list = []; st.have = {};
        (arr || []).forEach(function (m) {
          if (!m || st.have[m.seq] || !Array.isArray(m.parts)) return;
          st.have[m.seq] = true; st.list.push(m);
        });
        st.list.sort(function (a, b) { return a.ts - b.ts || a.seq - b.seq; });
        paint(0);
        visible().forEach(arm);
      },
      update: function (vals, o) { st.vals = vals; if (o) { opts = o; size(o); } applyLook(); paint(0); visible().forEach(arm); },
      clear: function () { clearTimers(); st.list = []; st.have = {}; listEl.replaceChildren(); },
      destroy: function () { st.dead = true; clearTimers(); rootEl.remove(); },
      fit: fit,   // пересчитать, что помещается (если виджет создан до вставки в страницу)
      root: rootEl
    };
    return api;
  }

  // ——— Образцы сообщений для предпросмотра ————————————————————————————————
  function demo(now) {
    now = now || Date.now();
    function m(seq, platform, author, color, text, extra) {
      var o = { seq: seq, id: 'demo' + seq, platform: platform, kind: 'chat', author: author, color: color, badges: [], parts: [{ text: text }], ts: now - (12 - seq) * 20000, amount: null };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      return o;
    }
    return [
      m(1, 'twitch', 'mint_fox', '#ff6b9d', 'Привет всем! Как настроение?', { badges: [{ role: 'subscriber', label: 'Подписчик' }] }),
      m(2, 'twitch', 'Nightbot', '#5aa0ff', 'Добро пожаловать на стрим! Правила — в описании.', { badges: [{ role: 'moderator', label: 'Модератор' }] }),
      m(3, 'youtube', 'Tysune_42', null, 'Классный трек, подскажите название?', { badges: [{ role: 'partner', label: 'Подтверждён' }] }),
      m(4, 'twitch', 'from_north', '#7cf0a8', '!song Nightcall', { badges: [{ role: 'lead_moderator', label: 'Ведущий модератор' }, { role: 'moderator', label: 'Модератор' }] }),
      m(5, 'twitch', 'Фоксяндрия', '#ffb703', 'Спасибо за стрим, очень нравится атмосфера!', { badges: [{ role: 'broadcaster', label: 'Стример' }, { role: 'vip', label: 'VIP' }] }),
      m(6, 'youtube', 'kit_fox', '#c084fc', 'Когда будет аукцион?', { kind: 'chat', badges: [{ role: 'lead_moderator', label: 'Ведущий модератор' }] }),
      m(7, 'youtube', 'Заяц Иван', '#ffffff', 'Держи, на новый микрофон!', { kind: 'superchat', amount: '500 ₽', badges: [{ role: 'subscriber', label: 'Спонсор канала' }] }),
      m(8, 'twitch', 'ModBot', null, 'from_north получил таймаут на 10 минут', { kind: 'system' }),
      m(9, 'twitch', 'long_nick_example', '#3ea6ff', 'Очень длинное сообщение, чтобы проверить, как блок переносит строки и держит ширину при большом количестве текста.')
    ];
  }

  var def = SAW.register({ id: 'chat', kind: 'Чат', name: 'Чат', v: 1, schema: SCHEMA, presets: PRESETS, keep: KEEP });
  // старые настройки чата (до общего формата): sz — размер текста в %, ac — название цвета
  def.migrate = function (c) {
    var out = Object.assign({}, c || {});
    if (out.sz !== undefined && out.scale === undefined) out.scale = out.sz;
    delete out.sz;
    var names = { 'Оранжевый': '#ff7a1a', 'Фиолетовый': '#8b5cf6', 'Белый': '#f5f3f9' };
    if (names[out.ac]) out.ac = names[out.ac];
    return out;
  };
  SAW.chat = { schema: SCHEMA, presets: PRESETS, keep: KEEP, compile: compile, accept: accept, create: create, demo: demo, css: CSS, renderMsg: renderMsg };
  if (typeof module !== 'undefined' && module.exports) module.exports = SAW.chat;
})(typeof window !== 'undefined' ? window : globalThis);

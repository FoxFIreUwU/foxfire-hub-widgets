#!/usr/bin/env python3
"""Перегенерирует PREVIEW_HTML_FALLBACK в settings.html из index.html.
Запускать из папки виджета после любых правок index.html."""
import json, re
h = open('index.html', encoding='utf-8').read()
s = open('settings.html', encoding='utf-8').read()
lit = json.dumps(h, ensure_ascii=False).replace('</', '<\\/')
new, n = re.subn(r'^    const PREVIEW_HTML_FALLBACK = .*;$', lambda m: '    const PREVIEW_HTML_FALLBACK = ' + lit + ';', s, count=1, flags=re.M)
assert n == 1, 'const PREVIEW_HTML_FALLBACK не найден'
open('settings.html', 'w', encoding='utf-8').write(new)
print('готово')

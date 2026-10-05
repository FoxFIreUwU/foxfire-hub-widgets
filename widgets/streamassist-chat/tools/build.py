#!/usr/bin/env python3
"""Собирает index.html и settings.html: вшивает JS-файлы прямо в страницы.
Зачем: внутри Hub страница настроек открыта во вложенном окне, и Tauri не отдаёт ей соседние файлы
(asset.localhost отказывает), поэтому подгрузка <script src> не работает. Вшитый код работает везде.
Запуск после любой правки .js или шаблонов:  python3 tools/build.py"""
import os, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def build(template, out):
    s = open(os.path.join(root, 'tools', template), encoding='utf8').read()
    def sub(m):
        js = open(os.path.join(root, m.group(1)), encoding='utf8').read()
        js = re.sub(r'</(script)', r'<\\/\1', js, flags=re.I)   # в коде такого нет, только в комментарии моста
        return '<script>\n' + js.rstrip() + '\n</script>'
    s = re.sub(r'<!--INLINE ([\w.\-]+)-->', sub, s)
    open(os.path.join(root, out), 'w', encoding='utf8').write(s)
    print(out, len(s) // 1024, 'КБ')
build('index.template.html', 'index.html')
build('settings.template.html', 'settings.html')

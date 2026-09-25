// Settings.tsx — по конвенции из SYSTEM_WIDGET_STYLE.md (раздел 1) это "панель
// настроек виджета". В ТЕКУЩЕЙ версии FoxFire Hub (0.1.0-alpha.1) этот файл не
// подключается напрямую — приложение уже умеет само рисовать панель настроек
// по полю configSchema из widget.manifest.json (см. WidgetModal.tsx в основном
// приложении), поэтому для простых виджетов отдельный файл не обязателен.
//
// Он оставлен здесь как пример на будущее — если виджету понадобится настройка
// сложнее, чем просто цвет/число/текст/чекбокс/выпадающий список (например,
// предпросмотр в реальном времени прямо внутри панели), автор сможет заменить
// этим компонентом автоматическую генерацию из configSchema.
import { useState } from "react";

interface StreamTimerConfig {
  textColor: string;
  fontSize: number;
  longFormat: boolean;
}

interface StreamTimerSettingsProps {
  value: StreamTimerConfig;
  onChange: (next: StreamTimerConfig) => void;
}

export default function StreamTimerSettings({ value, onChange }: StreamTimerSettingsProps) {
  const [config, setConfig] = useState(value);

  function update<K extends keyof StreamTimerConfig>(key: K, next: StreamTimerConfig[K]) {
    const updated = { ...config, [key]: next };
    setConfig(updated);
    onChange(updated);
  }

  return (
    <div className="streamtimer-settings">
      <label>
        Цвет текста
        <input type="color" value={config.textColor} onChange={(e) => update("textColor", e.target.value)} />
      </label>

      <label>
        Размер шрифта (px)
        <input
          type="number"
          value={config.fontSize}
          onChange={(e) => update("fontSize", Number(e.target.value))}
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={config.longFormat}
          onChange={(e) => update("longFormat", e.target.checked)}
        />
        Формат чч:мм:сс (вместо мм:сс)
      </label>
    </div>
  );
}

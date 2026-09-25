// См. пояснение в widgets/stream-timer/Settings.tsx — этот файл тоже необязателен
// в текущей версии FoxFire Hub 0.1.0-alpha.1, панель настроек строится автоматически
// из configSchema в widget.manifest.json. Оставлен как пример на будущее.
import { useState } from "react";

interface StreamClockConfig {
  textColor: string;
  fontSize: number;
  use24h: boolean;
}

interface StreamClockSettingsProps {
  value: StreamClockConfig;
  onChange: (next: StreamClockConfig) => void;
}

export default function StreamClockSettings({ value, onChange }: StreamClockSettingsProps) {
  const [config, setConfig] = useState(value);

  function update<K extends keyof StreamClockConfig>(key: K, next: StreamClockConfig[K]) {
    const updated = { ...config, [key]: next };
    setConfig(updated);
    onChange(updated);
  }

  return (
    <div className="streamclock-settings">
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
        <input type="checkbox" checked={config.use24h} onChange={(e) => update("use24h", e.target.checked)} />
        24-часовой формат
      </label>
    </div>
  );
}

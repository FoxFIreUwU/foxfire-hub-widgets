// Settings.tsx — по конвенции из SYSTEM_WIDGET_STYLE.md (раздел 1) это "панель
// настроек виджета". FoxFire Hub уже умеет сам рисовать панель настроек по полю
// configSchema из widget.manifest.json (см. WidgetModal.tsx в основном
// приложении), поэтому для этого виджета отдельный файл не обязателен — все поля
// (text/number/boolean/select/color) стандартные и покрываются автогенерацией.
//
// Файл оставлен здесь как образец на будущее — например, если понадобится
// живой предпросмотр чата прямо внутри панели настроек, а не только в отдельном
// окне запущенного виджета.
import { useState } from "react";

interface UnifiedChatConfig {
  twitchChannel: string;
  youtubeMode: "Вручную (Video ID + ключ)" | "Вход через Google (авто)";
  youtubeVideoId: string;
  youtubeApiKey: string;
  googleClientId: string;
  direction: "Новые снизу" | "Новые сверху";
  fontSize: number;
  maxMessages: number;
  bgOpacity: number;
  showPlatformIcons: boolean;
  showBadges: boolean;
  showTimestamps: boolean;
  textColor: string;
}

interface UnifiedChatSettingsProps {
  value: UnifiedChatConfig;
  onChange: (next: UnifiedChatConfig) => void;
}

export default function UnifiedChatSettings({ value, onChange }: UnifiedChatSettingsProps) {
  const [config, setConfig] = useState(value);

  function update<K extends keyof UnifiedChatConfig>(key: K, next: UnifiedChatConfig[K]) {
    const updated = { ...config, [key]: next };
    setConfig(updated);
    onChange(updated);
  }

  return (
    <div className="unifiedchat-settings">
      <label>
        Логин канала Twitch
        <input
          type="text"
          value={config.twitchChannel}
          onChange={(e) => update("twitchChannel", e.target.value)}
          placeholder="my_channel"
        />
      </label>

      <label>
        Режим YouTube
        <select value={config.youtubeMode} onChange={(e) => update("youtubeMode", e.target.value as UnifiedChatConfig["youtubeMode"])}>
          <option value="Вручную (Video ID + ключ)">Вручную (Video ID + ключ)</option>
          <option value="Вход через Google (авто)">Вход через Google (авто)</option>
        </select>
      </label>

      <label>
        Video ID трансляции (для режима "Вручную")
        <input
          type="text"
          value={config.youtubeVideoId}
          onChange={(e) => update("youtubeVideoId", e.target.value)}
          placeholder="dQw4w9WgXcQ"
        />
      </label>

      <label>
        API-ключ YouTube (для режима "Вручную")
        <input
          type="text"
          value={config.youtubeApiKey}
          onChange={(e) => update("youtubeApiKey", e.target.value)}
          placeholder="AIzaSy..."
        />
      </label>

      <label>
        Google Client ID (для режима "Вход через Google")
        <input
          type="text"
          value={config.googleClientId}
          onChange={(e) => update("googleClientId", e.target.value)}
          placeholder="1234567890-abc.apps.googleusercontent.com"
        />
      </label>

      <label>
        Направление ленты
        <select value={config.direction} onChange={(e) => update("direction", e.target.value as UnifiedChatConfig["direction"])}>
          <option value="Новые снизу">Новые снизу</option>
          <option value="Новые сверху">Новые сверху</option>
        </select>
      </label>

      <label>
        Размер шрифта (px)
        <input type="number" value={config.fontSize} onChange={(e) => update("fontSize", Number(e.target.value))} />
      </label>

      <label>
        Сколько сообщений держать на экране
        <input type="number" value={config.maxMessages} onChange={(e) => update("maxMessages", Number(e.target.value))} />
      </label>

      <label>
        Непрозрачность фона карточки (%)
        <input type="number" value={config.bgOpacity} onChange={(e) => update("bgOpacity", Number(e.target.value))} />
      </label>

      <label>
        <input
          type="checkbox"
          checked={config.showPlatformIcons}
          onChange={(e) => update("showPlatformIcons", e.target.checked)}
        />
        Показывать значок площадки
      </label>

      <label>
        <input type="checkbox" checked={config.showBadges} onChange={(e) => update("showBadges", e.target.checked)} />
        Показывать бейджи
      </label>

      <label>
        <input
          type="checkbox"
          checked={config.showTimestamps}
          onChange={(e) => update("showTimestamps", e.target.checked)}
        />
        Показывать время сообщения
      </label>

      <label>
        Цвет текста сообщений
        <input type="color" value={config.textColor} onChange={(e) => update("textColor", e.target.value)} />
      </label>
    </div>
  );
}

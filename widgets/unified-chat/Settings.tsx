// Settings.tsx — по конвенции из SYSTEM_WIDGET_STYLE.md (раздел 1) это "панель
// настроек виджета". FoxFire Hub умеет сам рисовать простую панель настроек по
// полю configSchema из widget.manifest.json (см. WidgetModal.tsx в основном
// приложении) — она по-прежнему работает как fallback и покрывает все поля
// (text/number/boolean/select/color) автогенерацией.
//
// НО с версии 2.0.0 у этого виджета есть полноценное отдельное окно настроек
// с живым предпросмотром — settings.html в этой же папке (обычный HTML/JS,
// без сборки, как и index.html, — так виджет остаётся простым статическим
// набором файлов без build-шага). Это основной способ настройки, к которому
// стоит вести пользователя; см. README.md, раздел "Для следующего агента /
// интеграция с Hub" — там описано, чего не хватает на стороне самого Hub,
// чтобы открывать settings.html вместо этой автоформы.
//
// Файл оставлен здесь как образец компонента для будущей единой менюшки
// плагинов в Hub (см. задачу пользователя) — когда там появится общий
// механизм для "богатых" панелей настроек виджетов, эта форма и форма из
// settings.html — кандидаты на перенос в React-компонент такого вида.
import { useState } from "react";

interface UnifiedChatConfig {
  twitchChannel: string;
  youtubeChannel: string;
  youtubeApiKey: string;
  youtubeVideoIdOverride: string;
  direction: "Новые снизу" | "Новые сверху";
  fontFamily: string;
  fontFamilyCustom: string;
  animationStyle: string;
  scale: number;
  fontSize: number;
  messageSpacing: number;
  cornerRadius: number;
  maxMessages: number;
  bgOpacity: number;
  showPlatformIcons: boolean;
  showBadges: boolean;
  showTimestamps: boolean;
  highlightModActions: boolean;
  enableThirdPartyEmotes: boolean;
  textColor: string;
  accentColor: string;
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
        Канал YouTube (ссылка, @handle или ID)
        <input
          type="text"
          value={config.youtubeChannel}
          onChange={(e) => update("youtubeChannel", e.target.value)}
          placeholder="@my_channel"
        />
      </label>

      <label>
        Video ID вручную (необязательно, запасной вариант)
        <input
          type="text"
          value={config.youtubeVideoIdOverride}
          onChange={(e) => update("youtubeVideoIdOverride", e.target.value)}
          placeholder="dQw4w9WgXcQ"
        />
      </label>

      <label>
        API-ключ YouTube (свой)
        <input
          type="text"
          value={config.youtubeApiKey}
          onChange={(e) => update("youtubeApiKey", e.target.value)}
          placeholder="AIzaSy..."
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

# Arkhiv — текстовий редактор

## Структура файлів для GitHub

```
index.html      ← головний файл
style.css       ← стилі
app.js          ← логіка
manifest.json   ← PWA конфіг
sw.js           ← Service Worker (офлайн)
icon-192.png    ← іконка PWA
icon-512.png    ← іконка PWA (велика)
icon-180.png    ← іконка для iOS
favicon.png     ← favicon браузера
```

## Публікація на GitHub Pages

1. Створи репозиторій (наприклад `tree-editor`)
2. Завантаж ВСІ файли вище
3. Settings → Pages → Branch: `main`, folder: `/ (root)` → Save
4. Через ~2 хв сайт буде на `https://<username>.github.io/tree-editor/`

## Встановлення як PWA

### Android (Chrome)
- Відкрий сайт → меню ⋮ → "Встановити застосунок"

### iOS (Safari)
- Відкрий сайт → кнопка Поділитись → "На екран Додому"

### ПК (Chrome/Edge)
- Відкрий сайт → іконка ⊕ в адресному рядку → "Встановити"

## Firebase

1. console.firebase.google.com → твій проєкт
2. Project Settings → Your apps → </> → скопіюй конфіг
3. В Arkhiv натисни ☁ → встав JSON → Підключити

## Клавіатурні скорочення

| Ctrl+S       | Зберегти          |
| Ctrl+N       | Нова сторінка     |
| Ctrl+Shift+P | Markdown Preview  |

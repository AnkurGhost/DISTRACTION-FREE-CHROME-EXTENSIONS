# DISTRACTION-FREE-CHROME-EXTENSIONS
[svg](https://github.com/AnkurGhost/DISTRACTION-FREE-CHROME-EXTENSIONS#distraction-free-chrome-extensions)

A Manifest V3 Brave/Chromium extension for slowing down impulsive site opening, blocking sites, tracking usage, and adding optional built-in web tools.

## Features

[svg](https://github.com/AnkurGhost/DISTRACTION-FREE-CHROME-EXTENSIONS#features)

- Think list with a configurable 1–600 second wait.
- Block list.
- One-time open bypass so clicking **Open website** does not immediately restart the thinking timer.
- Daily, weekly, and monthly local usage charts.
- Built-in YouTube distraction remover controls inspired by Unhook-style cleanup.
- Built-in **Convert Case** context-menu tool for selected text.
- URL exclusion feature removed.

## Install in Brave

[svg](https://github.com/AnkurGhost/DISTRACTION-FREE-CHROME-EXTENSIONS#install-in-brave)

1. Extract this ZIP.
2. Open `brave://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted extension folder (the folder containing `manifest.json`).
6. Click the extension icon or open Options to use the dashboard.

## Notes

[svg](https://github.com/AnkurGhost/DISTRACTION-FREE-CHROME-EXTENSIONS#notes)

- ⚠️AI is heavily utilized to create this extension⚠️
- The extension stores settings and usage locally in extension storage.
- Convert Case uses the Chromium contextMenus API and active-tab scripting when the user invokes the menu.
- YouTube’s DOM changes over time; the built-in cleanup uses CSS selectors and a MutationObserver and may need selector updates if YouTube changes its markup.

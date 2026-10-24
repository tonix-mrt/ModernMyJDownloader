# ModernMyJDownloader (v1.1)

A Manifest V3 rewrite and modernization of the official **MyJDownloader Browser Extension** for Google Chrome and Chromium-based browsers.

## Features

- **Manifest V3 Architecture**:
  - Event-driven Service Worker (`background.js`) with `chrome.storage.session` state persistence.
  - Click'n'Load (`127.0.0.1:9666` / `localhost:9666`) interception via `declarativeNetRequest` dynamic and session rules.
  - Context menu, clipboard observer, autograbber, and remote device status management via the MyJDownloader Cloud API (`scripts/background/jdapi-sw.js`).
- **Modern Web Enhancements**:
  - **Adaptive Light & Dark Mode**: Automatic system color-scheme support (`color-scheme: light dark`, `light-dark()` CSS color tokens, and `@media (prefers-color-scheme: dark)` fallbacks).
  - **Accessibility & Keyboard Navigation**: Semantic HTML landmarks, ARIA states (`role="checkbox"`, `aria-checked`, `aria-label`, `role="alert"` / `role="status"` live regions), `:focus-visible` focus rings, and `prefers-reduced-motion` support.
  - **Password Manager & Autofill Support**: Standardized `autocomplete="username"`, `autocomplete="current-password"`, `inputmode="email"`, and `enterkeyhint` attributes on the login form.
  - **Safe HTML Parsing & DOM Construction**: Inert HTML parsing (`Document.parseHTML()` / `DOMParser`) and safe DOM APIs instead of raw `innerHTML` concatenation.
  - **Modern CSS Sticky Header**: Pure CSS `position: sticky` with scroll-state container queries (`@container selection-header scroll-state(stuck: top)`).

## Installation (Unpacked)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select this project folder.

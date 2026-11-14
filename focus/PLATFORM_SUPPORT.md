# Focus — Platform Support

| Platform | Priority | Code | Build | Tested | Verified on device |
|---|---|---|---|---|---|
| Web / PWA (Chromium) | — | ✅ | ✅ `vite build` | ✅ Playwright desktop + Pixel 7 emulation | ❌ |
| Android (Pixel) | Highest | Shared UI ready (touch, safe areas, back via history) | ❌ No Tauri Android project yet | Emulated viewport only | ❌ |
| Windows 11 | Highest | Shared UI ready (keyboard, sidebar, resizable panel, DnD) | ❌ | Chromium desktop only | ❌ |
| macOS | Compatibility | Shared | ❌ | ❌ | ❌ |
| iOS / iPadOS | Compatibility | Shared | ❌ requires macOS + Xcode | ❌ | ❌ |

## Today: using it on a Pixel or Windows PC

The PWA build can be installed from Chrome on Android ("Add to Home screen"/"Install app") and from Edge/Chrome on
Windows ("Install Focus"). Data is stored in the browser's IndexedDB for that origin; the app requests persistent
storage so the browser does not evict it. Back up regularly from Settings → Data until native builds exist.

## Known limitations

- **Reminders are stored but not delivered.** Reliable scheduled notifications need native APIs (Android
  AlarmManager/WorkManager, Windows toast scheduling); a PWA cannot schedule notifications while closed. Phase 2.
- **One tab at a time.** A second tab shows an explanation instead of risking overwrites.
- **Drag and drop** uses HTML5 DnD (mouse). On touch, use swipe, the ⋯ menu, or the date picker.
- **Storage eviction.** Browsers may evict non-persistent storage under pressure; Settings shows whether a backup exists.

## Build environment (session 1)

The development container had Node 22, Rust 1.97, Chromium/Playwright; it had **no Android SDK/NDK, no WebKitGTK and
no Windows toolchain**, so no native build was attempted. Native packaging (Tauri 2) is scheduled for Phase 5; plugin
support for Android notifications must be verified then (ADR-008: Capacitor is the fallback).

# Focus — Platform Support

| Platform | Priority | Code | Build | Tested | Verified on device |
|---|---|---|---|---|---|
| Web / PWA (Chromium) | — | ✅ | ✅ `vite build` | ✅ Playwright desktop + Pixel 7 emulation, offline reload | ❌ |
| Linux desktop (Tauri, WebKitGTK) | Dev only | ✅ | ✅ `.deb` release bundle (3.2 MB) | ✅ native persistence round trip under Xvfb | ❌ |
| Windows 11 (Tauri, WebView2) | Highest | ✅ shared shell + per-user NSIS installer config | ❌ must be built on Windows | ❌ | ❌ |
| Android (Pixel, Tauri) | Highest | ✅ mobile entry point in Rust; UI touch-ready | ❌ needs Android SDK/NDK (`tauri android init`) | Emulated viewport only | ❌ |
| macOS | Compatibility | Shared | ❌ requires a Mac | ❌ | ❌ |
| iOS / iPadOS | Compatibility | Shared | ❌ requires macOS + Xcode | ❌ | ❌ |

"Verified on device" means tested on physical hardware. Nothing has been yet.

## Native storage (all Tauri platforms)

The database is a real SQLite file in the OS app-data folder, e.g.
`%APPDATA%\uk.periopdigital.focus\focus.sqlite` on Windows. Saves are atomic (temp file → fsync → rename) and the
previous copy is kept as `focus.prev.sqlite`; pre-migration and pre-restore snapshots go to `snapshots\`;
attachments to `attachments\`. A single-instance guard stops a second copy of the app opening the same database.
Closing the window flushes pending changes first.

## Building the Windows app (on your Windows 11 PC)

One-time setup:
1. Install **Microsoft C++ Build Tools** (visualstudio.microsoft.com → "Build Tools for Visual Studio";
   select the "Desktop development with C++" workload).
2. Install **Rust** from rustup.rs (accept the defaults).
3. WebView2 is already part of Windows 11.

Then, in PowerShell inside `la-calc\focus`:
```powershell
git pull
npm install
npm run desktop:dev     # runs the native app with live reload
npm run desktop:build   # creates the installer
```
The installer appears in `src-tauri\target\release\bundle\nsis\Focus_0.3.0_x64-setup.exe`. It installs for the
current user only, so no administrator rights are needed. The first build takes several minutes. Because the
installer isn't code-signed, Windows SmartScreen will warn ("More info → Run anyway").

**Data note:** the desktop app and the browser version keep **separate** data. To move tasks across, use
Settings → Data → Back up (JSON) in one and Restore in the other.

## Building for Android (Pixel)

Not yet attempted: the build container can't download the Android SDK. On a PC with Android Studio installed
(SDK, NDK and a JDK), run `npx tauri android init` once, then `npx tauri android dev` with the Pixel connected over
USB with USB debugging on. Native notification scheduling (Phase 2) will be assessed on Android at that point (ADR-008).

## Known limitations

- **Reminders fire while Focus is running** (in-app, plus system notifications if enabled). They cannot fire while
  the browser tab or desktop app is fully closed; missed ones are shown on the next launch. Background delivery on the
  Pixel needs the Android build (ADR-010).
- **Browser: one tab at a time.** A second tab shows an explanation instead of risking overwrites.
- **Drag and drop** is mouse-only; on touch, use swipe, the ⋯ menu, or the task's project/section picker.
- **Browser storage eviction**: the PWA requests persistent storage. Back up until you move to the native app.
- **App identifier** `uk.periopdigital.focus` is based on the domain your other apps use. It becomes the Android
  package name and is hard to change after a store release, so confirm it before publishing.

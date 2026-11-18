# Focus — Platform Support

| Platform | Priority | Code | Build | Tested | Verified on device |
|---|---|---|---|---|---|
| Browser build (tests and development only; not distributed since 0.9.0) | — | ✅ | ✅ `vite build` | ✅ Playwright desktop + Pixel 7 emulation | — |
| Linux desktop (Tauri, WebKitGTK) | Dev only | ✅ | ✅ `.deb` release bundle (3.2 MB) | ✅ native persistence round trip under Xvfb | ❌ |
| Windows 11 (Tauri, WebView2) | Highest | ✅ shared shell + per-user NSIS installer config | ✅ NSIS installer built by GitHub Actions on every push (`.github/workflows/focus-windows.yml`) | ❌ | ❌ |
| Android (Pixel, Tauri) | Highest | ✅ generated project in `src-tauri/gen/android` | ✅ signed release APK, arm64 (11 MB) | Emulated viewport only; APK not run (no emulator in the build container) | ❌ |
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
The installer appears in `src-tauri\target\release\bundle\nsis\Focus_0.5.0_x64-setup.exe`. It installs for the
current user only, so no administrator rights are needed. The first build takes several minutes. Because the
installer isn't code-signed, Windows SmartScreen will warn ("More info → Run anyway").

**Data note:** the desktop app and the browser version keep **separate** data. To move tasks across, use
Settings → Data → Back up (JSON) in one and Restore in the other.

## Building for Android (Pixel)

The APK is built in the cloud session (Android SDK + NDK 29, Rust `aarch64-linux-android`):

```bash
export ANDROID_HOME=~/android-sdk NDK_HOME=~/android-sdk/ndk/29.0.14206865
npx tauri android build --target aarch64 --apk --ci
# → src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

**Signing.** Release builds are signed with the Focus key (`focus-release.jks`, alias `focus`). The key and its
password are *not* in the repository: `src-tauri/gen/android/keystore.properties` (git-ignored) points at them:

```properties
storeFile=/path/to/focus-release.jks
keyAlias=focus
password=…
```

Android only installs an update over an existing app if it is signed with the same key, so **every future build must
use this key** — otherwise you would have to uninstall Focus (losing its data) first. Without `keystore.properties`
the release APK is unsigned and will not install.

**Installing on the Pixel:** copy the APK to the phone, open it, and allow "Install unknown apps" for the app you
opened it from. Android's data is separate from the browser and desktop versions: move tasks with
Settings → Data → Back up / Restore.

Native notification scheduling and voice on Android are still to be assessed on the device (ADR-008).

## Known limitations

- **Reminders fire while Focus is running** (in-app, plus system notifications if enabled). They cannot fire while
  the browser tab or desktop app is fully closed; missed ones are shown on the next launch. Background delivery on the
  Pixel needs the Android build (ADR-010).
- **Drag and drop** is mouse-only; on touch, use swipe, the ⋯ menu, or the task's project/section picker.
- **No web/PWA version** (dropped in 0.9.0): Focus ships as the Android app and the Windows (and Linux) desktop app.
  The browser build remains only for automated tests and development.
- **Android secrets** (AI keys, webhook secrets, calendar addresses) are encrypted with the Android Keystore; iOS keeps them for the session only.
- **Local API / Claude connector:** desktop app only. On Linux the keychain needs a Secret Service (GNOME
  Keyring or KWallet); without one the API can't store its token and shows an error.
- **Exports on Android** open the share sheet (choose Files / Drive / email); on desktop they go to Downloads.
- **Calendar subscriptions in the browser** are usually blocked by the calendar servers (CORS); import a .ics file
  instead, or use the desktop/Android app.
- **Sync:** desktop and Android keep the sync key in secure storage; the browser keeps it for the session only and
  asks for it again after a restart. Android also syncs in the background about every 15 minutes while Focus is
  closed (WorkManager; Android may delay it to save battery). Attachment files and compaction happen when the app
  is open.
- **Voice:** Chrome's recogniser is online by default; on-device recognition is experimental (ADR-012).
- **App identifier** `uk.periopdigital.focus` is based on the domain your other apps use. It becomes the Android
  package name and is hard to change after a store release, so confirm it before publishing.

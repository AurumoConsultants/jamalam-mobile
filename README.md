# Jamalam Mobile

The capture + creativity app (Android + iPhone), built with **React + Vite + Tone.js**, wrapped as a native app by **Capacitor**. It reuses the shared audio core from the desktop app (`engine.ts`, `kits.ts`, `beatbox.ts`, `types.ts`).

**Vision role:** record & overdub multitrack, capture group jams (split to stems), turn mouth/body sounds into instruments, all voice-controlled ("Jamalam"). See [../../docs/architecture.md](../../docs/architecture.md).

## Status — first cut

Scaffolded and running. The first feature is live: **🥁 Beatbox → Drums** — tap the orb, beatbox a groove, and it detects the hits, estimates tempo, and plays a real drum kit (the shared analysis + Tone.js engine). Kit selectable (808 / acoustic / lofi / techno). Everything else in the vision (overdub, voice control, cloud sync, split-to-stems) is TODO.

## Develop (web)

```bash
npm install
npm run dev
```

Runs the web app (the exact code that runs inside the native WebView). The mic needs a secure context — `localhost` counts, so dev works; for LAN/phone testing use HTTPS.

## Build & run on Android

Requires a JDK 17 + Android SDK — easiest via **Android Studio**.

```bash
npm run build        # build the web bundle
npx cap sync android # copy web assets into the native project
npx cap open android # open in Android Studio → pick a device → Run
```

Or headless with the toolchain installed: `cd android && ./gradlew assembleDebug` → APK at `android/app/build/outputs/apk/debug/`.

- App id: `se.aurumo.jamalam` · name **Jamalam**.
- Mic permission (`RECORD_AUDIO`) is declared in the manifest; Android prompts on first beatbox.
- Capacitor serves the app over `https://localhost`, so `getUserMedia` runs in a secure context.

## Notes

- The audio core is currently **copied** from `apps/desktop`. It should be extracted into `packages/core` so both apps share one source of truth.
- iOS: add later with `npx cap add ios` (needs a Mac + Xcode).

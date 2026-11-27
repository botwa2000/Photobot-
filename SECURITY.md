# Photobot security

Photobot is an offline desktop gallery that reads thousands of files it did not create. Any one of them could be crafted by an attacker: a photo from a messenger, a download, or a shared drive. This document lists the threats we considered, what Photobot does about each one, and what it cannot do.

Report security problems privately through GitHub's **Report a vulnerability** (Security tab). Please don't open a public issue.

## What we protect

- Your photos and videos. Photobot must never change, upload or leak them.
- Private data Photobot itself creates: the index (dates, places, **GPS locations**, people's names, tags) and the thumbnail cache.
- Your PC. Opening a hostile file in Photobot must not let it run code or reach the network.

## Threats and countermeasures

| # | Threat (industry examples) | What Photobot does |
|---|---|---|
| 1 | **Malicious image or video** exploiting a decoder bug, e.g. libwebp CVE-2023-4863 (exploited in the wild), HEIF/RAW decoder bugs in Windows, libheif 2026 | Photos are decoded only inside Chromium's **sandboxed renderer** (hidden thumbnail window and viewer), never in the privileged main process. If that window crashes or hangs, it is restarted. HEIC/RAW/video thumbnails come from the Windows shell, the same code Explorer runs, and Windows Update patches it. Electron is kept current (45.4.1). |
| 2 | **Malicious metadata** (EXIF/XMP/MP4 atoms) crashing or hanging the parser, or bloating the index | Metadata is parsed in **worker threads with memory limits and a 20 s timeout**. A stuck worker is killed and replaced, and the file gets a date from its name. If workers are unavailable the parser fails closed. All values are type-checked and length-capped (`sanitize()`). MP4 parsing caps box count and size. XML entities are decoded without expansion (no XXE). |
| 3 | **Decompression / "pixel bomb"** images (tiny file, gigapixel header), e.g. Cloudreve CVE-2026-55497 | Image dimensions are checked **before** decoding. More than 120 MP is never decoded, and such files show a placeholder or the OS thumbnail. Tested with a 3.6-gigapixel PNG. |
| 4 | **Cross-site scripting** from file names, tags or people names, which in Electron can escalate to code execution | All text from files is HTML-escaped. A strict **Content-Security-Policy** (`script-src 'self'`, no inline script, `connect-src 'none'`) is sent as a header and a meta tag. The window has **no Node.js** (`contextIsolation`, `sandbox`, `nodeIntegration: false`) and only a narrow, validated API. Tested with script payloads in a file name, an XMP keyword and an XMP person. |
| 5 | **Abusing the main process over IPC** (Electron checklist #17) | Every IPC handler checks the **sender's origin** (`app://photobot`, top frame only). Every argument is validated by type, range and length. Unknown keys are dropped. Requests are parameterized SQL only. |
| 6 | **Path traversal / arbitrary file read** through custom protocols | The UI is served from `app://photobot` instead of `file://` (checklist #18), restricted to the UI folder (no `..`, `\`, NUL or encoded variants). Media is served via `pb://file/<id>`, so pages can only name **database IDs**, never paths. It is limited to indexed media files, refused for any other origin (`initiatorOrigin`), and has no Fetch API, so script can't read bytes. The CORS allow-list contains only the app's own origin (cf. CVE-2026-102675, CVE-2026-70604). |
| 7 | **`shell.openExternal` / `openPath` abuse** to run programs (Wire, DeepChat advisories; CVE-2026-70603) | `openExternal` accepts only **https URLs on an allow-list** (OpenStreetMap). "Open with default app" works only for indexed media files and rejects NUL bytes. |
| 8 | **Navigation, pop-ups, `<webview>`, permission prompts** | All navigation and redirects are blocked, new windows are denied, `<webview>` is disabled, and every permission (camera, mic, location, notifications, devices, screen) is denied. Downloads are cancelled. |
| 9 | **Network exfiltration / tracking** | Photobot is offline by design. A session-wide request filter **cancels every request** that isn't `app:`/`pb:`. Places come from a bundled GeoNames list, so coordinates never leave the PC. The spell-checker (which downloads dictionaries) is off. There is no telemetry and no auto-update. "Open map (online)" is the only feature that contacts the internet, it says so, and it only runs when you click it. |
| 10 | **Windows NTLM credential leaks** via UNC paths (CVE-2025-24054, -24071) | Network paths (`\\server\share`) dropped onto the window are refused. A network folder can only be added through the system folder picker. Photobot never opens `.library-ms`, `.url`, `.lnk` or HTML files. |
| 11 | **Symlink/junction loops and escapes** ("GhostTree" recursive junctions) | The scanner **never follows symbolic links or NTFS junctions**, caps depth at 64, visits each directory once, and ignores watcher events outside the folder. Tested with a loop and with a link to a folder outside the library. |
| 12 | **Living off Electron**: abusing the shipped exe as a Node.js interpreter or debugger target, or swapping its code | Electron **fuses** are flipped at build time: `RunAsNode` off, `NODE_OPTIONS` ignored, `--inspect` off, **ASAR integrity validation** on, only load the app from the ASAR, file-protocol privileges off. CI checks the fuses and confirms that a tampered `app.asar` is refused on Windows. DevTools are disabled in release builds. |
| 13 | **Privacy of the cache**: thumbnails of deleted photos stay recoverable (a forensic classic) | Thumbnails are **erased** when photos are deleted or a folder is removed, and orphans are pruned after each scan and at start-up. Settings has "Clear thumbnail cache". The data folder is private to your Windows user (`%APPDATA%`, owner-only permissions elsewhere). Photobot never writes to photo files, so tags and people stay in its own index only. |
| 14 | **Supply chain**: hijacked npm packages (Shai-Hulud 2025/26) or GitHub Actions (tj-actions CVE-2025-30066) | Minimal runtime dependencies (`exifr` only, plus Electron). `npm ci` installs from the lockfile. CI audits runtime dependencies. Actions are **pinned to full commit SHAs**. The default token is read-only, credentials aren't persisted, and there's no shared dependency cache and no `pull_request_target`. Dependabot proposes updates after a 7-day cool-down. Releases ship **SHA-256 checksums** and a signed **build-provenance attestation**. |
| 15 | **Installer hijacking**: DLL or `cmd.exe` planting next to the installer (electron-builder CVE-2024-27303) | Built with electron-builder 26 (fixed). Run the installer from a folder that holds nothing else, such as a fresh download. |

## Tests

These run on every build, on Windows, against the packaged app:

- `test/security-e2e.js`: hostile files (XSS names, tags and people, random bytes, truncated JPEG, malformed MP4/MOV boxes, a 3.6-gigapixel PNG, symlink loop and escape), Node/Electron exposure, malicious IPC (SQL-ish strings, wrong types, UNC and relative paths, oversized strings), opening external links, navigation, network, path traversal on `app://` and `pb://`, permission prompts, and thumbnail erasure.
- `test/release-check.js`: the fully fused release exe starts; `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` have no effect; a one-byte change to `app.asar` stops it from starting.
- `test/unit/security.test.js`: validators, protocol path resolution, external URL allow-list, metadata sanitizing, killing a stuck parser, and the symlink-safe walker.

## Known limitations

- **Code signing.** The installer is not signed yet, so SmartScreen shows a warning. Signing needs a certificate in your name, for example [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) (the cheapest option) or an OV certificate. electron-builder signs automatically once one is configured. Until then, verify downloads with `SHA256SUMS.txt` or `gh attestation verify <file> --repo botwa2000/Photobot-`.
- **Windows thumbnailers run in-process.** HEIC/RAW/video thumbnails come from the Windows shell, the same component Explorer uses on the same files. Keep Windows and the Microsoft Store image extensions updated.
- **The index is not encrypted.** It sits in your Windows profile and is protected by your account. Use BitLocker if others can access the disk.
- **Another program running as you** can read or change Photobot's data, like any other app's data. That is outside what an app can defend against.
- `PHOTOBOT_DATA_DIR` and `PHOTOBOT_DEFAULT_FOLDERS` environment variables change where data is kept and which folder is added first. Whoever can set them already controls your account.

# Photobot

A private photo and video gallery for Windows. Add your folders and Photobot finds every photo and video inside them, including all subfolders. Browse them by year, month or day, find them by people, places and tags, and view them full screen. Everything stays on your PC.

## Install

1. Open the [**Releases**](../../releases) page and download **Photobot-Setup-x.y.z.exe**.
   You can also open the latest run under [**Actions**](../../actions) and download **Photobot-Windows** under *Artifacts* (it's a zip that contains the installer).
2. Run the installer. Photobot isn't code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**.
3. Start Photobot from the Start menu or the desktop shortcut.

There is also **Photobot-Portable-x.y.z.exe**, which runs without installing.

On first start Photobot adds **`D:\Pictures`** automatically (if that folder exists) and starts scanning. You can add more folders under **Folders → Add folder**, or drag them from File Explorer onto the window.

## What it does

- **Library**: all photos and videos, newest first. View them by **Years**, **Months**, **Days** or **All**, as a **list** or as **small / medium / large** thumbnails. The year bar on the right jumps through time.
- **Viewer**: full-size photos with zoom (mouse wheel, double-click) and pan, and videos with playback. Includes a filmstrip, slideshow, rotate (stored in Photobot; your file isn't changed), favorites, "Show in folder", "Open with default app" and delete (to the Recycle Bin).
- **Details**: date taken, camera settings, place, people, tags and file info.
- **Search**: type a name, place, tag, camera, year or any word. Suggestions turn into filter chips you can combine, for example *Anna + Lisbon + 2026*.
- **Filters**: photos/videos, favorites, people, places, tags, camera, date range and folder.
- **People**: imports name tags already saved in your photos (Windows Photo Gallery, Lightroom, Picasa, digiKam). You can add names in the viewer, or select many photos and choose *Add person*. Rename or merge people on the People page.
- **Places**: built from the GPS data in photos and videos, and looked up offline. Grouped by country and city.
- **Tags**: imports keywords saved in your files. You can add your own one at a time or in bulk.
- **Folders**: scans all subfolders, notices new, changed and deleted files while running, handles drives that are unplugged, and lets you choose which file types to include.
- **Dark mode**: follows Windows, or set it yourself in Settings.

Supported files: JPG, PNG, HEIC/HEIF, AVIF, WEBP, GIF, BMP, TIFF, RAW (DNG, CR2, CR3, NEF, ARW, ORF, RW2, RAF…), MP4, MOV, M4V, AVI, MKV, WMV, 3GP, MTS. HEIC and RAW thumbnails come from Windows itself. If they don't show, install the free **HEIF Image Extensions** and **Raw Image Extension** from the Microsoft Store.

### Privacy

Photobot never uploads anything and never changes, moves or renames your files. Its index (a SQLite database) and thumbnail cache live in `%APPDATA%\Photobot`. Uninstalling keeps them. Delete that folder to remove them.

### Keyboard

`← →` previous/next · `F` favorite · `R` rotate · `I` info panel · `S` slideshow · `Del` delete · `+ − 0` zoom · `Esc` back · `Ctrl+K` search · `Ctrl+A` select all · Ctrl/Shift-click to select several.

## Development

Requires Node.js 22+.

```bash
npm install
npm start            # run the app
npm test             # unit tests
node test/e2e.js     # end-to-end test (drives the real app; on Linux use xvfb-run)
npm run dist         # build the Windows installer into dist/ (on Windows)
```

Code layout:

- `src/main/`: Electron main process
  - `db.js`: SQLite index (built-in `node:sqlite`)
  - `scanner.js`: folder walking and watching
  - `metadata.js`: EXIF/XMP for photos, MP4/MOV atoms for videos, dates from file names
  - `geo.js`: offline reverse geocoding
  - `thumbs.js`: Windows shell thumbnails plus cache
- `src/preload/`: the safe bridge to the window
- `src/renderer/`: the user interface (plain HTML/CSS/JS, virtualized grid)
- `.github/workflows/build.yml`: builds and tests on Windows. Push a tag (`git tag v0.1.0 && git push --tags`) to publish a release.

Place names: [GeoNames](https://www.geonames.org/), CC BY 4.0 (`npm run cities` regenerates `src/main/data/cities.tsv`).

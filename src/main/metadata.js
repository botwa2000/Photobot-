'use strict';
// Reads the facts Photobot needs from a photo or video file:
// when it was taken, where (GPS), camera, size, keywords and people tags.
const fs = require('fs');
const path = require('path');
const exifr = require('exifr');

const PHOTO_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif',
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', '3gp', '3g2', 'webm', 'mts', 'm2ts', 'mpg', 'mpeg']);
const RAW_EXT = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef']);
// Formats Chromium can show directly in <img>/<video>.
const BROWSER_IMAGE = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'bmp', 'avif']);
const BROWSER_VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function kindOf(file) {
  const e = extOf(file);
  if (PHOTO_EXT.has(e)) return 'photo';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/** Local (naive) timestamp string 'YYYY-MM-DDTHH:MM:SS' from a JS Date. */
function toLocalStamp(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 1900 || y > 2100) return null;
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function validYMD(y, mo, d) {
  return y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

/**
 * Dates hidden in common camera/phone file names:
 * IMG_20231225_143012.jpg, PXL_20231225_143012345.jpg, VID-20231225-WA0001.mp4,
 * 2023-12-25 14.30.12.jpg, Screenshot_2023-12-25-14-30-12.png, 20231225_143012.mp4
 */
function dateFromFilename(name) {
  const base = path.basename(name);
  let m = base.match(/(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T.-]+(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})\d{0,3})?(?:[^0-9]|$)/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v === undefined ? undefined : +v));
  if (!validYMD(y, mo, d)) return null;
  if (h !== undefined && (h > 23 || mi > 59 || s > 59)) return `${y}-${pad(mo)}-${pad(d)}T12:00:00`;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h ?? 12)}:${pad(mi ?? 0)}:${pad(s ?? 0)}`;
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  return s || null;
}

/**
 * exifr returns XMP text with XML escapes left in (e.g. "&lt;"). Decode only the
 * predefined and numeric entities; external/custom entities are never expanded (no XXE).
 */
function decodeXml(str) {
  return str.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[k];
  });
}

function asList(v, split = true) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => asList(x, false));
  if (typeof v === 'object') {
    if ('value' in v) return asList(v.value, split);
    return [];
  }
  const s = decodeXml(String(v));
  // A single string may hold several keywords ("a; b" from Windows XPKeywords).
  return (split ? s.split(/[;,]/) : [s]).map((x) => x.trim()).filter(Boolean);
}

/** Walk an exifr output object and collect people names from face-region metadata. */
function findPeople(meta) {
  const names = new Set();
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    // MWG regions (Lightroom, digiKam, Picasa, Google Photos export): {Name, Type:'Face'}
    // Microsoft Photo regions (Windows Photo Gallery): {PersonDisplayName}
    const type = node.Type || node.type;
    const name = node.PersonDisplayName || ((type === 'Face' || type === undefined) && (node.Name || node.name));
    if (typeof name === 'string' && name.trim() && (node.Area || node.Rectangle || node.Type || node.PersonDisplayName)) {
      names.add(decodeXml(name).trim());
    }
    for (const k of Object.keys(node)) visit(node[k], depth + 1);
  };
  visit(meta.RegionInfo || meta.Regions || meta.regions, 0);
  if (meta.mwgRegions) visit(meta.mwgRegions, 0);
  for (const p of asList(meta.PersonInImage, false)) names.add(p);
  return [...names].filter((n) => n.length <= 80);
}

function findKeywords(meta) {
  const out = new Set();
  for (const key of ['subject', 'Keywords', 'keywords', 'XPKeywords', 'LastKeywordXMP', 'TagsList', 'HierarchicalSubject', 'CatalogSets']) {
    for (const k of asList(meta[key])) {
      // Hierarchical tags like "Places|Europe|Lisbon" -> keep the leaf.
      const leaf = k.split('|').pop().split('/').pop().trim();
      if (leaf && leaf.length <= 60 && !/^people$/i.test(leaf)) out.add(leaf);
    }
  }
  return [...out];
}

async function readPhotoMeta(file) {
  let meta = null;
  try {
    meta = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, xmp: true, iptc: true, ifd1: false, icc: false, jfif: false, ihdr: true,
      mergeOutput: true, reviveValues: true, translateValues: false, multiSegment: true,
    });
  } catch {
    meta = null;
  }
  if (!meta) return {};
  const taken = toLocalStamp(meta.DateTimeOriginal) || toLocalStamp(meta.CreateDate) || toLocalStamp(meta.DateCreated) ||
    toLocalStamp(meta.ModifyDate);
  let lat = Number.isFinite(meta.latitude) ? meta.latitude : null;
  let lon = Number.isFinite(meta.longitude) ? meta.longitude : null;
  if (lat === 0 && lon === 0) lat = lon = null;
  const make = cleanText(meta.Make);
  let model = cleanText(meta.Model);
  const brand = make ? make.split(' ')[0] : null;
  if (brand && model && !model.toLowerCase().startsWith(brand.toLowerCase())) model = `${brand} ${model}`;
  const xpTitle = cleanText(meta.XPTitle);
  const xmpTitle = meta.title?.value ?? meta.title;
  return {
    taken,
    takenSource: taken ? 'exif' : null,
    lat, lon,
    camera: model || make,
    lens: cleanText(meta.LensModel),
    iso: Number.isFinite(meta.ISO) ? meta.ISO : null,
    fnum: Number.isFinite(meta.FNumber) ? meta.FNumber : null,
    exposure: Number.isFinite(meta.ExposureTime) ? meta.ExposureTime : null,
    focal: Number.isFinite(meta.FocalLength) ? meta.FocalLength : null,
    width: meta.ExifImageWidth || meta.ImageWidth || meta.PixelXDimension || null,
    height: meta.ExifImageHeight || meta.ImageHeight || meta.PixelYDimension || null,
    orientation: Number.isFinite(meta.Orientation) ? meta.Orientation : null,
    rating: Number.isFinite(meta.Rating) ? meta.Rating : null,
    title: xpTitle || (typeof xmpTitle === 'string' ? cleanText(decodeXml(xmpTitle)) : null),
    keywords: findKeywords(meta),
    people: findPeople(meta),
  };
}

// ---- Minimal ISO-BMFF (MP4/MOV) reader: creation time, duration, size, GPS ----

async function readBytes(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

async function* boxes(fh, start, end) {
  let pos = start;
  let count = 0;
  while (pos + 8 <= end && count++ < 4096) {
    const h = await readBytes(fh, pos, 16);
    if (h.length < 8) return;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) return;
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return;
    yield { type, start: pos, dataStart: pos + header, end: Math.min(pos + size, end) };
    pos += size;
  }
}

const MAC_EPOCH = Date.UTC(1904, 0, 1);

function parseIso6709(s) {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s || '');
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

async function readVideoMeta(file) {
  const ext = extOf(file);
  if (!['mp4', 'm4v', 'mov', '3gp', '3g2'].includes(ext)) return {};
  const out = {};
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    for await (const box of boxes(fh, 0, size)) {
      if (box.type !== 'moov') continue;
      const moovLen = box.end - box.dataStart;
      if (moovLen > 16 * 1024 * 1024) break; // real moov boxes are far smaller
      const moov = await readBytes(fh, box.dataStart, moovLen);
      parseMoov(moov, out);
      break;
    }
  } catch {
    /* unreadable or not an MP4 */
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return out;
}

function* bufBoxes(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return;
    yield { type, dataStart: pos + header, end: pos + size };
    pos += size;
  }
}

function parseMoov(buf, out) {
  for (const b of bufBoxes(buf, 0, buf.length)) {
    if (b.type === 'mvhd') {
      const v = buf[b.dataStart];
      let created;
      let timescale;
      let duration;
      if (v === 1) {
        created = Number(buf.readBigUInt64BE(b.dataStart + 4));
        timescale = buf.readUInt32BE(b.dataStart + 20);
        duration = Number(buf.readBigUInt64BE(b.dataStart + 24));
      } else {
        created = buf.readUInt32BE(b.dataStart + 4);
        timescale = buf.readUInt32BE(b.dataStart + 12);
        duration = buf.readUInt32BE(b.dataStart + 16);
      }
      if (created > 0) {
        const d = new Date(MAC_EPOCH + created * 1000);
        // Some cameras write 0 or local time; ignore implausible dates.
        if (d.getUTCFullYear() >= 1990) out.taken = toLocalStamp(d);
      }
      if (timescale > 0 && duration > 0) out.duration = duration / timescale;
    } else if (b.type === 'trak' && !out.width) {
      for (const t of bufBoxes(buf, b.dataStart, b.end)) {
        if (t.type === 'tkhd') {
          const v = buf[t.dataStart];
          const off = t.dataStart + (v === 1 ? 88 : 76);
          if (off + 8 <= t.end) {
            const w = buf.readUInt32BE(off) / 65536;
            const h = buf.readUInt32BE(off + 4) / 65536;
            if (w > 0 && h > 0) {
              out.width = Math.round(w);
              out.height = Math.round(h);
            }
          }
        }
      }
    } else if (b.type === 'udta' || b.type === 'meta') {
      findLocation(buf, b.type === 'meta' ? b.dataStart + 4 : b.dataStart, b.end, out);
    }
  }
  if (out.taken) out.takenSource = 'video';
}

function findLocation(buf, start, end, out) {
  // Apple/Android write "©xyz" in udta; QuickTime metadata uses "com.apple.quicktime.location.ISO6709".
  const s = buf.toString('latin1', start, end);
  const idx = s.indexOf('©xyz');
  if (idx >= 0) {
    const loc = parseIso6709(s.slice(idx + 4, idx + 64));
    if (loc) Object.assign(out, loc);
    return;
  }
  // QuickTime/mdta keys ("location", "com.apple.quicktime.location.ISO6709") keep the value in ilst.
  const m = /[+-]\d{1,2}\.\d{2,}[+-]\d{1,3}\.\d{2,}/.exec(s);
  const loc = m && parseIso6709(m[0]);
  if (loc) Object.assign(out, loc);
}

/** Date for files without camera/video date: from the file name, else the file's own times. */
function fallbackDate(file, stat) {
  const fromName = dateFromFilename(file);
  if (fromName) return { taken: fromName, takenSource: 'filename' };
  const ms = stat.birthtimeMs && stat.birthtimeMs < stat.mtimeMs ? stat.birthtimeMs : stat.mtimeMs;
  return { taken: toLocalStamp(new Date(ms)) || '1970-01-01T00:00:00', takenSource: 'file' };
}

const clampStr = (s, max) => (typeof s === 'string' ? s.slice(0, max) : null);
const num = (x, lo, hi) => (Number.isFinite(x) && x >= lo && x <= hi ? x : null);

/**
 * Metadata comes from untrusted files: keep only expected types and sane sizes so a
 * crafted file can't bloat the index or smuggle odd values into the UI.
 */
function sanitize(m) {
  return {
    taken: typeof m.taken === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(m.taken) ? m.taken : null,
    takenSource: ['exif', 'video', 'filename', 'file'].includes(m.takenSource) ? m.takenSource : null,
    lat: num(m.lat, -90, 90),
    lon: num(m.lon, -180, 180),
    camera: clampStr(m.camera, 100),
    lens: clampStr(m.lens, 100),
    iso: num(m.iso, 1, 1e7),
    fnum: num(m.fnum, 0.1, 1000),
    exposure: num(m.exposure, 1e-7, 1e5),
    focal: num(m.focal, 0.1, 1e5),
    width: Number.isSafeInteger(m.width) && m.width > 0 && m.width < 1e6 ? m.width : null,
    height: Number.isSafeInteger(m.height) && m.height > 0 && m.height < 1e6 ? m.height : null,
    duration: num(m.duration, 0, 1e7),
    rating: num(m.rating, -1, 5),
    title: clampStr(m.title, 300),
    keywords: (Array.isArray(m.keywords) ? m.keywords : []).filter((k) => typeof k === 'string' && k.length <= 60).slice(0, 200),
    people: (Array.isArray(m.people) ? m.people : []).filter((k) => typeof k === 'string' && k.length <= 80).slice(0, 100),
  };
}

/** Full metadata for one file, with filename and file-time fallbacks for the date. */
async function readMetadata(file, stat) {
  const kind = kindOf(file);
  const meta = sanitize(kind === 'video' ? await readVideoMeta(file) : await readPhotoMeta(file));
  if (!meta.taken) Object.assign(meta, fallbackDate(file, stat));
  return meta;
}

module.exports = {
  PHOTO_EXT, VIDEO_EXT, RAW_EXT, BROWSER_IMAGE, BROWSER_VIDEO,
  extOf, kindOf, readMetadata, fallbackDate, sanitize, readPhotoMeta, readVideoMeta, dateFromFilename, toLocalStamp, parseIso6709, findPeople, findKeywords,
};

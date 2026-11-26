"""Generates the sample library used by the tests (run once; output is committed).
python3 test/make-fixtures.py"""
import os, random, subprocess
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), 'fixtures', 'library')
random.seed(7)

def dms(v):
    v = abs(v); d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
    return (float(d), float(m), round(s, 2))

def xmp(subjects=(), people=()):
    subj = ''.join(f'<rdf:li>{s}</rdf:li>' for s in subjects)
    regs = ''.join(f'''<rdf:li rdf:parseType="Resource"><mwg-rs:Name>{p}</mwg-rs:Name><mwg-rs:Type>Face</mwg-rs:Type>
      <mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.2" stArea:h="0.2" stArea:unit="normalized"/></rdf:li>''' for p in people)
    return f'''<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/"
 xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#">
<dc:subject><rdf:Bag>{subj}</rdf:Bag></dc:subject>
<mwg-rs:Regions rdf:parseType="Resource"><mwg-rs:RegionList><rdf:Bag>{regs}</rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'''.encode('utf-8')

def photo(rel, color, date=None, gps=None, camera=None, subjects=(), people=(), size=(640, 480), fmt='JPEG', orientation=None):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = Image.new('RGB', size, color)
    d = ImageDraw.Draw(img)
    for _ in range(900):  # texture so files are > 20 KB
        x, y = random.randrange(size[0]), random.randrange(size[1])
        c = tuple(min(255, max(0, v + random.randint(-60, 60))) for v in color)
        d.ellipse([x, y, x + random.randint(4, 30), y + random.randint(4, 30)], fill=c)
    d.polygon([(0, size[1]), (size[0] * .3, size[1] * .55), (size[0] * .5, size[1] * .7), (size[0] * .7, size[1] * .45), (size[0], size[1] * .75), (size[0], size[1])], fill=(255, 255, 255))
    exif = Image.Exif()
    if camera:
        exif[0x010F], exif[0x0110] = camera
    if orientation:
        exif[0x0112] = orientation
    ifd = exif.get_ifd(0x8769)
    if date:
        ifd[0x9003] = date  # DateTimeOriginal
        ifd[0x829D] = 1.8  # FNumber
        ifd[0x8827] = 100  # ISO
    if gps:
        g = exif.get_ifd(0x8825)
        g[1] = 'N' if gps[0] >= 0 else 'S'; g[2] = dms(gps[0])
        g[3] = 'E' if gps[1] >= 0 else 'W'; g[4] = dms(gps[1])
    kw = {'exif': exif.tobytes()}
    if fmt == 'JPEG':
        kw['quality'] = 92
        if subjects or people:
            kw['xmp'] = xmp(subjects, people)
    img.save(path, fmt, **kw)

def video(rel, date_iso, loc=None, seconds=2):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=size=320x240:rate=15:duration={seconds}',
           '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-metadata', f'creation_time={date_iso}']
    if loc:
        cmd += ['-metadata', f'location={loc}', '-movflags', 'use_metadata_tags']
    subprocess.run(cmd + [path], check=True)

photo('2026/Lisbon/IMG_0001.jpg', (143, 179, 201), '2026:11:24 17:42:10', (38.7139, -9.1334), ('Google', 'Pixel 9'), ['sunset', 'city'], ['Anna'])
photo('2026/Lisbon/IMG_0002.jpg', (201, 162, 126), '2026:11:24 18:05:00', (38.7101, -9.1400), ('Google', 'Pixel 9'), ['food'], ['Anna', 'Max'])
photo('2026/Lisbon/IMG_0003.jpg', (127, 163, 138), '2026:11:22 10:00:00', (38.70, -9.14), ('Google', 'Pixel 9'), ['beach'])
photo('2026/Como/DSC_1001.jpg', (167, 163, 201), '2026:09:12 09:30:00', (45.9853, 9.2600), ('Canon', 'Canon EOS R6'), ['mountains', 'hike'], ['Max'], orientation=6)
photo('2026/Como/DSC_1002.jpg', (111, 143, 166), '2026:09:13 12:00:00', (45.81, 9.08), ('Canon', 'Canon EOS R6'), ['lake'])
photo('2025/Vienna/IMG_20250714_101500.jpg', (196, 207, 161), None, (48.2082, 16.3738))
photo('Old scans/scan 1998.png', (181, 134, 122), fmt='PNG')
photo('Old scans/.hidden/secret.jpg', (10, 10, 10), '2001:01:01 00:00:00')
video('2026/Lisbon/VID_0004.mp4', '2026-11-23T15:20:00Z', '+38.7139-009.1334/')
video('2024/clip.mp4', '2024-05-01T08:00:00Z')
# Tiny icon that should be skipped.
os.makedirs(os.path.join(OUT, 'icons'), exist_ok=True)
Image.new('RGB', (16, 16), (255, 0, 0)).save(os.path.join(OUT, 'icons', 'tiny.png'))
print('fixtures written to', OUT)

# usage: python3 -I supplement_extract.py OUTDIR PDF... : 「Toulouse_5km_Supplement」（4 列、500 × 300 の写真）の写真を OUTDIR/<区画>/<id>.webp と
# OUTDIR/index.jsonl に足す（id は A07-S001 の形。source は Panoramax・KartaView・Wikimedia Commons など、pano は 360° の写真）
import sys, os, re, json, subprocess, tempfile, glob
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
ID = re.compile(r'\b([A-T]\d{2})[–-](S\d{3})\b')
CO = re.compile(r'(\d+\.\d+) N (\d+\.\d+) E\s*•\s*(\d{4}-\d{2}-\d{2})?')
idx_path = os.path.join(out, 'index.jsonl')
seen = set()
if os.path.exists(idx_path):
    for l in open(idx_path): seen.add(json.loads(l)['id'])
fout = open(idx_path, 'a')
total = bad = 0
def run(args): return subprocess.run(args, capture_output=True, text=True).stdout
for pdf in sys.argv[2:]:
    n = int(re.search(r'Pages:\s+(\d+)', run(['pdfinfo', pdf])).group(1))
    for pg in range(1, n + 1):
        lines = run(['pdftotext', '-layout', '-f', str(pg), '-l', str(pg), pdf, '-']).split('\n')
        recs = []
        for i, l in enumerate(lines):
            ms = list(ID.finditer(l))
            if not ms or '→' in l: continue
            starts = [m.start() for m in ms]
            def cols(line):
                return [line[max(0, starts[k] - 1):(starts[k + 1] - 1 if k + 1 < len(starts) else len(line))].strip() for k in range(len(starts))]
            head = cols(l)
            nxt = [cols(lines[i + d]) if i + d < len(lines) else [''] * len(ms) for d in (1, 2, 3)]
            for k, m in enumerate(ms):
                cell, sid = m.group(1), m.group(2)
                street = head[k][m.end() - starts[k] + 1:].strip() if head[k] else ''
                street = head[k].split(None, 1)[1].strip() if len(head[k].split(None, 1)) > 1 else None
                c = CO.search(nxt[0][k] or '')
                cr = (nxt[1][k] or '').lstrip('© ').strip()
                lic = (nxt[2][k] or '').strip()
                author, source = (cr.rsplit(' · ', 1) + [None])[:2] if ' · ' in cr else (cr or None, None)
                pano = '360' in lic
                lic = lic.replace('· 360°', '').strip(' ·') or None
                recs.append({'id': f'{cell}-{sid}', 'cell': cell, 'street': street or None,
                             'lat': float(c.group(1)) if c else None, 'lon': float(c.group(2)) if c else None, 'date': c.group(3) if c else None,
                             'author': author, 'source': source, 'licence': lic, 'pano': pano})
        if not recs: continue
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(['pdfimages', '-j', '-f', str(pg), '-l', str(pg), pdf, os.path.join(td, 'p')], check=True, capture_output=True)
            imgs = [f for f in sorted(glob.glob(os.path.join(td, 'p-*'))) if Image.open(f).size[0] >= 200]
            if len(imgs) != len(recs):
                print('MISMATCH', os.path.basename(pdf), pg, len(imgs), len(recs)); bad += 1; continue
            for r, f in zip(recs, imgs):
                if r['id'] in seen or r['lat'] is None: continue
                d = os.path.join(out, r['cell']); os.makedirs(d, exist_ok=True)
                Image.open(f).convert('RGB').save(os.path.join(d, r['id'] + '.webp'), 'WEBP', quality=62, method=6)
                fout.write(json.dumps(r, ensure_ascii=False) + '\n'); seen.add(r['id']); total += 1
    print(os.path.basename(pdf), 'done', total)
print('photos', total, 'mismatch pages', bad)

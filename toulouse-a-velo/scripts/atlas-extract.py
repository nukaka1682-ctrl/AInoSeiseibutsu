# usage: python3 -I atlas_extract.py OUTDIR PDF...
import sys, os, re, json, subprocess, tempfile, glob
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
ID = re.compile(r'\b([A-T]\d{2}-\d{3})\b')
CO = re.compile(r'(\d+\.\d+) N (\d+\.\d+) E\s+(\d{4}-\d{2}-\d{2})')
CR = re.compile(r'©\s*(.+?)\s+·\s+Panoramax\s+(CC BY-SA 4\.0|CC BY 4\.0|CC0 1\.0|Licence Ouverte 2\.0|[A-Za-z][^\s].*?)(?=\s{2,}|$)')
idx_path = os.path.join(out, 'index.jsonl')
seen = set()
if os.path.exists(idx_path):
    for l in open(idx_path): seen.add(json.loads(l)['id'])
fout = open(idx_path, 'a')
total = bad = 0
for pdf in sys.argv[2:]:
    n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout).group(1))
    for pg in range(1, n + 1):
        txt = subprocess.run(['pdftotext', '-layout', '-f', str(pg), '-l', str(pg), pdf, '-'], capture_output=True, text=True).stdout
        lines = txt.split('\n')
        recs = []
        for i, l in enumerate(lines):
            ids = [m for m in ID.findall(l)]
            if len(ids) < 1 or '–' in l: continue
            # find following street, coord, credit lines
            j = i + 1
            while j < len(lines) and not CO.search(lines[j]): j += 1
            if j >= len(lines): continue
            starts = [m.start() - 2 for m in ID.finditer(l)]
            def cols(line):
                return [line[max(0, starts[k]):(starts[k + 1] if k + 1 < len(starts) else len(line))].strip() for k in range(len(starts))]
            cc = cols(lines[j]); sc = cols(lines[j - 1]); rc = cols(lines[j + 1]) if j + 1 < len(lines) else [''] * len(ids)
            for k, pid in enumerate(ids):
                m = CO.search(cc[k])
                if not m: break
                c = re.search(r'©\s*(.+?)\s+·\s+Panoramax\s+(.+)$', rc[k])
                recs.append({'id': pid, 'cell': pid[:3], 'street': sc[k] or None, 'lat': float(m.group(1)), 'lon': float(m.group(2)), 'date': m.group(3),
                             'author': c.group(1) if c else None, 'licence': c.group(2).strip() if c else None})
        if not recs: continue
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(['pdfimages', '-j', '-f', str(pg), '-l', str(pg), pdf, os.path.join(td, 'p')], check=True)
            imgs = [f for f in sorted(glob.glob(os.path.join(td, 'p-*.jpg')))]
            imgs = [f for f in imgs if Image.open(f).size[0] >= 200]
            if len(imgs) != len(recs):
                print('MISMATCH', os.path.basename(pdf), pg, len(imgs), len(recs)); bad += 1; continue
            for r, f in zip(recs, imgs):
                if r['id'] in seen: continue
                d = os.path.join(out, r['cell']); os.makedirs(d, exist_ok=True)
                Image.open(f).convert('RGB').save(os.path.join(d, r['id'] + '.webp'), 'WEBP', quality=62, method=6)
                fout.write(json.dumps(r, ensure_ascii=False) + '\n'); seen.add(r['id']); total += 1
    print(os.path.basename(pdf), 'done', total)
print('photos', total, 'mismatch pages', bad)

# python3 -I atlas_streets.py PDF OUT.json : 街路写真帖の「通り名索引」（通りの名前 → 写真のある区画）を JSON に
import sys, re, json, subprocess
CELL = re.compile(r'\b[A-T]\d{2}\b')
txt = subprocess.run(['pdftotext', '-layout', sys.argv[1], '-'], capture_output=True, text=True).stdout
lines = [l for l in txt.split('\n')]
out = {}
prev = None
for l in lines:
    if not l.strip(): continue
    if re.fullmatch(r'[\sA-T0-9]+', l) and CELL.search(l) and prev is not None:
        names = [(m.start(), m.group(0).strip()) for m in re.finditer(r'\S.*?(?=\s{3,}|$)', prev)]
        if names:
            for m in CELL.finditer(l):
                col = max([n for n in names if n[0] <= m.start() + 1] or [names[0]], key=lambda n: n[0])
                out.setdefault(col[1], []).append(m.group(0))
        prev = None
        continue
    prev = l
out = {k: sorted(set(v)) for k, v in sorted(out.items()) if not k.startswith('TOULOUSE')}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
print(len(out), list(out.items())[:3])

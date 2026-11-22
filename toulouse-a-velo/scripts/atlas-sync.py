# python3 -I atlas_sync.py SRC DST RADIUS_M : DST に、キャピトル広場から RADIUS_M 以内の写真と index だけを置く
import sys, os, json, math, shutil
src, dst, R = sys.argv[1], sys.argv[2], float(sys.argv[3])
C = (43.60444, 1.44342)  # Place du Capitole
keep = []
for l in open(os.path.join(src, 'index.jsonl')):
    r = json.loads(l)
    if math.hypot((r['lat'] - C[0]) * 111320, (r['lon'] - C[1]) * 111320 * math.cos(math.radians(C[0]))) <= R: keep.append(r)
keep.sort(key=lambda r: r['id'])
ids = {r['id'] for r in keep}
# 消す（範囲外の写真・空のフォルダ）
for d in os.listdir(dst):
    p = os.path.join(dst, d)
    if os.path.isdir(p):
        for f in os.listdir(p):
            if f[:-5] not in ids: os.remove(os.path.join(p, f))
        if not os.listdir(p): os.rmdir(p)
for r in keep:
    os.makedirs(os.path.join(dst, r['cell']), exist_ok=True)
    t = os.path.join(dst, r['cell'], r['id'] + '.webp')
    if not os.path.exists(t): shutil.copy2(os.path.join(src, r['cell'], r['id'] + '.webp'), t)
with open(os.path.join(dst, 'index.jsonl'), 'w') as f:
    for r in keep: f.write(json.dumps(r, ensure_ascii=False) + '\n')
print('kept', len(keep))

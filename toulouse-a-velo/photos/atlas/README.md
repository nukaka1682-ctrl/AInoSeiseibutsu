# トゥールーズ街路写真帖（Toulouse_5km_Atlas）から取り出した写真

利用者から受け取った PDF「Toulouse_5km_Atlas_01〜33」（キャピトル広場から半径 5 km、500 m 四方の区画 A01〜T15、
写真 55,502 枚）の写真のうち、**キャピトル広場から半径 3 km 以内**の写真を、区画ごとのフォルダに 1 枚ずつ取り出したもの
（PDF の中の縮小写真 275 × 151 px を WebP に）。3 km より外の写真はリポジトリに入れない（重くなるため）。
ゲームの見た目を本物に近づけるときの手本にする。

- `index.jsonl`: 1 行 1 枚。`id`（例 A07-001）、`cell`（区画）、`street`（撮影座標に近い通りの名前。PDF の推定）、
  `lat`・`lon`（撮影地点）、`date`（撮影日）、`author`・`licence`（撮影者とライセンス）
- `<区画>/<id>.webp`: 写真

写真の出典は Panoramax（https://panoramax.fr）、補遺の一部は KartaView（https://kartaview.org）と Wikimedia Commons。撮影者ごとのライセンスは index.jsonl のとおり
（Toulouse Métropole の写真は Licence Ouverte 2.0、ほかの多くは CC BY-SA 4.0、一部 CC BY-SA 3.0・CC BY 3.0。使うときは撮影者名を表示する）。
地図の背景は Toulouse Métropole（Filaire de voirie）・© OpenStreetMap contributors。

取り出しは、まず作業用のフォルダに全部 `python3 scripts/atlas-extract.py <作業フォルダ> <PDF>…`（すでにある id は飛ばすので、
追加の PDF だけ渡せばよい）、次に `python3 scripts/atlas-sync.py <作業フォルダ> photos/atlas 3000` で半径 3 km の分だけをここへ。
受け取り済み: Atlas 01〜26（区画 A07〜T15。全 55,502 枚）、Supplement 01〜07（区画 A07〜T15。2,923 枚）。
ここにあるのは、そのうち半径 3 km 以内の index.jsonl の枚数。

- 補遺（Toulouse_5km_Supplement）の写真は id が `A07-S001` の形（500 × 300 px）。index.jsonl の行に `source`（Panoramax・
  KartaView・Wikimedia Commons）と `pano`（360° の写真から切り出したもの）が付く。取り出しは
  `python3 scripts/atlas-supplement-extract.py <作業フォルダ> <PDF>…`（Atlas と同じ作業フォルダに足してから atlas-sync.py）
- `streets.json`: 通り名索引（Atlas 26 の巻末。通りの名前 → 写真のある区画。5 km 全体）。`python3 scripts/atlas-streets.py <Atlas 26 の PDF> streets.json`

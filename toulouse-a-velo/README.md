# Toulouse à vélo — トゥールーズ自転車散歩

実在のフランス・トゥールーズの街を 3D で再現し、自転車で自由に走り回れるブラウザゲームです。
建物・通り・川・橋・公園・街路樹は、すべて実際の地図データ（OpenStreetMap と IGN BD TOPO）から自動生成しています。

| ![ポン・ヌフの上からガロンヌ川と河岸を見る](docs/pont-neuf.jpg) | ![アンリ・マルタン遊歩道からポン・ヌフを望む](docs/garonne.jpg) |
| --- | --- |
| ポン・ヌフの上。両側がガロンヌ川、正面が右岸の河岸 | 右岸の Promenade Henri Martin。奥にポン・ヌフの橋脚 |
| ![キャピトル広場](docs/capitole.jpg) | ![サン・セルナン大聖堂へ向かう Rue Bellegarde](docs/saint-sernin.jpg) |
| キャピトル広場と市庁舎（キャピトル）の長いファサード | サン・セルナン大聖堂へ続く Rue Bellegarde |
| ![ミディ運河沿い](docs/canal-du-midi.jpg) | ![全体地図](docs/map.jpg) |
| マタビオ駅前、ミディ運河沿いの Boulevard de la Gare | 全体地図（名所を選ぶとナビ、地図をクリックでワープ） |

※ スクリーンショットは IGN BD TOPO のデータで組み立てた標準エリア（半径 1.2 km）。ソフトウェア描画の開発環境で撮影したため、実際のブラウザではもっとなめらかです。

## 遊び方

| 操作 | キーボード | ゲームパッド | スマホ |
| --- | --- | --- | --- |
| こぐ | `W` / `↑` | RT / A | 「こぐ」 |
| ブレーキ（止まっているときは後退） | `S` / `↓` | LT / B | 「ブレーキ」 |
| ハンドル | `A` `D` / `←` `→` | 左スティック | ◀ ▶ |
| 立ちこぎ（加速） | `Shift` | RB | — |
| ベル | `Space` | X | 🔔 |
| カメラ切替（追従 / 一人称 / 上空） | `C` | Y | 🎥 |
| 地図・目的地選択・ワープ | `M` / `Tab` | Back | 🗺️ |
| 道路に戻る | `R` | — | — |
| ポーズ | `Esc` / `P` | Start | ⏸ |

- **自由走行**: 街を走って名所（キャピトル、サン・セルナン大聖堂、ポン・ヌフ、ミディ運河など 18 か所）を発見します。地図で名所を選ぶと、実際の道路網でルートを計算してナビします。
- **名所めぐりタイムアタック**: キャピトル広場をスタートし、名所を順番に回ってタイムを競います（自己ベストを保存）。
- 画面上部には今走っている**実際の通りの名前**が表示されます。

## 「正確な再現」のしくみ

地図データは 2 つの公開データから取得します。

1. **OpenStreetMap**（Overpass API）＋ **IGN BD TOPO の実測の建物の高さ** … 通常はこちら
2. **IGN BD TOPO だけ** … OpenStreetMap のサーバー（Overpass API）が混んでいてつながらないと自動でこちらに切り替わります。タイトル画面の「グラフィック設定」で最初から選ぶこともできます

IGN（フランス国土地理院）の BD TOPO は、建物の軒の高さ・屋根の高さ・壁や屋根の材料（レンガ・石・コンクリート／瓦・スレート）、道路の幅・正式な通り名・橋・歩行者専用道まで持っている公的なデータです。

| 要素 | データ | 再現方法 |
| --- | --- | --- |
| 建物の形 | OSM（フランスの地籍図由来）または IGN | 外形を押し出して 3D 化。中庭（穴）、`building:part`（鐘楼など）にも対応 |
| 建物の高さ | ① OSM の `height` → ② **IGN の実測の高さ** → ③ OSM の階数 → ④ 推定 | IGN は航空写真測量による実測値（IGN で組み立てた標準エリアでは 12,307 棟中 99.7% が実測） |
| 屋根 | OSM の `roof:shape`、IGN の屋根の最高点・最低点 | 四角形の建物は実際の屋根の高さで切妻・寄棟に。それ以外は屋根の中間の高さの陸屋根 |
| 壁・屋根の色 | OSM の `building:colour` など、IGN の壁と屋根の材料 | レンガの建物はばら色、石・コンクリートは漆喰色、スレートや亜鉛の屋根は灰色 |
| 道路 | OSM の `highway`、IGN の道路の種類・幅・通り名 | 車道・歩道・歩行者専用道（石畳）・自転車道を描き分け、実際の通り名を表示 |
| 川・運河 | 水域ポリゴン | ガロンヌ川は約 6 m 下を流れ、レンガの河岸の壁で囲まれる。橋だけ渡れる（橋の下で切り抜かれた水面は埋め直す） |
| 公園・木 | OSM の `leisure` / `natural=tree`、IGN の公共空間・植生 | 登録された木はその位置に。木の少ない公園には木を補う。IGN だけのときは並木道（Allées・Boulevard など）に木を植える（推定） |
| 通路 | 道路が建物の外形を横切る箇所 | 建物の下をくぐる通路として通れるようにする |

ゲーム中に `Esc` でポーズすると、建物の高さが「IGN 実測 / OSM / 推定」のどれから来たかの内訳が見られます。

### 既知の限界

- 地形（標高差）は再現していません。トゥールーズ中心部はほぼ平坦ですが、川の低い河岸道（ベルジュ）などは地上と同じ高さになります。
- 外観（窓・扉・瓦）は手続き的に作ったテクスチャで、実物の写真ではありません。ファサードの細部やモニュメントの装飾は再現されません。
- 自動車・歩行者はいません。一方通行も無視します（ゲームなので）。
- 再現の精度は元データに依存します。IGN だけのときは、サン・セルナンの鐘楼のような建物の細かな部分（`building:part`）や個々の街路樹はありません。OSM のおかしな箇所は [OpenStreetMap](https://www.openstreetmap.org/) を直すと、次回のデータ取得から反映されます。

## 開発

```bash
cd toulouse-a-velo
npm install
npm run dev          # http://localhost:5173 で起動
```

初回起動時、ブラウザが Overpass API（OSM）と IGN Géoplateforme の WFS から地図データをダウンロードします（30 秒〜数分）。Overpass に 100 秒つながらなければ IGN だけで組み立てます。取得したデータは IndexedDB にキャッシュされ、2 回目以降はすぐに始まります。

### 地図データを同梱する（推奨）

```bash
npm run fetch-data                  # 標準エリア → public/data/centre.json（OSM、だめなら IGN）
npm run fetch-data -- all           # すべてのエリア
npm run fetch-data -- centre --ign  # IGN だけで作る（標準エリアで約 8 MB、1 分ほど）
```

`public/data/` に保存されたデータがあれば、ゲームはそれを最初に使います（ダウンロード待ちなし）。データファイルは大きいので Git には入れていません（GitHub Pages への公開時に自動で取得します）。

### URL パラメータ

| パラメータ | 例 | 説明 |
| --- | --- | --- |
| `area` | `?area=light` | エリアを選んだ状態で開く（`centre` / `large` / `light`） |
| `lat` `lon` `r` | `?lat=43.5615&lon=1.4682&r=800` | 任意の地点を中心にする（トゥールーズ以外の街でも動きます） |
| `mode` | `?mode=tour` | タイムアタックを選んだ状態で開く |
| `autostart` | `?autostart=1` | タイトル画面を飛ばして開始 |

### テスト

```bash
npm test                           # 単体テスト（座標変換・OSM/IGN の変換と解析・ルート探索・当たり判定）
npm run build && npm run test:e2e  # ブラウザでの通しテスト（合成データ）
npm run test:autopilot             # 本物の地図で、全名所を自動走行で回れるか（要 fetch-data）
npm run build && node test/e2e-network.mjs  # 本物のネットワークで IGN への自動切り替えを確認
```

- `test:e2e` は地図サーバーへの通信を合成データ（`test/fixture.mjs`、トゥールーズ風の格子状の街）に差し替えて、読み込み → 走行 → 建物・川との衝突 → 橋 → 地図とナビ → タイムアタックを確認し、`test/output/` にスクリーンショットを保存します。
- `test:autopilot` は本物のトゥールーズの上で、ゲームのナビに沿ってタイムアタックのコースと 18 か所の名所すべてを自動走行します（約 15 km）。道が建物でふさがっていないか、川で行き止まりにならないかの確認になります。

### 公開（GitHub Pages）

`.github/workflows/toulouse-a-velo.yml` が `main` ブランチへの push でビルドし、地図データを同梱して GitHub Pages に公開します。リポジトリの **Settings → Pages → Source** を **GitHub Actions** にしてください。

### ファイル構成

```
src/
  main.js            ゲーム全体（画面遷移・ループ・HUD）
  config.js          エリアのプリセット、名所、タイムアタックのコース
  geo.js             緯度経度 ↔ メートル座標、ポリゴン処理、空間グリッド
  data/              Overpass API・IGN WFS からの取得、IGN → OSM 形式への変換（ign.js）、IndexedDB キャッシュ
  world/assemble.js  地図データから遊べる街を組み立てる（ブラウザとテストで共通）
  world/parse.js     OSM → 建物・道路・水域・緑地・木（高さの決定もここ）
  world/buildings.js 建物メッシュ（壁・窓・屋根）
  world/ground.js    地面・道路・歩道・水面と河岸・橋
  world/trees.js     木（InstancedMesh）
  world/textures.js  手続き的テクスチャ（ファサード・瓦・石畳・水面）
  game/bike.js       自転車とライダーのモデル・物理
  game/collision.js  当たり判定（建物・木・川・エリア端）
  game/roadnet.js    道路ネットワーク（通りの名前・ルート探索 A*）
  game/landmarks.js  名所の位置合わせ・目的地の光の柱
  game/camera.js     カメラ
  ui/minimap.js      ミニマップと全体地図
scripts/fetch-data.mjs  地図データの事前取得
```

## ライセンス・クレジット

- コード: MIT
- 地図データ: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL 1.0）
- 地図データ: IGN BD TOPO®（[Licence Ouverte / Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/)）
- 3D 描画: [three.js](https://threejs.org/)

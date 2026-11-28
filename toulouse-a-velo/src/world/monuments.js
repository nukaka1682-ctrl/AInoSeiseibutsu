// 名所の専用モデル（写真とユーザーの写真のメモを手本に組み立てる）。データの建物の外形の代わりに描く
// （当たり判定は元の外形のまま。像・柵は円の当たり判定を足す）。
//   シャトー・ドー:   円形のレンガの基壇（半円アーチの扉）・円筒の塔・手すり付きのテラス・細い上の円筒・灰色のドームと風見・黒い鉄柵
//   スタディアム:     外形（穴 = ピッチ）から、白い外壁・すり鉢の観客席・屋根・ピッチ・4 本の照明塔
//   カバニス:         3 つの外形をまとめた門の形（中央の大きな四角い開口）、テラコッタ色のルーバーと白い階の帯、屋上のガラスの庇
//   オクシタン十字:   キャピトル広場の石畳に埋め込まれたブロンズの十字（12 の玉に星座のメダル）。地面に貼る薄い板
//   雄鶏の像:         オリヴィエ広場。蹄鉄を溶接した暗い錆色の雄鶏（足元にラグビーボール）、赤い木の台（上面は黒）
//   ファストフード店: Route de Bayonne のマクドナルド（ユーザーのストリートビューと航空写真）。ガラスの店先の平屋に外へ傾いた
//                     オレンジ色の羽板の帯と濃い緑の寄棟の屋根、緑と赤の看板塔、道路との間の白い砂利と大きな石の植え込み
//   オテル・デューの中庭: 刈り込んだ四角い木の列に挟まれた砂利の園路、芝の中の低いツゲの模様、北の端の丸い池（ストリートビュー）
//   日本庭園:         コンパン・カファレリの Jardin japonais Pierre-Baudis（ユーザーの写真）。白い塀に囲まれた砂紋の枯山水と石組み、
//                     池の西の茶屋（深い軒の苔むした寄棟）、池の南の入り江に架かる朱色の太鼓橋、白い玉石の州浜と石灯籠、玉作りの松
import * as THREE from 'three';
import { MeshWriter, triangulate } from './meshwriter.js';
import { centroid, closestOnSegment, hash01, mulberry32, pointInPolygon, pointInRing, signedArea } from '../geo.js';
import { ORDER } from './ground.js';
import { TERRAIN_ORDER } from './terrainmesh.js';
import { CAR_ROADS } from './parse.js';
import { ramblasLayout } from './ramblas.js';
import { gardenGates, gardenOutline, gardenPathSegments, squaresLocal } from './squares.js';
import { LOCKS, lockFrame } from './locks.js';

export const MONUMENTS = [
  { id: 'chateau-eau', kind: 'chateau', lat: 43.59870, lon: 1.43693, r: 20 },
  { id: 'stadium', kind: 'stadium', lat: 43.58330, lon: 1.43404, r: 40 },
  // front: 庇のある正面（門）が向く先。ジャン・ジョレス通り（allées Jean-Jaurès）の軸の突き当たりに門が建つ
  { id: 'cabanis', kind: 'cabanis', lat: 43.61024, lon: 1.45576, r: 45, minHeight: 25, front: [43.6061, 1.4490] },
  { id: 'coq', kind: 'coq', lat: 43.59823, lon: 1.43445, plaza: /^Place Olivier$/i },
  { id: 'croix-occitane', kind: 'cross', plaza: /^Place du Capitole$/i, radius: 8 },
  // ラ・グラーヴの円屋根（Chapelle Saint-Joseph de la Grave。利用者の写真 NCM_0102・0105・0107）: 礼拝堂の建物の上に、
  // 直径約 19 m のレンガのドラム（高さ約 25 m まで）と鉛色のドーム（約 38 m）、頂塔と十字架（約 44 m）
  { id: 'grave-dome', kind: 'dome', lat: 43.60082, lon: 1.43301, r: 25 },
  // パット・ドワのロータリーの島（利用者の Street View 210522）: 直径約 18 m の、ばら色のレンガの低い擁壁（0.6 m）に
  // 囲まれた植え込み（低木と小さな木）と、暗い青灰色の鋼の門の形の彫刻（高さ約 6 m・幅約 7 m）
  // サン・シプリアンの Place Intérieure（利用者の Street View 210226）: 2 本の車道のあいだの、ベージュの石灰岩の板の
  // 一段高い歩行者の島（東の端は丸い）と淡い石の縁石、平らな暗い鉄の格子、案内の柱。その西に続くのは、メトロの駅の
  // 地上の明かり取り（航空写真 2024: 暗い青のガラスの格子の屋根 約 17 × 6 m と、その西の赤茶色と灰色の板の屋根 約 18 × 6 m）。
  // まわりの 2 本の車道は 3 車線の通り抜けで、路上駐車はない。line: 芯線の東端・西端（島は東の 3 割）
  { id: 'st-cyprien-island', kind: 'island', line: [[43.598026, 1.432008], [43.597927, 1.431340]], half: 4.6 },
  // サン・セルナン大聖堂（利用者の写真 NCM_0099）: 地図の外形を押し出しただけの箱の代わりに、身廊・側廊・袖廊の
  // 低い勾配の瓦屋根と、東の端の段々の後陣（放射状の 5 つの小礼拝堂 8 m → 周歩廊 13 m → 後陣の円筒 20 m、どれも
  // 半円錐の瓦屋根）。crossing: 交差部（八角形の鐘楼 towers.js）、apex: 東の端の方向
  { id: 'saint-sernin', kind: 'basilica', lat: 43.60848, lon: 1.442154, r: 40, apex: [43.60863, 1.44250], chevet: [43.608545, 1.442328] },
  // サン・テティエンヌ大聖堂の石の内陣（利用者の写真 NCM_0095）: 石の壁（buildings.js）の外に、控え壁と尖塔飾り、
  // 2 段の尖頭アーチの高い窓、足元のすすけた帯、軒の手すり。landmarkfacades.js の STONE_CHOIRS と同じ所・向き
  { id: 'saint-etienne-choir', kind: 'choir', lat: 43.59988, lon: 1.45046, r: 30, east: [43.59996, 1.4515], split: 1 },
  // オーギュスタン美術館のダルシー棟（利用者の Street View 211548）: Rue d'Alsace-Lorraine に面した壁は、灰色の砂岩の
  // 腰石（1.5 m）の上に背の高い半円アーチのアーケード（幅 3.5 m・高さ 7 m、ガラス）、7.5 m の石の帯、2 つ並びの半円アーチの窓、
  // 12 m の持ち送りの軒（Rue de Metz の側も同じ）。建物の、facing のどれかの方を向いた長さ 10 m 以上の壁に重ねて描く
  { id: 'augustins', kind: 'arcades', lat: 43.60101, lon: 1.44620, r: 40, minArea: 3000, facing: [[43.60101, 1.44533], [43.60030, 1.44620]] },
  // オテル・デューの川側（利用者の写真 NCM_0107・0125・0136）: 真ん中の張り出しの三角の破風、水際の 2 つの大きなアーチ、
  // 正面の前の川の中に残るポン・ヴィユー（古い橋）の橋脚の跡（幅約 8 m、アーチの付け根）
  { id: 'hotel-dieu-river', kind: 'riverfront', lat: 43.59988, lon: 1.43720, r: 45, minArea: 5000, facing: [43.59994, 1.43851] },
  // Port Saint-Sauveur（利用者の写真 NCM_0183・0184）: 港の南西の端のカピテヌリー（北を向いた半円のガラスの正面、
  // 暗い灰色の金属のかまぼこ屋根、レンガの横の壁、棟まで約 9.5 m）と、西の岸壁に沿ってつないだ平底船（péniche）の列
  { id: 'capitainerie', kind: 'capitainerie', lat: 43.59508, lon: 1.45592, r: 15, front: [43.59600, 1.45592] },
  { id: 'port-boats', kind: 'moorings', quay: [[43.596166, 1.455856], [43.595088, 1.455965]], water: [43.59563, 1.45610] },
  // ジャンヌ・ダルクの騎馬像（利用者の写真 NCM_0100）: Place Jeanne d'Arc の南の端の島。灰色の花崗岩の段と台座
  // （約 2.5 m 角・4.5 m、軒のモールディング）の上に、旗を掲げた騎士と馬の暗いブロンズ像（全体で約 8.5 m）
  { id: 'jeanne-arc', kind: 'equestrian', lat: 43.60952, lon: 1.44657, facing: [43.60800, 1.44620] },
  // アリエージュ＝ガロンヌの泉（利用者の写真 NCM_0134）: Place Auguste-Lafourcade の建物の窓のない壁に付いた、淡い石の
  // 壁泉（幅約 6 m・高さ約 7 m、切り石の付け柱・軒・半円のニッチ、白い大理石の 2 人の女性像、貝の形の小さな水盤と大きな水盤）
  { id: 'ariege-garonne', kind: 'wallFountain', lat: 43.59221, lon: 1.44454, r: 30 },
  ...LOCKS, // 閘門（locks.js）
  // サン・シプリアンの入市税の門の小屋（Pavillons de l'octroi。利用者のストリートビュー 2026-10-02 210226、航空写真）:
  // Place Intérieure Saint-Cyprien の西の端、噴水のロータリーの両脇に、淡い石の小さな平屋（約 6 m 四方）。正面は広場（東）を向き、
  // 三角の破風と頂の壺の飾り。at: 2 つの小屋の真ん中、face: 正面が向く点
  // Port Saint-Pierre の下の段の川の縁の白い係船柱（利用者の写真 NCM_0103。約 3.5 m おき）
  { id: 'port-saint-pierre-bornes', kind: 'bollards', line: [[43.603738, 1.434135], [43.603391, 1.434889]], step: 3.5 },
  // Purpan の病院の門（利用者のストリートビュー 225754）: 入口の道の両脇の白い飾りの門柱と淡い緑の鉄の柵、道の南の
  // 平屋の高さのクリーム色の漆喰の長い塀（四角い開口が並び、上は瓦）。北の端に赤レンガの半円アーチの通り抜けと、
  // 木の持ち送りの小さな瓦の切妻のひさし。位置は航空写真・IGN の建物（アーチの小屋）
  {
    id: 'purpan-porte', kind: 'hgate', wall: [[43.608181, 1.397792], [43.607916, 1.397792]], arch: [43.608147, 1.397792], face: [43.608, 1.3970],
    pillars: [[43.608092, 1.397657], [43.608162, 1.397637]], railing: [[43.608162, 1.397637], [43.608257, 1.39756]],
  },
  // メトロ Jean-Jaurès のエレベーターのガラスの小屋（利用者のストリートビュー 212318: Allées Roosevelt の側の階段の出入口の脇、
  // 金属の枠のガラスの箱に平らな屋根と黄色い M の看板。位置は航空写真）
  { id: 'ascenseur-jean-jaures', kind: 'lift', at: [[43.60567, 1.448614]], face: [43.6060, 1.4490], size: [2.6, 2.6], h: 3.1 },
  { id: 'octroi-saint-cyprien', kind: 'pavilion', at: [[43.598079, 1.430942], [43.597622, 1.430764]], face: [43.59790, 1.43230], size: [5.6, 6], h: 4.6 },
  { id: 'patte-oie', kind: 'roundabout', lat: 43.59640, lon: 1.42303, radius: 9 },
  // ノートルダム・ド・ラ・ドラード大聖堂の川側の正面（利用者の写真 NCM_0110・0112）: 灰色の石の 6 本の円柱（約 12 m）と
  // 三角の破風の柱廊。教会の建物の、川（facing）の方を向いたいちばん長い壁の前に建てる
  { id: 'daurade', kind: 'portico', lat: 43.60097, lon: 1.43983, r: 30, facing: [43.60097, 1.43876] },
  // キャピトルの主塔（Donjon du Capitole。利用者の Street View 211806）: 淡いクリーム色の壁（約 18 m）、出し狭間の帯と
  // 狭間のある胸壁、急なスレートの寄棟屋根に時計の屋根窓、正面の角に円錐の屋根の小塔 2 つ、真ん中に八角形の鐘楼と尖塔（約 40 m）。
  // front: 正面（時計）が向く先（Square Charles-de-Gaulle）
  { id: 'donjon', kind: 'donjon', lat: 43.60442, lon: 1.44478, r: 12, front: [43.60448, 1.44508] },
  // リケの像（Monument à Pierre-Paul Riquet。利用者の写真 212520）: ジャン・ジョレス通りの北東の端、運河の手前。
  // 淡い灰色の花崗岩の島に、2 段の台・石灰岩の台座（3 m 角・4.5 m）と白い大理石の立像（約 3.5 m）
  // Empalot の旧ニエル兵舎の本館（Place Guy-Hersant の Maison des associations。Alliance Française de Toulouse が入る。
  // 写真: Wikimedia Commons「Place Guy-Hersant, côté sud (Toulouse)」と航空写真）: 長さ約 75 m のクリーム色の漆喰の建物。
  // 窓はレンガと石を交互に積んだ枠、角はレンガと石の縞の角石。両翼は 2 階 + 屋根窓の並ぶスレートのマンサード屋根、
  // 中央の棟は 3 階で少し張り出し、スレートの寄棟屋根。屋根の上に赤レンガの煙突。データの外形（箱）の代わりに描く
  { id: 'caserne-niel', kind: 'barracks', lat: 43.57744, lon: 1.444198, r: 30, minArea: 500 },
  // ノートルダム・ド・ラ・ダルバード（写真: Wikimedia Commons「Façade de Notre-Dame de la Dalbade」ほか）: Rue de la Dalbade に面した
  // 西の正面は、屋根の見えない高いレンガの壁（約 31 m）で、上の縁に持ち送りの帯と狭間、角と真ん中に円錐の尖塔の小塔が 3 本、
  // 真ん中に大きなバラ窓、下に淡い石のルネサンスの入口と、色鮮やかな陶板の半円の浮き彫り（聖母の戴冠）。身廊は控え壁の
  // あいだに尖頭アーチの高窓が並ぶレンガの箱に、低い勾配の瓦屋根。データの外形（教会）の代わりに描く。front: 正面の前の通り
  // サン・シプリアンの市場（Marché couvert Saint-Cyprien、Place Roguet の 2 つのハレット。写真: Wikimedia Commons「Toulouse,
  // Marché Couvert Saint-Cyprien」ほか）: 低いレンガの腰壁の上に、淡い青灰色の鉄の枠に小さなガラスを並べた窓の帯がぐるりと
  // 回り、軒の深く張り出した赤茶の瓦の寄棟屋根。入口の上に小さな切妻。データの外形（商業施設の箱）の代わりに描く
  { id: 'marche-saint-cyprien', kind: 'halls', at: [[43.59755, 1.430203], [43.59787, 1.430189]], minArea: 120 },
  { id: 'dalbade', kind: 'gothic', lat: 43.597632, lon: 1.442584, r: 15, minArea: 1000, front: [43.59763, 1.44222] },
  // レ・ザバトワール（サン・シプリアンの近現代美術館。旧屠畜場。写真: Wikimedia Commons「Les abattoirs - Musée d'art moderne de
  // Toulouse」「Abattoirs de Toulouse 02」）: 東の広場に向いた正面はバシリカの形（高い身廊の切妻と大きな半円アーチの窓、低い両翼）。
  // データの外形（63 × 31 m の箱）が 2 階建ての家の様式で描かれていたので、専用の形で描く。front: 正面の前の広場
  { id: 'abattoirs', kind: 'hall', lat: 43.600879, lon: 1.429539, r: 15, minArea: 1200, front: [43.60115, 1.43020] },
  // カルム市場（Marché des Carmes。写真: Wikimedia Commons「Façade Carmes」「Carmes-panorama」）: 円い 1964 年の建物で、1 階が
  // ガラスの店先の市場、その上の 4 層が駐車場（コンクリートの床の帯と、金属の格子とガラスの外装）、屋上も駐車場（低い胸壁）。
  // データの外形（円い商業施設）がレンガの集合住宅の様式で描かれていたので、専用の形で描く
  // tower: 市場の南西の角の前の、穴あきの金属の板で覆った四角い塔（階段・換気。写真「Façade Carmes」の左。データでは小さな家）
  { id: 'marche-carmes', kind: 'market', lat: 43.597639, lon: 1.44481, r: 12, minArea: 1500, tower: [43.597447, 1.444573] },
  { id: 'riquet', kind: 'statue', lat: 43.60906, lon: 1.45389, facing: [43.6061, 1.4490] },
  // 戦没者記念碑の凱旋門（Monument aux Combattants de la Haute-Garonne、1928 年、Léon Jaussely。François Verdier の並木道の北の端）:
  // 淡い石の大きな門。位置・向き・寸法は LiDAR HD の表面モデルから: 真ん中の高い塊（幅 8 m・奥行き 11.5 m・高さ 16 m）を
  // 四角い通路が並木道の軸に沿って貫き、太い円柱が支える。両脇に列柱の低い翼（writeMemorial。形は Wikimedia Commons の写真から）。
  // 2023 年にメトロ C 線の駅の工事で南へ 35 m 動かして仮置きされ（OpenStreetMap の今の外形は仮置きの場所）、2027 年に
  // 元の場所へ戻る。ここでは元の場所・向きに建てる。facing: 通路の軸の先（並木道の南）。old: 仮置きの外形を探す所
  { id: 'monument-combattants', kind: 'memorial', lat: 43.600102, lon: 1.452021, facing: [43.59847, 1.45219], old: [43.59979, 1.45208] },
  // Place de la Trinité の噴水（1826 年、Urbain Vitry。写真: Wikimedia Commons「Fontaine de la Trinité」、航空写真で位置）:
  // 低い灰色の石の丸い水盤、白い大理石の 3 つの面が内へ反った台座（面ごとにライオンの口の吐水口）、背中合わせの 3 体の
  // ブロンズの翼のあるセイレーンと真ん中の手すり子が、大きな白い大理石の水盤を支える。広場の石畳に淡い石の輪
  // 自転車置き場（利用者の Street View 210226: Place Intérieure Saint-Cyprien の車道沿いに、逆 U 字の鉄の輪がずらりと並び、
  // 自転車がたくさん止めてある）。line: 並びの両端。輪は線に直角で、1 m ごと
  { id: 'velos-saint-cyprien-n', kind: 'bikeracks', line: [[43.598081, 1.431672], [43.598105, 1.431817]] },
  { id: 'velos-saint-cyprien-s', kind: 'bikeracks', line: [[43.597905, 1.431760], [43.597928, 1.431905]] },
  { id: 'fontaine-trinite', kind: 'trinite', lat: 43.599732, lon: 1.44408 },
  // Place Saint-Étienne の噴水（le Griffoul、1546〜1593 年。いちばん古い噴水。写真: Wikimedia Commons「Fontaine de la place
  // Saint-Étienne Toulouse」「Toulouse - Fontaine du Griffoul」、位置は航空写真）: 階段で一段下がった八角形の石畳の中に、八角形の
  // 石の水盤、短い柱とライオンの顔の付いた丸い上の水盤、4 体のブロンズの子ども（marmousets、Pierre Chevenet）が水を吐く八角形の
  // 台座、その上に高いオベリスクと風見
  { id: 'griffoul', kind: 'griffoul', lat: 43.599825, lon: 1.449138 },
  // Place Dupuy のコロンヌ・デュピュイ（1834 年。写真: Wikimedia Commons「Toulouse - Colonne Dupuy - 1」「Columna Dupuy」、位置は
  // 航空写真）: アル・オー・グラン（Halle aux Grains）の西、直径約 9 m の淡い石の丸い水盤の真ん中に、四隅にブロンズのグリフォンの
  // いる白い石の台座、黄土色の石の円柱（約 15 m）と柱頭、頂に金色の名声の女神（Renommée）の像
  { id: 'colonne-dupuy', kind: 'column', lat: 43.600036, lon: 1.453725 },
  // Place Wilson の真ん中の庭と、グドゥリの噴水・回転木馬（squares.js の SQUARES の 'wilson'。写真と航空写真から）。
  // facing: 噴水の詩人の像が向く先（Wikimedia Commons「Alexandre Falguière - Pèire Godolin -Toulouse」: 正面から撮った写真の奥に
  // Allées Roosevelt のタイサンボクの並木が見える。像は南西の Rue Lafayette・キャピトルの方を向く）
  { id: 'place-wilson', kind: 'square', square: 'wilson', facing: [43.60470, 1.44700] },
  // Rue de la République（サン・シプリアン。利用者の Street View 210954・211021）: 通りに面した建物の正面に、亜鉛の縦樋、
  // 1 階の店の色とりどりの日よけ、壁から突き出た吊り看板、2 階の窓の鉄の手すり（窓の並びはファサードのテクスチャと同じ）
  { id: 'republique-facades', kind: 'shopstreet', street: /^Rue de la R[ée]publique$/i, reach: 9 },
  // front: 道路の側（ガラスの面と看板が向く先）。pylon: 道端の看板塔。gravel: 白い砂利の植え込み、mulch: その中の木のチップの島
  // [緯度, 経度, 半径 m]（航空写真 2024 から）
  {
    id: 'mcdo-bayonne', kind: 'fastfood', lat: 43.60828, lon: 1.39535, r: 15, minArea: 150, maxArea: 900,
    front: [43.60795, 1.39540], pylon: [43.60802, 1.39513],
    gravel: [[43.608084, 1.394805], [43.608147, 1.3949], [43.608128, 1.39503], [43.608092, 1.39515], [43.607988, 1.39515], [43.607988, 1.394805]],
    mulch: [[43.608150, 1.39489, 3.2], [43.608075, 1.39502, 3.6], [43.608032, 1.39509, 3.4]],
  },
  // オテル・デュー・サン・ジャックの中庭（航空写真 2024 とストリートビューから）: 中庭の外周、刈り込んだ木の列（左右）、芝の区画、池
  {
    id: 'hotel-dieu-parterre', kind: 'parterre', lat: 43.59969, lon: 1.436825,
    outer: [[43.59981, 1.436675], [43.59985, 1.436775], [43.599844, 1.4369], [43.5998, 1.437], [43.59934, 1.43725], [43.599296, 1.437225], [43.599206, 1.43685], [43.59922, 1.4368]],
    rows: [[[43.59976, 1.436695], [43.599224, 1.43683]], [[43.59978, 1.436995], [43.599328, 1.437235]]],
    lawn: [[43.59963, 1.4367875], [43.59966, 1.4369125], [43.599344, 1.437195], [43.599264, 1.4369125]],
    basin: [43.59969, 1.436825],
  },
  // 日本庭園（航空写真 2024 と写真から）: 茶屋の位置（データの建物を置き換える）、枯山水の砂利の面と白い塀（砂利の側から見て
  // 左から右へ）、茶屋へ渡る木の縁台、太鼓橋の両端、州浜、石灯籠、石組みと玉作りの松の位置 [緯度, 経度]
  {
    id: 'jardin-japonais', kind: 'jgarden', lat: 43.6119432, lon: 1.4318864, r: 12,
    gravel: [[43.6121396, 1.4315433], [43.6121733, 1.4318014], [43.6121306, 1.4318168], [43.6119196, 1.4317349], [43.6119825, 1.4316468], [43.6120633, 1.4315402]],
    wall: [[43.6120633, 1.4315402], [43.6121396, 1.4315433], [43.6121733, 1.4318014]],
    deck: [[43.6120835, 1.4318276], [43.6120767, 1.4319358], [43.6120655, 1.4319343], [43.6120711, 1.4318261]],
    bridge: [[43.6118467, 1.4320888], [43.6118691, 1.4321939]],
    spit: [[43.6120992, 1.4319915], [43.6121306, 1.4320332], [43.6121194, 1.4321105], [43.6120947, 1.4321182], [43.6120633, 1.4320564], [43.6120689, 1.4320023]],
    lantern: [43.6121059, 1.432044],
    rocks: [[43.6121082, 1.4316082], [43.6120992, 1.4316236], [43.6121306, 1.4317318], [43.6121216, 1.4317442], [43.6120296, 1.4316855], [43.6120633, 1.43201], [43.6120296, 1.4319636], [43.6118725, 1.4321491], [43.6119286, 1.4322264], [43.6119174, 1.4322728], [43.6121194, 1.4321337], [43.6120633, 1.4322418]],
    // [緯度, 経度, 高さ m（なければ 2.2〜3.8 m）]。利用者の写真 NCM_0117: 砂利の手前の右は低く刈り込んだ丸い植え込み
    pines: [[43.6121172, 1.4315927], [43.6121351, 1.431755], [43.6120128, 1.4317009, 1.1], [43.6120296, 1.4322032], [43.6119398, 1.4322805], [43.6118725, 1.4319636], [43.612097, 1.4322264], [43.6120633, 1.4323037]],
  },
];

// ---------------------------------------------------------------- 形を決める計算（DOM なし。単体テストあり）

// 輪の中心と平均の半径（円形の外形）
export function circleOf(ring) {
  const [x, z] = centroid(ring);
  let r = 0;
  for (const p of ring) r += Math.hypot(p[0] - x, p[1] - z);
  return { x, z, r: r / ring.length };
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// 点の集まりを囲む、面積が最小の向きの付いた長方形。e1: 長い辺の向き（単位）、e2: それに直交、a ≥ b: 半分の長さ
export function orientedBox(points) {
  const h = hull(points);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const r of h) {
      const u = r[0] * ux + r[1] * uz, v = -r[0] * uz + r[1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  const { ux, uz, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  let e1 = [ux, uz], e2 = [-uz, ux], a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  if (b > a) [e1, e2, a, b] = [e2, [-e1[0], -e1[1]], b, a]; // 長い辺を e1 に（e2 は e1 に直角のまま）
  return { cx, cz, e1, e2, a, b };
}

// (cx, cz) から向き (dx, dz) の半直線が輪と交わるいちばん遠い距離（交わらなければ 0）
export function rayRing(cx, cz, dx, dz, ring) {
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - cx) * ez - (a[1] - cz) * ex) / den;
    const s = ((a[0] - cx) * dz - (a[1] - cz) * dx) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}

// スタジアム: 中心から n 本の放射線で、内側（ピッチの穴）と外側（外壁）までの距離を測る
export function stadiumRays(outer, hole, n = 72) {
  const ref = hole && hole.length >= 3 ? hole : outer;
  const [cx, cz] = centroid(ref);
  const rays = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const dx = Math.cos(t), dz = Math.sin(t);
    const rout = rayRing(cx, cz, dx, dz, outer);
    let rin = hole && hole.length >= 3 ? rayRing(cx, cz, dx, dz, hole) : rout * 0.62;
    if (!(rin > 0) || rin > rout - 6) rin = rout * 0.62;
    rays.push({ dx, dz, rin, rout });
  }
  return { cx, cz, rays };
}

// カバニス: 外形の集まりから、門の枠（向きの付いた長方形）と中央の開口（u の範囲）を決める。
// 開口は、長い向き（u）に並んだ外形の真ん中のもの（なければ中央の 1/4 の幅）。mid: 開口にした外形の番号（なければ -1）
export function cabanisLayout(rings, frontPoint = null) {
  const box = orientedBox(rings.flat());
  const proj = (p) => (p[0] - box.cx) * box.e1[0] + (p[1] - box.cz) * box.e1[1];
  let m0 = -box.a * 0.12, m1 = box.a * 0.12, mid = -1;
  if (rings.length >= 3) {
    // 小さなかけら（面積の小さい外形）は数えない
    const big = rings.map((r, i) => ({ i, u: proj(centroid(r)), area: Math.abs(signedArea(r)) })).filter((q) => q.area >= 100).sort((p, q) => p.u - q.u);
    if (big.length >= 3) {
      mid = big[Math.floor(big.length / 2)].i;
      const us = rings[mid].map(proj);
      m0 = Math.min(...us);
      m1 = Math.max(...us);
    }
    // 端まで届く（真ん中にない）ときや、細すぎ・太すぎのときは中央に置く
    if (mid < 0 || m0 < -box.a * 0.9 || m1 > box.a * 0.9 || m1 - m0 < 6 || m1 - m0 > box.a) {
      m0 = -box.a * 0.12;
      m1 = box.a * 0.12;
      mid = -1;
    }
  }
  let front = 1;
  if (frontPoint) front = (frontPoint[0] - box.cx) * box.e2[0] + (frontPoint[1] - box.cz) * box.e2[1] >= 0 ? 1 : -1;
  return { ...box, m0, m1, mid, front };
}

const bez = (p0, c, p1, n, out) => {
  for (let i = 1; i <= n; i++) {
    const t = i / n, s = 1 - t;
    out.push([s * s * p0[0] + 2 * s * t * c[0] + t * t * p1[0], s * s * p0[1] + 2 * s * t * c[1] + t * t * p1[1]]);
  }
};
// オクシタン十字（トゥールーズの十字: 中が空いて、腕の先が鍵の形に分かれ、12 の玉が付く）。
// 中心 (0,0)、腕は ±x・±z、R: 中心から先端の玉までの距離。ring: 輪郭（閉じた折れ線）、pommels: 12 の玉の位置
export function occitanCross(R = 8) {
  const inner = [0.13 * R, 0.13 * R], corner = [0.9 * R, 0.47 * R], tip = [R, 0];
  // 1 本の腕（+x）の上半分: 付け根の内角 → 広がる脇の線 → 角の玉 → 先端の内側へ戻る弧 → 先端の玉
  const half = [inner];
  bez(inner, [0.52 * R, 0.15 * R], corner, 10, half);
  bez(corner, [0.6 * R, 0.17 * R], tip, 8, half);
  const arm = half.concat(half.slice(0, -1).reverse().map(([x, z]) => [x, -z]));
  arm.pop(); // 下半分の付け根の内角は、次の腕の最初の点と同じ
  const rot = ([x, z], k) => (k === 0 ? [x, z] : k === 1 ? [z, -x] : k === 2 ? [-x, -z] : [-z, x]);
  const ring = [];
  const pommels = [];
  for (let k = 0; k < 4; k++) {
    for (const p of arm) ring.push(rot(p, k));
    pommels.push(rot(corner, k), rot(tip, k), rot([corner[0], -corner[1]], k));
  }
  return { ring, pommels };
}

// 折れ線の線（幅 width、中心線から offset 横にずらす）を四角形の列にする。閉じた折れ線は closed
export function strokeQuads(pts, closed, offset, width) {
  const n = pts.length;
  const segN = (i) => {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
  };
  const side = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const n0 = hasPrev ? segN((i - 1 + n) % n) : segN(i);
    const n1 = hasNext ? segN(i) : n0;
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = 1 / Math.max(0.35, mx * n1[0] + mz * n1[1]); // 角を尖らせすぎない
    const p = pts[i];
    const o0 = (offset - width / 2) * k, o1 = (offset + width / 2) * k;
    side.push([[p[0] + mx * o0, p[1] + mz * o0], [p[0] + mx * o1, p[1] + mz * o1]]);
  }
  const quads = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = side[i], b = side[(i + 1) % n];
    quads.push([a[0], a[1], b[1], b[0]]);
  }
  return quads;
}

// 広場の中で、hint にいちばん近い置ける場所（ok(x, z) が真）。らせん状に探す
export function placeOnPlaza(plaza, hint, ok, maxR = 30) {
  const inside = (x, z) => (plaza ? pointInPolygon(x, z, plaza) : true) && ok(x, z);
  if (inside(hint[0], hint[1])) return hint;
  for (let r = 1; r <= maxR; r += 1) {
    const n = Math.max(8, Math.round(r * 4));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = hint[0] + Math.cos(t) * r, z = hint[1] + Math.sin(t) * r;
      if (inside(x, z)) return [x, z];
    }
  }
  return null;
}

// 車道に沿った広い歩道の上の置き場所（雄鶏の像: 写真では車道の縁の車止めの列のすぐ後ろ、奥に路上駐車の車）。
// roads: 車道 [{ pts, width }]。見える車道（中心線が広場の外を通る所。広場の下を通る道は舗装に隠れる）の縁から
// gap m の、広場の中の点のうち、hint に近く gap が 3 m に近いもの。free(x, z): 置けるか。
// 返り値 { x, z, angle（(cos, sin) が車道の方）} か null
export function kerbSpot(plaza, roads, hint, free, { gaps = [3, 2.5, 3.5, 4], step = 1, maxD = 60 } = {}) {
  let best = null;
  for (const r of roads) {
    const half = r.width / 2;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      if (Math.min(ax, bx) > hint[0] + maxD || Math.max(ax, bx) < hint[0] - maxD || Math.min(az, bz) > hint[1] + maxD || Math.max(az, bz) < hint[1] - maxD) continue;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const n = Math.ceil(L / step);
      for (let k = 0; k <= n; k++) {
        const qx = ax + (bx - ax) * (k / n), qz = az + (bz - az) * (k / n);
        if (Math.hypot(qx - hint[0], qz - hint[1]) > maxD || (plaza && pointInPolygon(qx, qz, plaza))) continue;
        for (const sd of [1, -1]) {
          for (const g of gaps) {
            const px = qx - uz * sd * (half + g), pz = qz + ux * sd * (half + g);
            const score = Math.hypot(px - hint[0], pz - hint[1]) + 2 * Math.abs(g - 3);
            if ((best && score >= best.score) || (plaza && !pointInPolygon(px, pz, plaza)) || !free(px, pz)) continue;
            best = { x: px, z: pz, angle: Math.atan2(qz - pz, qx - px), score };
          }
        }
      }
    }
  }
  return best && { x: best.x, z: best.z, angle: best.angle };
}

// スタジアムの外壁に食い込んだ小さな建物（角の階段の塔など）: 外形の頂点と頂点を共有する、高さ 6 m 以上のもの
// （低い売店・切符売り場はそのまま）
export function stadiumAnnexes(stadium, buildings, maxArea = 400) {
  const near = (p) => stadium.outer.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5);
  return buildings.filter((b) => b !== stadium && b.info.area < maxArea && (b.info.height || 0) >= 6 && b.outer.some(near));
}

// メトロのエレベーターだけの出入口（<エリア>-metro.json の elevator。OpenStreetMap の subway_entrance。LiDAR で階段の吹き抜けが
// 見つからない駅だけ）: 地上のガラスの小屋（lift。Jean-Jaurès と同じ形、メトロのゲームと同じ大きさ）を MONUMENTS に足す。
// 同じ所（6 m 以内）にもうあれば足さない。エリアを作るときに 1 回（タイルの名所を探す前）
export function addLiftKiosks(entries) {
  let n = 0;
  for (const e of entries || []) {
    if (e.kind !== 'elevator' || !e.face) continue;
    const lifts = MONUMENTS.filter((m) => m.kind === 'lift').flatMap((m) => m.at);
    if (lifts.some(([la, lo]) => Math.hypot((la - e.lat) * 111200, (lo - e.lon) * 80500) < 6)) continue;
    MONUMENTS.push({ id: `ascenseur-${e.station}-${e.lat.toFixed(6)}`, kind: 'lift', at: [[e.lat, e.lon]], face: e.face, size: [2.0, 2.0], h: 2.8 });
    n++;
  }
  return n;
}

// 名所の専用モデルの置き場所を決める。buildings: このタイル（エリア）の建物、bounds: このタイルの範囲
// （像・十字はその中にあるときだけ作る）、onRoad(x, z): 車道の上か（広場の下を通る道も）、roads: 道路（parse.js。
// 雄鶏の像を見える車道の縁に置くため）。replaced の建物は描かない（当たり判定は残す）
export function findMonuments(proj, { buildings = [], areas = [], facade = null, bounds = null, onRoad = () => false, roads = [] } = {}) {
  const out = [];
  const carRoads = roads.filter((r) => CAR_ROADS.has(r.type) && !r.bridge && !r.tunnel && r.pts?.length >= 2);
  const inB = (x, z) => !bounds || (x >= bounds.minX && x < bounds.maxX && z >= bounds.minZ && z < bounds.maxZ);
  const inBuilding = (x, z, m = 0) => buildings.some((b) => x > b.bounds.minX - m && x < b.bounds.maxX + m && z > b.bounds.minZ - m && z < b.bounds.maxZ + m && pointInRing(x, z, b.outer));
  for (const spec of MONUMENTS) {
    const [x, z] = spec.lat != null ? proj.project(spec.lat, spec.lon) : [0, 0];
    if (spec.kind === 'chateau') {
      // 円形の基壇の外形（頂点の多い、小さめの建物）
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.outer.length < 8 || b.info.area < 60 || b.info.area > 700) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const c = circleOf(best.b.outer);
      out.push({ spec, kind: 'chateau', x: c.x, z: c.z, rBase: Math.min(11, Math.max(5, c.r)), replaced: [best.b] });
    } else if (spec.kind === 'dome') {
      // 礼拝堂の建物（いちばん近い 200 m² 以上の建物）の上に載せる
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 200) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      out.push({ spec, kind: 'dome', x, z, base: best.b.info.height || 14, replaced: [] });
    } else if (spec.kind === 'donjon') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 80 || b.info.area > 500) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      const [fx, fz] = proj.project(...spec.front);
      const fl = Math.hypot(fx - ob.cx, fz - ob.cz) || 1;
      out.push({ spec, kind: 'donjon', ...ob, front: [(fx - ob.cx) / fl, (fz - ob.cz) / fl], replaced: [best.b] });
    } else if (spec.kind === 'portico') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 500) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const [fx, fz] = proj.project(...spec.facing);
      const fl = Math.hypot(fx - x, fz - z) || 1, f = [(fx - x) / fl, (fz - z) / fl];
      const ring = best.b.outer, sg = signedArea(ring) > 0 ? 1 : -1;
      let face = null;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (L < 12) continue;
        const n = [((c[1] - a[1]) / L) * sg, (-(c[0] - a[0]) / L) * sg];
        const score = (n[0] * f[0] + n[1] * f[1]) * Math.min(L, 30);
        if (n[0] * f[0] + n[1] * f[1] > 0.7 && (!face || score > face.score)) face = { a, c, L, n, score };
      }
      if (!face) continue;
      out.push({ spec, kind: 'portico', mid: [(face.a[0] + face.c[0]) / 2, (face.a[1] + face.c[1]) / 2], t: [(face.c[0] - face.a[0]) / face.L, (face.c[1] - face.a[1]) / face.L], n: face.n, width: Math.min(22, face.L - 2), replaced: [] });
    } else if (spec.kind === 'basilica') {
      const b = buildings.find((q) => q.info.isChurch && q.info.area > 2000 && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const ob = orientedBox(b.outer);
      const [px, pz] = proj.project(...spec.apex);
      const sg = (px - ob.cx) * ob.e1[0] + (pz - ob.cz) * ob.e1[1] >= 0 ? 1 : -1;
      const e1 = [ob.e1[0] * sg, ob.e1[1] * sg], e2 = [-e1[1], e1[0]];
      const sc = (x - ob.cx) * e1[0] + (z - ob.cz) * e1[1];
      out.push({ spec, kind: 'basilica', cx: ob.cx, cz: ob.cz, e1, e2, a: ob.a, b: ob.b, sc, height: b.info.height, replaced: [b] });
    } else if (spec.kind === 'capitainerie') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d < spec.r && b.info.area > 150 && b.info.area < 800 && (!best || d < best.d)) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      const [fx, fz] = proj.project(...spec.front);
      const fl = Math.hypot(fx - ob.cx, fz - ob.cz) || 1, f = [(fx - ob.cx) / fl, (fz - ob.cz) / fl];
      // かまぼこ屋根の軸は正面の向きに近い方の辺
      const along1 = Math.abs(ob.e1[0] * f[0] + ob.e1[1] * f[1]) >= Math.abs(ob.e2[0] * f[0] + ob.e2[1] * f[1]);
      let ax = along1 ? ob.e1 : ob.e2;
      if (ax[0] * f[0] + ax[1] * f[1] < 0) ax = [-ax[0], -ax[1]];
      out.push({ spec, kind: 'capitainerie', cx: ob.cx, cz: ob.cz, ax, hl: along1 ? ob.a : ob.b, hw: along1 ? ob.b : ob.a, replaced: [best.b] });
    } else if (spec.kind === 'moorings') {
      const [a, b] = spec.quay.map((ll) => proj.project(...ll)), [wx, wz] = proj.project(...spec.water);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let n = [-t[1], t[0]];
      if ((wx - a[0]) * n[0] + (wz - a[1]) * n[1] < 0) n = [-n[0], -n[1]];
      const water = areas.find((q) => q.type === 'water' && pointInPolygon(wx, wz, q));
      const boats = [];
      for (let s = 4, k = 0; s < L - 8; k++) {
        const len = 16 + hash01(k, 71) * 10;
        const c = s + len / 2, off = 3.4 + hash01(k, 72) * 0.6;
        const bx = a[0] + t[0] * c + n[0] * off, bz = a[1] + t[1] * c + n[1] * off;
        if (inB(bx, bz)) boats.push({ x: bx, z: bz, len, k });
        s += len + 2.5 + hash01(k, 73) * 3;
      }
      if (boats.length) out.push({ spec, kind: 'moorings', t, n, boats, area: water || null, replaced: [] });
    } else if (spec.kind === 'riverfront') {
      const b = buildings.find((q) => q.info.area >= spec.minArea && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const [fx, fz] = proj.project(...spec.facing);
      const fl = Math.hypot(fx - x, fz - z) || 1, f = [(fx - x) / fl, (fz - z) / fl];
      const sg = signedArea(b.outer) > 0 ? 1 : -1;
      let best = null;
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg];
        if (L >= 15 && n[0] * f[0] + n[1] * f[1] > 0.6 && (!best || L > best.L)) best = { p, q, L, n };
      }
      if (best) out.push({ spec, kind: 'riverfront', ...best, height: b.info.height || 18, replaced: [] });
    } else if (spec.kind === 'arcades') {
      const b = buildings.find((q) => q.info.area >= spec.minArea && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const fs = spec.facing.map((ll) => {
        const [fx, fz] = proj.project(...ll), fl = Math.hypot(fx - x, fz - z) || 1;
        return [(fx - x) / fl, (fz - z) / fl];
      });
      const sg = signedArea(b.outer) > 0 ? 1 : -1, edges = [];
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg];
        if (L >= 10 && fs.some((f) => n[0] * f[0] + n[1] * f[1] > 0.8)) edges.push({ p, q, L, n });
      }
      if (!edges.length) continue;
      b.blank = true; // 建物の壁は窓のないレンガ（窓・アーケードはこのモデルで描く。buildings.js）
      out.push({ spec, kind: 'arcades', edges, replaced: [] });
    } else if (spec.kind === 'choir') {
      const b = buildings.find((q) => q.info.isChurch && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const [ex, ez] = proj.project(...spec.east);
      const l = Math.hypot(ex - x, ez - z) || 1, e = [(ex - x) / l, (ez - z) / l], s0 = x * e[0] + z * e[1] + spec.split;
      const sg = signedArea(b.outer) > 0 ? 1 : -1, edges = [];
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (L < 3 || ((p[0] + q[0]) / 2) * e[0] + ((p[1] + q[1]) / 2) * e[1] < s0) continue;
        edges.push({ p, q, L, n: [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg] });
      }
      out.push({ spec, kind: 'choir', edges, height: b.info.height || 22, replaced: [] });
    } else if (spec.kind === 'lock') {
      const a = proj.project(...spec.a), b = proj.project(...spec.b);
      if (!inB((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      const water = areas.find((q) => q.type === 'water' && pointInPolygon((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, q));
      out.push({ spec, kind: 'lock', a, b, width: spec.width, from: spec.from, area: water || null, replaced: [] });
    } else if (spec.kind === 'bikeracks') {
      const P = spec.line.map((ll) => proj.project(...ll));
      if (!inB((P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2)) continue;
      out.push({ spec, kind: 'bikeracks', a: P[0], b: P[1], replaced: [] });
    } else if (spec.kind === 'bollards') {
      const P = spec.line.map((ll) => proj.project(...ll));
      if (!P.some(([x, z]) => inB(x, z))) continue;
      out.push({ spec, kind: 'bollards', pts: P, step: spec.step, replaced: [] });
    } else if (spec.kind === 'hgate') {
      const [ax, az] = proj.project(...spec.wall[0]), [bx, bz] = proj.project(...spec.wall[1]);
      if (!inB((ax + bx) / 2, (az + bz) / 2)) continue;
      const [cx, cz] = proj.project(...spec.arch), [fx, fz] = proj.project(...spec.face);
      // アーチの小屋（IGN の小さな建物）はこのモデルで描く
      const replaced = buildings.filter((b) => b.info.area < 40 && Math.hypot(b.inside[0] - cx, b.inside[1] - cz) < 5);
      out.push({ spec, kind: 'hgate', a: [ax, az], b: [bx, bz], arch: [cx, cz], face: [fx, fz], pillars: spec.pillars.map((ll) => proj.project(...ll)), railing: spec.railing.map((ll) => proj.project(...ll)), replaced });
    } else if (spec.kind === 'pavilion' || spec.kind === 'lift') {
      const [fx, fz] = proj.project(...spec.face);
      for (const ll of spec.at) {
        const [px, pz] = proj.project(...ll);
        if (!inB(px, pz)) continue;
        const fl = Math.hypot(fx - px, fz - pz) || 1;
        out.push({ spec, kind: spec.kind, x: px, z: pz, f: [(fx - px) / fl, (fz - pz) / fl], size: spec.size, h: spec.h, replaced: [] });
      }
    } else if (spec.kind === 'equestrian') {
      if (!inB(x, z)) continue;
      const [fx, fz] = proj.project(...spec.facing);
      out.push({ spec, kind: 'equestrian', x, z, angle: Math.atan2(fz - z, fx - x), replaced: [] });
    } else if (spec.kind === 'wallFountain') {
      // (x, z) の方を向いた、いちばん近い長さ 7 m 以上の建物の壁の真ん中
      let best = null;
      for (const b of buildings) {
        const sg = signedArea(b.outer) > 0 ? 1 : -1;
        for (let i = 0; i < b.outer.length; i++) {
          const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (L < 7) continue;
          const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg], mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
          const d = Math.hypot(x - mx, z - mz);
          if (d > spec.r || (x - mx) * n[0] + (z - mz) * n[1] < 0.5 * d || (best && d >= best.d)) continue;
          best = { d, mid: [mx, mz], n, t: [(q[0] - p[0]) / L, (q[1] - p[1]) / L] };
        }
      }
      if (!best || !inB(...best.mid)) continue;
      out.push({ spec, kind: 'wallFountain', mid: best.mid, n: best.n, t: best.t, replaced: [] });
    } else if (spec.kind === 'island') {
      const [a, b] = spec.line.map((ll) => proj.project(...ll));
      if (!inB((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      out.push({ spec, kind: 'island', a, b, half: spec.half, replaced: [] });
    } else if (spec.kind === 'roundabout') {
      if (!inB(x, z)) continue;
      out.push({ spec, kind: 'roundabout', x, z, radius: spec.radius, replaced: [] });
    } else if (spec.kind === 'shopstreet') {
      // 通りに面した建物の正面の辺（通りに平行で、外向きの法線が通りを向くもの）
      const segs = [];
      for (const r of roads) if (!r.bridge && !r.tunnel && spec.street.test(r.name || '')) for (let i = 0; i + 1 < r.pts.length; i++) segs.push([r.pts[i], r.pts[i + 1], r.width / 2 + spec.reach]);
      if (!segs.length) continue;
      const fronts = [];
      for (const b of buildings) {
        if ((b.info.height || 0) < 6 || b.info.isChurch || b.info.area > 2500 || (b.info.minHeight || 0) > 0.5) continue;
        const sg = signedArea(b.outer) > 0 ? 1 : -1;
        for (let i = 0; i < b.outer.length; i++) {
          const a = b.outer[i], c = b.outer[(i + 1) % b.outer.length], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
          const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
          if (L < 3 || !inB(mx, mz)) continue;
          const n = [((c[1] - a[1]) / L) * sg, (-(c[0] - a[0]) / L) * sg];
          for (const [p, q, reach] of segs) {
            const sl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
            if (Math.abs(((c[0] - a[0]) * (q[0] - p[0]) + (c[1] - a[1]) * (q[1] - p[1])) / (L * sl)) < 0.85) continue;
            const h = closestOnSegment(mx, mz, p[0], p[1], q[0], q[1]);
            if (h.d2 > reach * reach || n[0] * (h.x - mx) + n[1] * (h.z - mz) <= 0) continue;
            fronts.push({ a, c, n, L, b, i });
            break;
          }
        }
      }
      if (fronts.length) out.push({ spec, kind: 'shopstreet', fronts, replaced: [] });
    } else if (spec.kind === 'trinite' || spec.kind === 'griffoul' || spec.kind === 'column') {
      if (!inB(x, z)) continue;
      out.push({ spec, kind: spec.kind, x, z, replaced: [] });
    } else if (spec.kind === 'halls') {
      const halls = [];
      for (const ll of spec.at) {
        const [hx, hz] = proj.project(...ll);
        if (!inB(hx, hz)) continue;
        let best = null;
        for (const b of buildings) {
          const d = Math.hypot(b.inside[0] - hx, b.inside[1] - hz);
          if (d > 8 || b.info.area < spec.minArea) continue;
          if (!best || d < best.d) best = { b, d };
        }
        if (best) halls.push({ ...orientedBox(best.b.outer), bld: best.b }); // b は箱の半分の幅（orientedBox）なので建物は bld に
      }
      if (halls.length) out.push({ spec, kind: 'halls', halls, replaced: halls.map((h) => h.bld) });
    } else if (spec.kind === 'gothic' || spec.kind === 'hall') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < spec.minArea) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      const [fx, fz] = proj.project(...spec.front);
      // e1: 正面（u = −a）から奥へ
      const e1 = (fx - ob.cx) * ob.e1[0] + (fz - ob.cz) * ob.e1[1] > 0 ? [-ob.e1[0], -ob.e1[1]] : ob.e1;
      out.push({ spec, kind: spec.kind, cx: ob.cx, cz: ob.cz, e1, e2: [-e1[1], e1[0]], a: ob.a, b: ob.b, replaced: [best.b] });
    } else if (spec.kind === 'market') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < spec.minArea) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const replaced = [best.b];
      let tower = null;
      if (spec.tower) {
        const [tx, tz] = proj.project(...spec.tower);
        const tb = buildings.find((q) => q !== best.b && q.info.area < 250 && Math.hypot(q.inside[0] - tx, q.inside[1] - tz) < 6);
        if (tb) {
          replaced.push(tb);
          tower = { ...orientedBox(tb.outer), height: tb.info.height || 9 };
        }
      }
      out.push({ spec, kind: 'market', outer: best.b.outer, height: best.b.info.height || 20, tower, replaced });
    } else if (spec.kind === 'barracks') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < spec.minArea) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      out.push({ spec, kind: 'barracks', ...ob, replaced: [best.b] });
    } else if (spec.kind === 'memorial') {
      if (!inB(x, z)) continue;
      const [fx, fz] = proj.project(...spec.facing), fl = Math.hypot(fx - x, fz - z) || 1;
      // 仮置きの場所の外形（OpenStreetMap の building=roof・historic=memorial）は描かない・ぶつからない
      const [ox, oz] = proj.project(...spec.old);
      const replaced = buildings.filter((b) => b.info.area < 400 && Math.hypot(b.inside[0] - ox, b.inside[1] - oz) < 12 && (b.tags?.historic === 'memorial' || b.info.kind === 'roof'));
      out.push({ spec, kind: 'memorial', x, z, f: [(fx - x) / fl, (fz - z) / fl], replaced, open: replaced });
    } else if (spec.kind === 'statue') {
      if (!inB(x, z)) continue;
      const [fx, fz] = proj.project(...spec.facing);
      out.push({ spec, kind: 'statue', x, z, angle: Math.atan2(fz - z, fx - x), replaced: [] });
    } else if (spec.kind === 'stadium') {
      const b = buildings.find((q) => q.info.area > 5000 && Math.hypot(centroid(q.outer)[0] - x, centroid(q.outer)[1] - z) < spec.r);
      if (!b) continue;
      const hole = b.holes.slice().sort((p, q) => q.length - p.length)[0] || null;
      const annex = stadiumAnnexes(b, buildings);
      out.push({ spec, kind: 'stadium', outer: b.outer, hole, annex: annex.map((q) => q.outer), replaced: [b, ...annex], height: b.info.height || 12 });
    } else if (spec.kind === 'cabanis') {
      const parts = buildings.filter((b) => (b.info.height || 0) >= spec.minHeight && Math.hypot(centroid(b.outer)[0] - x, centroid(b.outer)[1] - z) < spec.r);
      if (!parts.length) continue;
      const front = spec.front ? proj.project(spec.front[0], spec.front[1]) : null;
      const lay = cabanisLayout(parts.map((b) => b.outer), front);
      // 開口の下（真ん中の外形）は通り抜けられる（当たり判定を付けない）
      out.push({ spec, kind: 'cabanis', layout: lay, height: Math.max(...parts.map((b) => b.info.height)), replaced: parts, open: lay.mid >= 0 ? [parts[lay.mid]] : [] });
    } else if (spec.kind === 'coq') {
      const plaza = areas.find((a) => spec.plaza.test(a.name || ''));
      // 車道から 2 m 以上、建物から 3 m 以上離す
      const free = (px, pz) => {
        for (let k = 0; k < 8; k++) {
          const t = (k / 8) * Math.PI * 2;
          if (onRoad(px + Math.cos(t) * 2.5, pz + Math.sin(t) * 2.5)) return false;
        }
        return !inBuilding(px, pz, 3);
      };
      // 見える車道の縁石から 2.5〜4 m の歩道の上（車止めの列・路上駐車の車のそば）。なければ広場の中の hint の近く
      const k = kerbSpot(plaza, carRoads, [x, z], free);
      const p = k ? [k.x, k.z] : placeOnPlaza(plaza, [x, z], free);
      if (!p || !inB(p[0], p[1])) continue;
      // 像は車道の方を向く（縁に置けなかったときは、いちばん近い車道の方）
      let angle = k ? k.angle : 0, bestD = Infinity;
      for (let j = 0; !k && j < 16; j++) {
        const t = (j / 16) * Math.PI * 2;
        for (let d = 2.5; d < 40; d += 0.5) {
          if (onRoad(p[0] + Math.cos(t) * d, p[1] + Math.sin(t) * d)) {
            if (d < bestD) [bestD, angle] = [d, t];
            break;
          }
        }
      }
      out.push({ spec, kind: 'coq', x: p[0], z: p[1], angle, replaced: [] });
    } else if (spec.kind === 'fastfood') {
      let best = null;
      for (const b of buildings) {
        const [bx, bz] = centroid(b.outer), d = Math.hypot(bx - x, bz - z);
        if (d > spec.r || b.info.area < spec.minArea || b.info.area > spec.maxArea) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ll = (p) => proj.project(p[0], p[1]);
      out.push({
        spec, kind: 'fastfood', outer: best.b.outer, height: Math.max(4.8, (best.b.info.height || 0) + 0.9), replaced: [best.b],
        front: ll(spec.front), pylon: ll(spec.pylon), gravel: spec.gravel.map(ll), mulch: spec.mulch.map((m) => [...ll(m), m[2]]),
      });
    } else if (spec.kind === 'square') {
      const sq = squaresLocal(proj).find((q) => q.id === spec.square);
      if (!sq) continue;
      if (inB(sq.cx, sq.cz)) {
        const [tx, tz] = proj.project(...spec.facing);
        out.push({ spec, kind: 'square', sq, outline: gardenOutline(sq, roads), gates: gardenGates(sq, roads), paths: gardenPathSegments(sq, roads), angle: Math.atan2(tz - sq.fz, tx - sq.fx), replaced: [] });
      }
      // 回転木馬: 地図の円い建物（高さ 6 m の箱）を置き換える（庭の中心と別のタイルのこともあるので別に）
      if (inB(sq.kx, sq.kz)) {
        const replaced = buildings.filter((b) => b.info.area < 150 && Math.hypot(b.inside[0] - sq.kx, b.inside[1] - sq.kz) < 4);
        out.push({ spec, kind: 'carousel', x: sq.kx, z: sq.kz, R: sq.carouselR, replaced });
      }
    } else if (spec.kind === 'parterre') {
      const ll = (p) => proj.project(p[0], p[1]);
      const outer = spec.outer.map(ll), [cx, cz] = centroid(outer);
      if (!inB(cx, cz)) continue;
      out.push({ spec, kind: 'parterre', x: cx, z: cz, outer, rows: spec.rows.map((r) => r.map(ll)), lawn: spec.lawn.map(ll), basin: ll(spec.basin), replaced: [] });
    } else if (spec.kind === 'jgarden') {
      const ll = (p) => proj.project(p[0], p[1]);
      const gravel = spec.gravel.map(ll), [gx, gz] = centroid(gravel);
      if (!inB(gx, gz)) continue;
      // 茶屋: 近くの小さな建物（データでは 4 m の箱）を置き換える
      let tea = null;
      for (const b of buildings) {
        const [bx, bz] = centroid(b.outer), d = Math.hypot(bx - x, bz - z);
        if (d < spec.r && b.info.area < 400 && (!tea || d < tea.d)) tea = { b, d };
      }
      out.push({
        spec, kind: 'jgarden', x: gx, z: gz, gravel, wall: spec.wall.map(ll), deck: spec.deck.map(ll), bridge: spec.bridge.map(ll), spit: spec.spit.map(ll),
        lantern: ll(spec.lantern), rocks: spec.rocks.map(ll), pines: spec.pines.map((p) => [...ll(p), p[2]]), tea: tea ? tea.b.outer : null, replaced: tea ? [tea.b] : [],
      });
    } else if (spec.kind === 'cross') {
      const plaza = areas.find((a) => spec.plaza.test(a.name || ''));
      if (!plaza) continue;
      let [cx, cz] = centroid(plaza.outer);
      let ax = [1, 0];
      if (facade) {
        // キャピトルの正面の中央から、広場の中心へ（十字は正面の軸の上）
        const t = (facade.t0 + facade.t1) / 2;
        const mx = facade.origin[0] + facade.dir[0] * t, mz = facade.origin[1] + facade.dir[1] * t;
        const d = (cx - mx) * facade.normal[0] + (cz - mz) * facade.normal[1];
        cx = mx + facade.normal[0] * d;
        cz = mz + facade.normal[1] * d;
        ax = facade.normal;
      }
      if (!inB(cx, cz)) continue;
      out.push({ spec, kind: 'cross', x: cx, z: cz, ax, radius: spec.radius, replaced: [] });
    }
  }
  // ジャン・ジョレス通りの遊歩道の植え込み（ramblas.js）: 帯に沿って 2.3 m ごとに低木、約 7.5 m ごとに若い木
  const rl = roads.length ? ramblasLayout(roads, proj) : null;
  if (rl) {
    const shrubs = [], young = [];
    for (const line of rl.beds) {
      let next = 0, acc = 0, nextTree = 3;
      for (let i = 0; i + 1 < line.length; i++) {
        const p = line[i], q = line[i + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
        for (; next < acc + L; next += 2.3) {
          const t = next - acc, k = Math.round(next / 2.3), off = (k % 2 ? 1 : -1) * (0.8 + hash01(k, 61) * 1.2);
          const x = p[0] + ux * t - uz * off, z = p[1] + uz * t + ux * off;
          if (inB(x, z)) shrubs.push([x, z, k]);
        }
        for (; nextTree < acc + L; nextTree += 6 + hash01(Math.round(nextTree), 62) * 3) {
          const t = nextTree - acc, off = (hash01(Math.round(nextTree), 63) - 0.5) * 2.4;
          const x = p[0] + ux * t - uz * off, z = p[1] + uz * t + ux * off;
          if (inB(x, z)) young.push([x, z, Math.round(nextTree)]);
        }
        acc += L;
      }
    }
    if (shrubs.length || young.length) out.push({ kind: 'ramblas', shrubs, young, replaced: [] });
  }
  return out;
}

// 木を植えない帯（monumentClearance）。a・b: オテル・デューの川側の正面の南と北の端（帯は a → b の向きの (−t_z, t_x) の側）
const TREELESS_BANDS = [{ a: [43.599373, 1.437639], b: [43.600559, 1.436138], depth: 40 }];

// 木を植えない所（像・塔のまわり）
// proj: あれば、タイルの外の名所の所も（隣のタイルの木を名所の前に植えない）
export function monumentClearance(list, proj = null) {
  const circles = [];
  // サン・セルナンの東の端（後陣・周歩廊・礼拝堂）の前は開けた広場（利用者の写真 NCM_0099）。chevet: 後陣の中心
  if (proj) for (const spec of MONUMENTS) if (spec.kind === 'basilica' && spec.chevet) circles.push([...proj.project(...spec.chevet), 30]);
  // 広場の真ん中の庭の噴水と回転木馬（squares.js）のまわり（隣のタイルの木も）
  if (proj) for (const sq of squaresLocal(proj)) circles.push([sq.fx, sq.fz, sq.basin + 2.5], [sq.kx, sq.kz, sq.carouselR + 1.2]);
  for (const m of list) {
    if (m.kind === 'chateau') circles.push([m.x, m.z, m.rBase + 9]); // 柵の外の歩道まで（交差点から塔が見えるように）
    if (m.kind === 'coq') circles.push([m.x, m.z, 3]);
    if (m.kind === 'roundabout') circles.push([m.x, m.z, m.radius + 0.5]); // 島の木は島のモデルで描く
    if (m.kind === 'statue') circles.push([m.x, m.z, 6]);
    if (m.kind === 'memorial') circles.push([m.x, m.z, 11]);
    if (m.kind === 'pavilion') circles.push([m.x, m.z, 5]);
    if (m.kind === 'hgate') circles.push([...m.arch, 5], ...m.pillars.map(([x, z]) => [x, z, 3]));
    if (m.kind === 'lift') circles.push([m.x, m.z, 3]);
    if (m.kind === 'griffoul') circles.push([m.x, m.z, 5.5]);
    if (m.kind === 'column') circles.push([m.x, m.z, 5.5]);
  }
  // 木を植えない帯: 線 a → b の川の側に depth m。オテル・デューの川側の正面の前（利用者の写真 NCM_0107・0136:
  // 壁は水際から立ち、前に木はない）
  const bands = proj ? TREELESS_BANDS.map(({ a, b, depth }) => {
    const p = proj.project(...a), q = proj.project(...b), L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    return { p, t, n: [-t[1], t[0]], L, depth };
  }) : [];
  const inBand = (x, z) => bands.some(({ p, t, n, L, depth }) => {
    const dx = x - p[0], dz = z - p[1], u = dx * t[0] + dz * t[1], v = dx * n[0] + dz * n[1];
    return u > -4 && u < L + 4 && v > -2 && v < depth;
  });
  // 中庭の刈り込んだ木は専用の形で描くので、地形モデルの木（丸い樹冠）は植えない。日本庭園の枯山水の砂利の面にも
  // 植えない（利用者の写真 NCM_0117: 砂利の面には石組みのそばの小さな松だけ）
  const rings = list.filter((m) => m.kind === 'parterre').map((m) => m.outer).concat(list.filter((m) => m.kind === 'jgarden').map((m) => m.gravel));
  return (x, z) => circles.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r) || rings.some((r) => pointInRing(x, z, r)) || inBand(x, z);
}

// 名所の台・柵の内側（街の小物 furniture.js を置かない所）。buildMonuments の keepOut の円 [x, z, r]
// （柵に抜けがあって当たり判定が線分のときも、柵の円の内側全体）
export function monumentSolid(keepOut, pad = 0.4) {
  const circles = keepOut.filter((c) => c.length === 3);
  return (x, z) => circles.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r + pad);
}

// ---------------------------------------------------------------- メッシュ

// テクスチャの区画（makeMonumentTexture）。1 区画 = 256 px 四方
const CELL = { brick: 0, louvre: 1, seats: 2, pitch: 3, cladding: 4, plain: 5 };
const NCELL = 6;
const UE = 0.004; // 区画の境のにじみを避ける
const cu = (cell, u) => (cell + UE + Math.min(1, Math.max(0, u)) * (1 - 2 * UE)) / NCELL;
const PLAIN_UV = [cu(CELL.plain, 0.5), 0.5];
const col = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const WHITE = [1, 1, 1];

// 縦の壁 a→b（[x, z]）、高さ y0〜y1。テクスチャの区画 1 枚を cw × ch m に敷き詰める（端数は区画を伸ばす）
function wall(w, a, b, y0, y1, n, cell, cw, ch, color = WHITE) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nu = Math.max(1, Math.round(L / cw)), nv = Math.max(1, Math.round((y1 - y0) / ch));
  for (let i = 0; i < nu; i++) {
    const s0 = i / nu, s1 = (i + 1) / nu;
    const p0 = [a[0] + (b[0] - a[0]) * s0, a[1] + (b[1] - a[1]) * s0], p1 = [a[0] + (b[0] - a[0]) * s1, a[1] + (b[1] - a[1]) * s1];
    for (let j = 0; j < nv; j++) {
      const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv;
      w.quad([p0[0], ya, p0[1]], [p1[0], ya, p1[1]], [p1[0], yb, p1[1]], [p0[0], yb, p0[1]], n,
        [cu(cell, 0), 0], [cu(cell, 1), 0], [cu(cell, 1), 1], [cu(cell, 0), 1], color);
    }
  }
}

// 円筒（半径 r0→r1、y0〜y1）。外向き（inward なら内向き）。区画 1 枚 ≒ cw × ch m
function cylinder(w, cx, cz, r0, r1, y0, y1, { seg = 24, cell = CELL.plain, cw = 1e9, ch = 1e9, color = WHITE, inward = false } = {}) {
  const nv = Math.max(1, Math.round((y1 - y0) / ch));
  const per = Math.max(1, Math.round((2 * Math.PI * Math.max(r0, r1)) / seg / cw));
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
    const sl = (r0 - r1) / Math.max(0.01, y1 - y0);
    const nl = Math.hypot(1, sl), sg = inward ? -1 : 1;
    const n = [(Math.cos(am) / nl) * sg, (sl / nl) * sg, (Math.sin(am) / nl) * sg];
    for (let j = 0; j < nv; j++) {
      const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv;
      const ra = r0 + ((r1 - r0) * j) / nv, rb = r0 + ((r1 - r0) * (j + 1)) / nv;
      const P = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const uvs = cell === CELL.plain ? [PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV]
        : [[cu(cell, (k % per) / per), 0], [cu(cell, ((k % per) + 1) / per), 0], [cu(cell, ((k % per) + 1) / per), 1], [cu(cell, (k % per) / per), 1]];
      w.quad(P(a0, ra, ya), P(a1, ra, ya), P(a1, rb, yb), P(a0, rb, yb), n, ...uvs, color);
    }
  }
}

// 水平の輪（r0〜r1、高さ y）。up: 上向き
function annulus(w, cx, cz, r0, r1, y, seg, color, up = true) {
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const P = (a, r) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    if (r0 < 0.01) w.tri([cx, y, cz], P(a0, r1), P(a1, r1), [0, up ? 1 : -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    else w.quad(P(a0, r0), P(a1, r0), P(a1, r1), P(a0, r1), [0, up ? 1 : -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  }
}

// 向きの付いた箱。o: 中心、ex/ey/ez: 半分の辺のベクトル（3 次元）。colors: { top, side, bottom }
function box(w, o, ex, ey, ez, color, { top = color, bottom = color } = {}) {
  const V = (sx, sy, sz) => [o[0] + ex[0] * sx + ey[0] * sy + ez[0] * sz, o[1] + ex[1] * sx + ey[1] * sy + ez[1] * sz, o[2] + ex[2] * sx + ey[2] * sy + ez[2] * sz];
  const N = (v, s) => {
    const l = Math.hypot(...v) || 1;
    return [(v[0] / l) * s, (v[1] / l) * s, (v[2] / l) * s];
  };
  const face = (a, b, c, d, n, cl) => w.quad(a, b, c, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
  face(V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), V(1, -1, 1), N(ex, 1), color);
  face(V(-1, -1, -1), V(-1, 1, -1), V(-1, 1, 1), V(-1, -1, 1), N(ex, -1), color);
  face(V(-1, 1, -1), V(1, 1, -1), V(1, 1, 1), V(-1, 1, 1), N(ey, 1), top);
  face(V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), N(ey, -1), bottom);
  face(V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1), N(ez, 1), color);
  face(V(-1, -1, -1), V(1, -1, -1), V(1, 1, -1), V(-1, 1, -1), N(ez, -1), color);
}

// 縦の平面の上の凸多角形（s: 面に沿った向き、pts: [s, y]）。n: 表の向き
function vpoly(w, o, s, pts, n, color) {
  const P = ([a, y]) => [o[0] + s[0] * a, y, o[1] + s[1] * a];
  for (let i = 1; i + 1 < pts.length; i++) w.tri(P(pts[0]), P(pts[i]), P(pts[i + 1]), n, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
}
// 半円アーチの開口の形（幅 wd、高さ ht、足元 y0）
const archShape = (wd, ht, y0, seg = 10) => {
  const r = wd / 2, pts = [[-r, y0], [r, y0]];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI;
    pts.push([Math.cos(t) * r, y0 + ht - r + Math.sin(t) * r]);
  }
  return pts;
};

// でこぼこの塊（だ円体を角張った面で）。o: 中心、r: [rx, ry, rz]、yaw: y 軸まわりの回転、colorAt(i): 面ごとの色
function blob(w, o, r, yaw, seg, rings, colorAt) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (i, j) => {
    const ph = (j / rings) * Math.PI, th = (i / seg) * Math.PI * 2;
    const lx = Math.sin(ph) * Math.cos(th) * r[0], ly = Math.cos(ph) * r[1], lz = Math.sin(ph) * Math.sin(th) * r[2];
    return [o[0] + lx * c - lz * s, o[1] + ly, o[2] + lx * s + lz * c];
  };
  let f = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
      const m = [(a[0] + cc[0]) / 2 - o[0], (a[1] + cc[1]) / 2 - o[1], (a[2] + cc[2]) / 2 - o[2]];
      const l = Math.hypot(...m) || 1;
      const n = [m[0] / l, m[1] / l, m[2] / l];
      const cl = colorAt(f++);
      if (j === 0) w.tri(a, cc, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
      else if (j === rings - 1) w.tri(a, b, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
      else w.quad(a, b, cc, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
    }
  }
}

// ---- シャトー・ドー
// 利用者の写真（Street View 211021・29_163047303MP）: 14 角形の低いレンガの基壇（持ち送りの胸壁）、上に向かって細くなる
// オレンジがかったレンガの塔（直径約 7.5 → 6 m、白い帯はなく細いレンガの帯だけ、半円アーチの窓が縦に 3 つ）、
// レンガの持ち送りの上の淡い灰色の石の手すりの回廊、小さな四角い窓が輪に並ぶ上の細い円筒と、暗いスレートのドーム
const BRICK_CW = 1.5; // レンガの区画 1 枚の大きさ（m）
function writeChateau(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const rB = m.rBase, hB = 5, rT0 = 3.75, rT = 3.0, yT = y0 + 19, rU = 2.25, yU = y0 + 22, rD = 2.4;
  const STONE = col('#e4d8c4'), DARK = col('#2a2420'), IRON = col('#1b1b1c'), ROOF = col('#a39486');
  // レンガの区画に掛ける色。写真（Wikimedia Commons の昼の写真・利用者の写真 PXL_20201129）: 塔は赤みのあるオレンジのレンガ、
  // 基壇は塔より暗い焦げ茶のレンガ。回廊の手すりも白い石ではなくレンガ色、扉は暗い木の扉にレンガのアーチ
  const TOWER = col('#e2ab8c'), BASE = col('#b97a64'), GREY = col('#d59f84'), ARCH = col('#c98e74');
  const w = W.main;
  // 基壇（14 角形のレンガ）と、持ち送りの胸壁、平らな屋上
  const NB = 14;
  cylinder(w, x, z, rB, rB, y0 - 0.5, y0 + hB - 0.9, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BASE });
  cylinder(w, x, z, rB, rB + 0.3, y0 + hB - 0.9, y0 + hB - 0.6, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BASE });
  cylinder(w, x, z, rB + 0.3, rB + 0.3, y0 + hB - 0.6, y0 + hB, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BASE });
  annulus(w, x, z, rB + 0.12, rB + 0.3, y0 + hB, NB, col('#a8705c'));
  annulus(w, x, z, rT0, rB + 0.12, y0 + hB - 0.25, NB, ROOF);
  // 半円アーチの扉（北・南・西の 3 か所、白い石の枠）
  for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rB + 0.06), z + n[2] * (rB + 0.06)], s, archShape(3.1, 4.1, y0), n, ARCH);
    vpoly(w, [x + n[0] * (rB + 0.14), z + n[2] * (rB + 0.14)], s, archShape(2.3, 3.6, y0), n, DARK);
  }
  // 塔（上に向かって細くなるレンガの円筒）、細いレンガの帯、半円アーチの窓（縦に 3 つ、4 方向）
  cylinder(w, x, z, rT0, rT, y0 + hB - 0.3, yT - 1.1, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  const rAt = (y) => rT0 + ((rT - rT0) * (y - y0 - hB + 0.3)) / (yT - 1.1 - y0 - hB + 0.3);
  for (const yb of [y0 + hB + 4.6, y0 + hB + 9.4]) cylinder(w, x, z, rAt(yb) + 0.06, rAt(yb + 0.18) + 0.06, yb, yb + 0.18, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: col('#c99878') });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    for (const yw of [y0 + hB + 1.6, y0 + hB + 6.3, y0 + hB + 10.6]) {
      const r = rAt(yw + 0.8) + 0.05;
      vpoly(w, [x + n[0] * (r + 0.04), z + n[2] * (r + 0.04)], s, archShape(1.0, 2.0, yw - 0.1, 6), n, col('#c08a6a'));
      vpoly(w, [x + n[0] * (r + 0.08), z + n[2] * (r + 0.08)], s, archShape(0.7, 1.75, yw, 6), n, DARK);
    }
  }
  // レンガの持ち送り（上に広がる）と、張り出した回廊の床、淡い灰色の石の手すり（手すり子の影の縦の線）
  const rS = rT + 0.8;
  cylinder(w, x, z, rT, rS, yT - 1.1, yT - 0.45, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  cylinder(w, x, z, rS, rS, yT - 0.45, yT, { seg: 28, color: GREY });
  annulus(w, x, z, rU, rS, yT, 28, ROOF);
  const rR = rS - 0.1;
  cylinder(w, x, z, rR, rR, yT, yT + 0.95, { seg: 28, color: GREY });
  cylinder(w, x, z, rR - 0.2, rR - 0.2, yT, yT + 0.95, { seg: 28, color: GREY, inward: true });
  annulus(w, x, z, rR - 0.2, rR + 0.05, yT + 0.95, 28, col('#c99a82'));
  const nb = 56;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2;
    const p = [x + Math.cos(a) * (rR + 0.01), z + Math.sin(a) * (rR + 0.01)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, p, s, [[-0.05, yT + 0.18], [0.05, yT + 0.18], [0.05, yT + 0.8], [-0.05, yT + 0.8]], [Math.cos(a), 0, Math.sin(a)], col('#7a4a3a'));
  }
  // 上の細い円筒（小さな四角い窓が 8 つ）と石の軒、暗いスレートのドーム、小さな頂塔と風見
  const mt = W.metal;
  cylinder(w, x, z, rU, rU, yT, yU, { seg: 24, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  cylinder(w, x, z, rU + 0.15, rU + 0.15, yU - 0.35, yU, { seg: 24, color: STONE });
  annulus(w, x, z, rD, rU + 0.15, yU, 24, STONE);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rU + 0.04), z + n[2] * (rU + 0.04)], s, [[-0.28, yT + 1.4], [0.28, yT + 1.4], [0.28, yT + 2.2], [-0.28, yT + 2.2]], n, DARK);
  }
  const SLATE = col('#3c4450');
  for (let j = 0; j < 6; j++) {
    const p0 = (j / 6) * (Math.PI / 2), p1 = ((j + 1) / 6) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * rD, Math.max(0.3, Math.cos(p1) * rD), yU + Math.sin(p0) * rD * 0.9, yU + Math.sin(p1) * rD * 0.9, { seg: 20, color: SLATE });
  }
  const yL = yU + rD * 0.9;
  const ZINC = col('#5a626c');
  cylinder(mt, x, z, 0.32, 0.32, yL - 0.1, yL + 0.55, { seg: 8, color: ZINC });
  cylinder(mt, x, z, 0.42, 0.02, yL + 0.55, yL + 1.0, { seg: 8, color: ZINC });
  box(mt, [x, yL + 1.6, z], [0.03, 0, 0], [0, 0.65, 0], [0, 0, 0.03], IRON);
  box(mt, [x + 0.15, yL + 1.95, z], [0.55, 0, 0], [0, 0.05, 0], [0, 0, 0.012], IRON); // 風見の矢
  vpoly(mt, [x - 0.35, z], [1, 0], [[0, yL + 1.85], [-0.12, yL + 2.15], [-0.32, yL + 2.15], [-0.22, yL + 1.95]], [0, 0, 1], IRON);
  vpoly(mt, [x - 0.35, z], [1, 0], [[0, yL + 1.85], [-0.12, yL + 2.15], [-0.32, yL + 2.15], [-0.22, yL + 1.95]], [0, 0, -1], IRON);
  box(mt, [x, yL + 1.45, z], [0.35, 0, 0], [0, 0.02, 0], [0, 0, 0.02], IRON);
  box(mt, [x, yL + 1.45, z], [0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.35], IRON);
  // 基壇を囲む黒い鉄柵（道路の上には立てない）。当たり判定は全部立てば円 1 つ、すき間があれば立てた区間ごとの線分
  const rF = rB + 1.4;
  const nf = Math.round((2 * Math.PI * rF) / 0.16);
  const P = (k) => {
    const a = (k / nf) * Math.PI * 2;
    return [x + Math.cos(a) * rF, z + Math.sin(a) * rF];
  };
  const up = [];
  for (let k = 0; k < nf; k++) up.push(!onRoad(...P(k)));
  for (let k = 0; k < nf; k++) {
    if (!up[k]) continue;
    const a = (k / nf) * Math.PI * 2;
    const [px, pz] = P(k);
    const yg = groundAt(px, pz);
    const s = [-Math.sin(a), Math.cos(a)];
    for (const sg of [1, -1]) vpoly(mt, [px, pz], s, [[-0.018, yg], [0.018, yg], [0.018, yg + 1.35], [-0.018, yg + 1.35]], [Math.cos(a) * sg, 0, Math.sin(a) * sg], IRON);
    // 横の桟は次の次の柱まで（間の柱が道路で抜けていれば渡さない）
    if (k % 2 === 0 && up[(k + 1) % nf] && up[(k + 2) % nf]) {
      const [qx, qz] = P(k + 2);
      for (const yy of [yg + 0.12, yg + 1.22]) {
        for (const sg of [1, -1]) {
          mt.quad([px, yy, pz], [qx, yy, qz], [qx, yy + 0.05, qz], [px, yy + 0.05, pz], [Math.cos(a) * sg, 0, Math.sin(a) * sg], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON);
        }
      }
    }
  }
  for (const c of fenceColliders(x, z, rF, up)) colliders.push(c);
  keepOut.push([x, z, rF + 0.05]);
}

// 円い柵の当たり判定: 全部の柱が立てば円 [x, z, r]、抜けがあれば立った柱の続く区間を 8 本ごとの線分 [ax, az, bx, bz] にする
export function fenceColliders(x, z, r, up) {
  const n = up.length;
  if (up.every(Boolean)) return [[x, z, r + 0.05]];
  const P = (k) => [x + Math.cos((k / n) * Math.PI * 2) * r, z + Math.sin((k / n) * Math.PI * 2) * r];
  const out = [];
  const start = up.indexOf(false); // 抜けの所から回れば、区間が一周の境目で切れない
  if (start < 0) return out;
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 8) {
      const a = P(run[i]), b = P(run[Math.min(i + 8, run.length - 1)]);
      out.push([a[0], a[1], b[0], b[1]]);
    }
    run = [];
  };
  for (let j = 1; j <= n; j++) {
    const k = (start + j) % n;
    if (up[k]) run.push(k);
    else flush();
  }
  flush();
  return out;
}

// ---- スタディアム
function writeStadium(m, W, groundAt) {
  const { cx, cz, rays } = stadiumRays(m.outer, m.hole, 72);
  const y0 = groundAt(cx, cz);
  const H = Math.max(17, Math.min(24, m.height + 6)); // 外壁の高さ（IGN の高さは屋根の縁より低め）
  const ySeat = y0 + H - 4, yRoofO = y0 + H + 0.4, yRoofI = y0 + H + 2.6;
  const n = rays.length;
  const P = (i, f, y) => {
    const r = rays[i % n];
    const d = r.rin + (r.rout - r.rin) * f;
    return [cx + r.dx * d, y, cz + r.dz * d];
  };
  const PO = (i, extra, y) => {
    const r = rays[i % n];
    return [cx + r.dx * (r.rout + extra), y, cz + r.dz * (r.rout + extra)];
  };
  const w = W.main, mt = W.metal;
  const GREY = col('#b9b6af'), WALLIN = col('#8f8c86'), ROOFTOP = col('#d7d8d6'), ROOFBOT = col('#6d6f73'), FASCIA = col('#f1f1ee');
  const FSEAT = 0.84; // 観客席の上端（内側から外壁までの割合）
  for (let i = 0; i < n; i++) {
    const r0 = rays[i], r1 = rays[(i + 1) % n];
    const am = Math.atan2(r0.dz + r1.dz, r0.dx + r1.dx);
    const out = [Math.cos(am), 0, Math.sin(am)], inn = [-out[0], 0, -out[2]];
    // 外壁（白いパネル）
    wall(w, [PO(i, 0, 0)[0], PO(i, 0, 0)[2]], [PO(i + 1, 0, 0)[0], PO(i + 1, 0, 0)[2]], y0 - 0.3, yRoofO, out, CELL.cladding, 8, yRoofO - y0 + 0.3);
    // ピッチ側の低い壁
    const a = P(i, 0, 0), b = P(i + 1, 0, 0);
    w.quad([a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y0 + 1.2, b[2]], [a[0], y0 + 1.2, a[2]], inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, GREY);
    // すり鉢の観客席（区画 1 枚 ≒ 5 m）
    const slope = Math.hypot((r0.rout - r0.rin) * FSEAT, ySeat - y0);
    const ns = Math.max(1, Math.round(slope / 5));
    const segL = Math.hypot(P(i + 1, FSEAT, 0)[0] - P(i, FSEAT, 0)[0], P(i + 1, FSEAT, 0)[2] - P(i, FSEAT, 0)[2]);
    const nu = Math.max(1, Math.round(segL / 5));
    const rise = (ySeat - y0 - 1.2) / Math.max(1, (r0.rout - r0.rin) * FSEAT);
    const sn = [inn[0] * rise, 1, inn[2] * rise], sl = Math.hypot(...sn);
    for (let j = 0; j < ns; j++) {
      const f0 = (FSEAT * j) / ns, f1 = (FSEAT * (j + 1)) / ns;
      const ya = y0 + 1.2 + ((ySeat - y0 - 1.2) * j) / ns, yb = y0 + 1.2 + ((ySeat - y0 - 1.2) * (j + 1)) / ns;
      for (let k = 0; k < nu; k++) {
        const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
        const A = lerp(P(i, f0, ya), P(i + 1, f0, ya), k / nu), B = lerp(P(i, f0, ya), P(i + 1, f0, ya), (k + 1) / nu);
        const C = lerp(P(i, f1, yb), P(i + 1, f1, yb), (k + 1) / nu), D = lerp(P(i, f1, yb), P(i + 1, f1, yb), k / nu);
        w.quad(A, B, C, D, [sn[0] / sl, sn[1] / sl, sn[2] / sl], [cu(CELL.seats, 0), 0], [cu(CELL.seats, 1), 0], [cu(CELL.seats, 1), 1], [cu(CELL.seats, 0), 1]);
      }
    }
    // 観客席の上の奥の壁（屋根の下）
    const c0 = P(i, FSEAT, 0), c1 = P(i + 1, FSEAT, 0);
    w.quad([c0[0], ySeat, c0[2]], [c1[0], ySeat, c1[2]], [c1[0], yRoofO - 0.2, c1[2]], [c0[0], yRoofO - 0.2, c0[2]], inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, WALLIN);
    // 屋根（外壁から内側へ少し上がる）。上面と下面、内側の縁の白い鉄骨の帯
    const o0 = PO(i, 0.8, yRoofO), o1 = PO(i + 1, 0.8, yRoofO), i0 = P(i, 0.1, yRoofI), i1 = P(i + 1, 0.1, yRoofI);
    const rl = Math.hypot(r0.rout + 0.8 - (r0.rin + (r0.rout - r0.rin) * 0.1), yRoofI - yRoofO);
    const up = [(out[0] * (yRoofI - yRoofO)) / rl, (r0.rout - r0.rin) / rl, (out[2] * (yRoofI - yRoofO)) / rl];
    mt.quad(o0, o1, i1, i0, up, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFTOP);
    mt.quad(o0, o1, i1, i0, [-up[0], -up[1], -up[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFBOT);
    mt.quad([i0[0], yRoofI - 1.4, i0[2]], [i1[0], yRoofI - 1.4, i1[2]], i1, i0, inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, FASCIA);
    mt.quad([o0[0], yRoofO - 0.5, o0[2]], [o1[0], yRoofO - 0.5, o1[2]], o1, o0, out, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, FASCIA);
  }
  // 外壁に食い込んだ角の塔: 同じ白い外壁のパネルで、外壁より少し高く
  for (const ring of m.annex || []) {
    const yt = yRoofO + 1.2;
    const ccw = signedArea(ring) > 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L2 < 0.05) continue;
      let nx = (b[1] - a[1]) / L2, nz = -(b[0] - a[0]) / L2;
      if (!ccw) [nx, nz] = [-nx, -nz];
      const [p, q] = ccw ? [a, b] : [b, a];
      wall(w, p, q, y0 - 0.3, yt, [nx, 0, nz], CELL.cladding, 8, yt - y0 + 0.3);
    }
    const { points, indices } = triangulate(ring, []);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      w.tri([a[0], yt, a[1]], [b[0], yt, b[1]], [c[0], yt, c[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFTOP);
    }
  }
  // ピッチ（縞の芝と白線）と、まわりの芝
  const ring = rays.map((r) => [cx + r.dx * r.rin, cz + r.dz * r.rin]);
  const { points, indices } = triangulate(ring, []);
  const APRON = col('#5f8a48');
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
    w.tri([a[0], y0 + 0.06, a[1]], [b[0], y0 + 0.06, b[1]], [c[0], y0 + 0.06, c[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, APRON);
  }
  const box2 = orientedBox(m.outer);
  const e1 = box2.e1, e2 = box2.e2;
  let hx = Infinity, hz = Infinity;
  for (const r of rays) {
    const p1 = Math.abs(r.dx * e1[0] + r.dz * e1[1]), p2 = Math.abs(r.dx * e2[0] + r.dz * e2[1]);
    if (p1 > 0.7) hx = Math.min(hx, r.rin * p1);
    if (p2 > 0.7) hz = Math.min(hz, r.rin * p2);
  }
  const L = Math.min(52.5, hx - 4), Wd = Math.min(34, hz - 3);
  if (L > 20 && Wd > 15) {
    const Q = (s, t) => [cx + e1[0] * s + e2[0] * t, y0 + 0.12, cz + e1[1] * s + e2[1] * t];
    w.quad(Q(-L, -Wd), Q(L, -Wd), Q(L, Wd), Q(-L, Wd), [0, 1, 0], [cu(CELL.pitch, 0), 0], [cu(CELL.pitch, 1), 0], [cu(CELL.pitch, 1), 1], [cu(CELL.pitch, 0), 1]);
  }
  // 照明塔（4 隅、屋根の上に高く。鉄骨の柱と、ピッチを向いた灯具）
  const STEEL = col('#9da3a8'), LAMP = col('#fbf7e4'), FRAME = col('#4a4e52');
  for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let dx = e1[0] * s1 * box2.a + e2[0] * s2 * box2.b, dz = e1[1] * s1 * box2.a + e2[1] * s2 * box2.b;
    const dl = Math.hypot(dx, dz);
    dx /= dl;
    dz /= dl;
    const rout = rayRing(cx, cz, dx, dz, m.outer);
    let rin = m.hole && m.hole.length >= 3 ? rayRing(cx, cz, dx, dz, m.hole) : rout * 0.62;
    if (!(rin > 0) || rin > rout - 6) rin = rout * 0.62;
    const rr = rout - 5;
    const px = cx + dx * rr, pz = cz + dz * rr;
    // 柱の根元は屋根の上面（屋根は外壁の縁 yRoofO から内側の縁 yRoofI へ上がる）。屋根を突き抜けて観客席の上に浮かないように
    const ri = rin + (rout - rin) * 0.1;
    const yBase = yRoofO + ((yRoofI - yRoofO) * (rout + 0.8 - rr)) / Math.max(1, rout + 0.8 - ri) - 0.05;
    const top = y0 + H + 22;
    // 先細りの四角い柱
    for (let k = 0; k < 4; k++) {
      const a0 = (k / 4) * Math.PI * 2 + Math.PI / 4, a1 = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
      const am = (a0 + a1) / 2;
      const Pp = (a, r, y) => [px + Math.cos(a) * r, y, pz + Math.sin(a) * r];
      mt.quad(Pp(a0, 1.1, yBase), Pp(a1, 1.1, yBase), Pp(a1, 0.5, top), Pp(a0, 0.5, top), [Math.cos(am), 0.02, Math.sin(am)], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
    }
    // 灯具: ピッチの中心を向き、少し下に傾けた板
    const fx = -dx, fz = -dz;
    const sx = -fz, sz = fx;
    const tilt = 0.45;
    const o = [px + fx * 0.6, top + 1.6, pz + fz * 0.6];
    const ex = [sx * 4, 0, sz * 4], ey = [-fx * Math.sin(tilt) * 2.2, Math.cos(tilt) * 2.2, -fz * Math.sin(tilt) * 2.2], ez = [fx * Math.cos(tilt) * 0.35, Math.sin(tilt) * 0.35, fz * Math.cos(tilt) * 0.35];
    box(mt, o, ex, ey, ez, FRAME);
    const f = [o[0] + ez[0] * 1.05, o[1] + ez[1] * 1.05, o[2] + ez[2] * 1.05];
    const V = (a, b) => [f[0] + ex[0] * a + ey[0] * b, f[1] + ex[1] * a + ey[1] * b, f[2] + ex[2] * a + ey[2] * b];
    const nl = Math.hypot(...ez);
    mt.quad(V(-0.92, -0.85), V(0.92, -0.85), V(0.92, 0.85), V(-0.92, 0.85), [ez[0] / nl, ez[1] / nl, ez[2] / nl], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, LAMP);
  }
}

// ---- メディアテーク・ジョゼ・カバニス
function writeCabanis(m, W, groundAt) {
  const L = m.layout;
  const { e1, e2, a: A, b: B, m0, m1, front } = L;
  const y0 = groundAt(L.cx, L.cz);
  const H = m.height, FL = H / Math.max(1, Math.round(H / 4.2)); // 階の高さ（ルーバーの区画 1 枚）
  // 開口の上端: 利用者の写真 212520・NCM_0101 では高さの約 2/3（階の帯にそろえる）
  const Ho = y0 + Math.min(H - 2 * FL, Math.max(12, Math.round((0.65 * H) / FL) * FL));
  const Y = y0 + H;
  const at = (u, v) => [L.cx + e1[0] * u + e2[0] * v, L.cz + e1[1] * u + e2[1] * v];
  const n3 = (v2, s = 1) => [v2[0] * s, 0, v2[1] * s];
  const w = W.main, mt = W.metal;
  // 写真: ルーバーは暗いえんじ色がかった茶（#7a4a40 前後。テクスチャのテラコッタ色に掛ける）、開口の天井と奥は暗い
  const GLASS = col('#8a8480'), SOFFIT = col('#3a3230'), ROOF = col('#9b9a96'), LOUVRE = col('#c49a90'), TOPGLASS = col('#4a5a62');
  // 正面と裏（開口の部分は上の梁だけ）
  for (const sv of [1, -1]) {
    const v = sv * B, n = n3(e2, sv);
    const seg = (u0, u1, ya, yb) => {
      const p = sv > 0 ? [at(u1, v), at(u0, v)] : [at(u0, v), at(u1, v)];
      wall(w, p[0], p[1], ya, yb, n, CELL.louvre, FL, FL, LOUVRE);
    };
    seg(-A, m0, y0, Y);
    seg(m1, A, y0, Y);
    seg(m0, m1, Ho, Y);
  }
  // 両脇
  for (const su of [1, -1]) {
    const u = su * A;
    wall(w, at(u, su > 0 ? -B : B), at(u, su > 0 ? B : -B), y0, Y, n3(e1, su), CELL.louvre, FL, FL, LOUVRE);
  }
  // いちばん上の階は全面ガラス（庇の下の暗い緑がかった灰色の帯。壁の少し外に貼る）
  const g = 0.06;
  for (const [p, q, n] of [[at(-A - g, -B - g), at(A + g, -B - g), n3(e2, -1)], [at(A + g, B + g), at(-A - g, B + g), n3(e2, 1)], [at(A + g, -B - g), at(A + g, B + g), n3(e1, 1)], [at(-A - g, B + g), at(-A - g, -B - g), n3(e1, -1)]]) {
    w.quad([p[0], Y - FL, p[1]], [q[0], Y - FL, q[1]], [q[0], Y - 0.3, q[1]], [p[0], Y - 0.3, p[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TOPGLASS);
  }
  // 開口の内側の壁（ガラスとルーバー）と天井
  wall(w, at(m0, -B), at(m0, B), y0, Ho, n3(e1, 1), CELL.louvre, FL, FL, GLASS);
  wall(w, at(m1, B), at(m1, -B), y0, Ho, n3(e1, -1), CELL.louvre, FL, FL, GLASS);
  const S = (u, v, y) => {
    const p = at(u, v);
    return [p[0], y, p[1]];
  };
  w.quad(S(m0, -B, Ho), S(m1, -B, Ho), S(m1, B, Ho), S(m0, B, Ho), [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SOFFIT);
  // 屋上
  w.quad(S(-A, -B, Y), S(A, -B, Y), S(A, B, Y), S(-A, B, Y), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
  // 屋上の大きく張り出したガラスと鉄骨の庇（正面の側）。ガラスの板ごとに少し色を変える
  const vb = front * (B - 7), vf = front * (B + 11), ya = Y + 0.8, yb = Y + 1.5;
  // 下から見上げるとガラス越しの空で明るい（暗い板に見えないように明るめの灰色）
  const GL = [col('#b4cbd5'), col('#bdd2db'), col('#a9c2cd')], STEEL = col('#c9ccd0'), UNDER = col('#c4cacf');
  const nu = Math.max(4, Math.round((2 * A + 2) / 3.2)), nv = 6;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u0 = -A - 1 + ((2 * A + 2) * i) / nu, u1 = -A - 1 + ((2 * A + 2) * (i + 1)) / nu;
      const v0 = vb + ((vf - vb) * j) / nv, v1 = vb + ((vf - vb) * (j + 1)) / nv;
      const g = GL[Math.floor(hash01(i * 31 + j, 7) * GL.length)];
      w.quad(S(u0 + 0.08, v0 + 0.08, yb), S(u1 - 0.08, v0 + 0.08, yb), S(u1 - 0.08, v1 - 0.08, yb), S(u0 + 0.08, v1 - 0.08, yb), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, g); // ガラスは金属にしない（上から暗い板に見えないように）
    }
  }
  // 鉄骨の枠（上面の格子は板のすき間から下の面が見える）、下面、縁
  mt.quad(S(-A - 1, vb, yb - 0.04), S(A + 1, vb, yb - 0.04), S(A + 1, vf, yb - 0.04), S(-A - 1, vf, yb - 0.04), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
  mt.quad(S(-A - 1, vb, ya), S(A + 1, vb, ya), S(A + 1, vf, ya), S(-A - 1, vf, ya), [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, UNDER);
  const edge = (p, q, n) => mt.quad([p[0], ya, p[1]], [q[0], ya, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
  edge(at(-A - 1, vf), at(A + 1, vf), n3(e2, front));
  edge(at(-A - 1, vb), at(A + 1, vb), n3(e2, -front));
  edge(at(-A - 1, vb), at(-A - 1, vf), n3(e1, -1));
  edge(at(A + 1, vb), at(A + 1, vf), n3(e1, 1));
  // 庇を支える細い柱（屋上から）
  for (const u of [-A + 2, (m0 + m1) / 2, A - 2]) {
    const p = at(u, front * (B - 1));
    box(mt, [p[0], (Y + ya) / 2, p[1]], [0.18, 0, 0], [0, (ya - Y) / 2 + 0.02, 0], [0, 0, 0.18], STEEL);
  }
}

// ---- 雄鶏の像（ローカル座標: x が前、y が上。angle の向きに回して置く）
function writeCoq(m, W, groundAt, colliders, onRoad, keepOut) {
  const y0 = groundAt(m.x, m.z);
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  // 台の上（y = 0.55）から上の像は K 倍（写真: 台の上で約 3 m）
  const K = 1.1, YB = 0.55;
  const T = (lx, ly, lz) => {
    const k = ly > YB ? K : 1;
    const X = lx * k, Z = lz * k, Yy = ly > YB ? YB + (ly - YB) * K : ly;
    return [m.x + X * c - Z * s, y0 + Yy, m.z + X * s + Z * c];
  };
  const V = (lx, ly, lz) => [lx * c - lz * s, ly, lx * s + lz * c];
  const VK = (lx, ly, lz) => V(lx * K, ly * K, lz * K);
  const w = W.main;
  // 赤い木の台（上面は黒い板）
  const RED = col('#a5332b'), BLACK = col('#1b1918');
  box(w, [m.x, y0 + 0.25, m.z], V(1.25, 0, 0), [0, 0.25, 0], V(0, 0, 1.25), RED, { top: BLACK });
  box(w, [m.x, y0 + 0.52, m.z], V(1.28, 0, 0), [0, 0.025, 0], V(0, 0, 1.28), BLACK);
  // 錆びた鉄（蹄鉄のつぎはぎ）: 面ごとに色を少し変える
  const IRON = [col('#2f2723'), col('#4a372b'), col('#64412b'), col('#7a4e30'), col('#3a2f2a'), col('#563826')];
  let seed = 0;
  const rust = (salt) => (f) => IRON[Math.floor(hash01(f + salt * 997, 13) * IRON.length)];
  const B = (lx, ly, lz, r, salt, seg = 10, rings = 7) => blob(w, T(lx, ly, lz), r.map((v) => v * K), -m.angle, seg, rings, rust(salt));
  B(-0.08, 1.72, 0, [0.82, 0.52, 0.42], seed++); // 胴
  B(0.42, 1.88, 0, [0.4, 0.5, 0.36], seed++); // 胸
  B(0.62, 2.38, 0, [0.21, 0.42, 0.2], seed++, 8, 6); // 首
  B(0.74, 2.82, 0, [0.21, 0.18, 0.15], seed++, 8, 5); // 頭
  // 翼（胴の両脇の平たい塊）
  for (const sz of [1, -1]) blob(w, T(-0.15, 1.78, sz * 0.36), [0.62 * K, 0.32 * K, 0.1 * K], -m.angle - sz * 0.08, 8, 5, rust(seed++));
  // くちばし
  const beak = [T(0.92, 2.86, 0), T(0.92, 2.74, 0.06), T(0.92, 2.74, -0.06), T(1.16, 2.76, 0)];
  const nb = V(1, 0, 0);
  w.tri(beak[0], beak[1], beak[3], [nb[0], 0.3, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[0]);
  w.tri(beak[0], beak[2], beak[3], [nb[0], 0.3, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[0]);
  w.tri(beak[1], beak[2], beak[3], [nb[0], -0.5, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[1]);
  // 平たい板（ローカルの x-y 面、厚み 2·th）: とさか・肉垂れ・尾羽
  const plate = (pts, th, color) => {
    for (const sz of [1, -1]) {
      const n = V(0, 0, sz);
      for (let i = 1; i + 1 < pts.length; i++) {
        const [p, q, r] = [pts[0], pts[i], pts[i + 1]];
        w.tri(T(p[0], p[1], p[2] + sz * th), T(q[0], q[1], q[2] + sz * th), T(r[0], r[1], r[2] + sz * th), n, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
      }
    }
  };
  plate([[0.74, 2.94, 0], [0.56, 2.98, 0], [0.6, 3.16, 0], [0.67, 3.03, 0], [0.73, 3.24, 0], [0.8, 3.05, 0], [0.88, 3.17, 0], [0.9, 2.95, 0]], 0.035, IRON[2]);
  plate([[0.86, 2.7, 0], [0.84, 2.5, 0], [0.92, 2.56, 0], [0.94, 2.7, 0]], 0.03, IRON[3]);
  // 尾羽: 胴の後ろから弧を描いて立ち上がり、後ろへ垂れる鎌形の羽 7 枚
  for (let k = 0; k < 7; k++) {
    const h = 0.55 + 0.11 * k, len = 0.75 + 0.07 * k, wd = 0.13 + 0.01 * k, lz = (k % 2 ? 1 : -1) * 0.05 * ((k + 1) >> 1);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push([-0.72 - len * t, 1.95 + h * 1.25 * Math.sin(t * Math.PI * 0.78), lz]);
    }
    for (let i = 0; i < 8; i++) {
      const p = pts[i], q = pts[i + 1];
      const dx = q[0] - p[0], dy = q[1] - p[1], dl = Math.hypot(dx, dy);
      const ox = (-dy / dl) * wd * (1 - (i / 8) * 0.6), oy = (dx / dl) * wd * (1 - (i / 8) * 0.6);
      const ox2 = (-dy / dl) * wd * (1 - ((i + 1) / 8) * 0.6), oy2 = (dx / dl) * wd * (1 - ((i + 1) / 8) * 0.6);
      plate([[p[0] - ox / 2, p[1] - oy / 2, lz], [q[0] - ox2 / 2, q[1] - oy2 / 2, lz], [q[0] + ox2 / 2, q[1] + oy2 / 2, lz], [p[0] + ox / 2, p[1] + oy / 2, lz]], 0.02, IRON[(k + i) % IRON.length]);
    }
  }
  // 脚と指
  for (const sz of [1, -1]) {
    const top = T(0.02, 1.3, sz * 0.16), bot = T(0.08, 0.56, sz * 0.18);
    const mid = [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2];
    const half = [(top[0] - bot[0]) / 2, (top[1] - bot[1]) / 2, (top[2] - bot[2]) / 2];
    box(w, mid, VK(0.05, 0, 0), half, VK(0, 0, 0.05), IRON[1]);
    for (const a of [-0.5, 0, 0.5, Math.PI]) {
      const d = VK(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14);
      box(w, [bot[0] + d[0], y0 + 0.57, bot[2] + d[2]], d, [0, 0.025, 0], VK(-Math.sin(a) * 0.03, 0, Math.cos(a) * 0.03), IRON[0]);
    }
  }
  // 足元のラグビーボール
  blob(w, T(0.72, 0.76, 0.34), [0.3 * K, 0.19 * K, 0.19 * K], -m.angle + 0.5, 10, 6, () => col('#5b3b28'));
  colliders.push([m.x, m.z, 1.8]);
  keepOut.push([m.x, m.z, 1.8]);
}

// ---- オクシタン十字と星座のメダル（ブロンズの象嵌）
// 12 の星座の記号（-1〜1 の折れ線）。牡羊座から順に
const circ = (x, y, r, a0 = 0, a1 = Math.PI * 2, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x + Math.cos(a0 + ((a1 - a0) * i) / n) * r, y + Math.sin(a0 + ((a1 - a0) * i) / n) * r]);
export const ZODIAC = [
  [[[-0.7, 0.2], [-0.7, 0.55], [-0.4, 0.7], [-0.12, 0.45], [0, -0.75]], [[0.7, 0.2], [0.7, 0.55], [0.4, 0.7], [0.12, 0.45], [0, -0.75]]],
  [circ(0, -0.3, 0.38), circ(0, 0.5, 0.62, Math.PI * 1.1, Math.PI * 1.9, 8)],
  [[[-0.6, 0.7], [0.6, 0.7]], [[-0.6, -0.7], [0.6, -0.7]], [[-0.3, 0.7], [-0.3, -0.7]], [[0.3, 0.7], [0.3, -0.7]]],
  [circ(-0.35, 0.22, 0.2), [[-0.35, 0.42], [0.2, 0.5], [0.6, 0.25]], circ(0.35, -0.22, 0.2), [[0.35, -0.42], [-0.2, -0.5], [-0.6, -0.25]]],
  [circ(-0.4, -0.3, 0.22), [[-0.2, -0.25], [-0.25, 0.3], [0.05, 0.65], [0.4, 0.4], [0.3, -0.3], [0.55, -0.6], [0.75, -0.45]]],
  [[[-0.7, 0.5], [-0.7, -0.6]], [[-0.7, 0.4], [-0.45, 0.6], [-0.25, 0.4], [-0.25, -0.6]], [[-0.25, 0.4], [0, 0.6], [0.2, 0.4], [0.2, -0.4], [0.5, -0.7]], [[0.2, -0.1], [0.6, 0.1], [0.55, -0.3], [0.2, -0.4]]],
  [[[-0.75, -0.55], [0.75, -0.55]], [[-0.75, -0.15], [-0.3, -0.15], ...circ(0, 0.1, 0.3, Math.PI * 1.15, -Math.PI * 0.15, 8).slice(1, -1), [0.3, -0.15], [0.75, -0.15]]],
  [[[-0.75, 0.5], [-0.75, -0.6]], [[-0.75, 0.4], [-0.5, 0.6], [-0.3, 0.4], [-0.3, -0.6]], [[-0.3, 0.4], [-0.05, 0.6], [0.15, 0.4], [0.15, -0.55], [0.45, -0.6], [0.7, -0.3]], [[0.5, -0.15], [0.7, -0.3], [0.55, -0.5]]],
  [[[-0.65, -0.65], [0.65, 0.65]], [[0.15, 0.65], [0.65, 0.65], [0.65, 0.15]], [[-0.45, 0.05], [0.05, -0.45]]],
  [[[-0.7, 0.6], [-0.4, -0.3], [-0.15, 0.55], [0.15, -0.55], [0.35, -0.75]], circ(0.4, -0.35, 0.25, Math.PI * 0.9, Math.PI * 2.9, 10)],
  [[[-0.75, 0.15], [-0.45, 0.4], [-0.15, 0.15], [0.15, 0.4], [0.45, 0.15], [0.75, 0.4]], [[-0.75, -0.35], [-0.45, -0.1], [-0.15, -0.35], [0.15, -0.1], [0.45, -0.35], [0.75, -0.1]]],
  [circ(-0.95, 0, 0.7, -Math.PI * 0.35, Math.PI * 0.35, 8), circ(0.95, 0, 0.7, Math.PI * 0.65, Math.PI * 1.35, 8), [[-0.4, 0], [0.4, 0]]],
];
function writeCross(m, W, groundAt) {
  const R = m.radius;
  const { ring, pommels } = occitanCross(R);
  const ax = m.ax, az = [-ax[1], ax[0]];
  const toW = ([u, v]) => [m.x + ax[0] * u + az[0] * v, m.z + ax[1] * u + az[1] * v];
  const w = W.inlay;
  const LINE = col('#b39368'), MEDAL = col('#8c8070'), RIM = col('#a8875a'); // 写真: 日なたの線 #b1987f、メダル #8a7e6f
  const flat = (q, lift, color) => {
    const P = q.map((p) => {
      const [x, z] = toW(p);
      return [x, groundAt(x, z) + lift, z];
    });
    w.quad(P[0], P[1], P[2], P[3], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  };
  const MR = 1.3; // メダルの半径
  const inMedal = (p) => pommels.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < MR + 0.05);
  // 二重のブロンズの線（メダルの上は描かない）
  for (const off of [-0.2, 0.2]) {
    for (const q of strokeQuads(ring, true, off, 0.11)) {
      const mid = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
      if (!inMedal(mid)) flat(q, 0.035, LINE);
    }
  }
  // メダル（暗いブロンズの円盤、明るい縁、星座の記号。記号は十字の外を向いて読める向き）
  pommels.forEach((p, k) => {
    const n = 24;
    const disc = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      disc.push([p, [p[0] + Math.cos(a0) * MR, p[1] + Math.sin(a0) * MR], [p[0] + Math.cos(a1) * MR, p[1] + Math.sin(a1) * MR], p]);
    }
    for (const q of disc) flat(q, 0.025, MEDAL);
    const rimPts = circ(p[0], p[1], MR - 0.08, 0, Math.PI * 2, n).slice(0, -1);
    for (const q of strokeQuads(rimPts, true, 0, 0.12)) flat(q, 0.035, RIM);
    const out = Math.hypot(p[0], p[1]) || 1;
    const up = [p[0] / out, p[1] / out], right = [up[1], -up[0]];
    const g = 0.72;
    for (const line of ZODIAC[k % 12]) {
      const pts = line.map(([gx, gy]) => [p[0] + (right[0] * gx + up[0] * gy) * g, p[1] + (right[1] * gx + up[1] * gy) * g]);
      for (const q of strokeQuads(pts, false, 0, 0.09)) flat(q, 0.04, RIM);
    }
  });
}

// ---- ファストフード店（Route de Bayonne のマクドナルド）
// 黄色の M（2 つのアーチ。幅 2w・高さ h、中心 (0, 0) から下へ）の線
function archM(w, h) {
  const arch = (cx) => Array.from({ length: 13 }, (_, i) => {
    const t = i / 12, a = Math.PI * t;
    return [cx - Math.cos(a) * (w / 2), -h + Math.sin(a) ** 0.7 * h * (1 - 0.45 * Math.sin(a) ** 8)];
  });
  return [...arch(-w / 2), ...arch(w / 2).slice(1)];
}
function writeFastfood(m, W, groundAt, colliders) {
  // ユーザーのストリートビュー（22 Rte de Bayonne、2025 年 8 月）: 平屋。床から 3 m は大きなガラスの店先（横・裏は淡い黄土色の壁）、
  // その上に外へ傾いたオレンジ色の縦の羽板の帯（白い店名）、帯の上に濃い緑の寄棟の屋根。道端の看板塔は濃い緑の板に黄色の M、下に赤い板
  const w = W.main, ring = m.outer;
  const [cx, cz] = centroid(ring);
  const y0 = groundAt(cx, cz) - 0.05, G = y0 + 3, F = y0 + 4.4, R = y0 + 5.8;
  const GLASS = col('#2b3439'), FRAME = col('#3a3d3f'), WALL = col('#d8c79e'), SLAT = col('#c8652f'), SLAT_D = col('#93421f');
  const ROOF = col('#3e5a47'), SOFFIT = col('#2f3a33'), RED = col('#bd2a24'), GREEN = col('#2c5a3a'), YELLOW = col('#f7bf1a'), POLE = col('#6b6e72');
  const s = signedArea(ring) > 0 ? 1 : -1;
  const fx = m.front[0] - cx, fz = m.front[1] - cz, fl = Math.hypot(fx, fz) || 1;
  const OUT = 0.55; // 羽板の帯の上の縁の張り出し
  let sign = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.3) continue;
    // 外向きの法線。壁の面は外から見て反時計回り（a → b を外から見て左から右）
    const nx = ((b[1] - a[1]) / L) * s, nz = (-(b[0] - a[0]) / L) * s;
    const [p, q] = s > 0 ? [b, a] : [a, b];
    const n = [nx, 0, nz];
    const front = (nx * fx + nz * fz) / fl > 0.3 && L > 3;
    if (front) {
      // 店先: 足元の帯と大きなガラス（1.5 m ごとの細い枠）
      wall(w, p, q, y0, y0 + 0.3, n, CELL.plain, 1e9, 1e9, FRAME);
      wall(w, p, q, y0 + 0.3, G, n, CELL.plain, 1e9, 1e9, GLASS);
      const k = Math.max(1, Math.round(L / 1.5));
      for (let j = 0; j <= k; j++) {
        const t = j / k, x = p[0] + (q[0] - p[0]) * t + nx * 0.05, z = p[1] + (q[1] - p[1]) * t + nz * 0.05;
        box(w, [x, (y0 + G) / 2, z], [0.05, 0, 0], [0, (G - y0) / 2, 0], [0, 0, 0.05], FRAME);
      }
      if (!sign || L > sign.L) sign = { p, q, n, L };
    } else wall(w, p, q, y0, G, n, CELL.plain, 1e9, 1e9, WALL);
    // 外へ傾いたオレンジ色の羽板の帯（G → F、上の縁は OUT m 外）と、縦の羽板の影の線（0.4 m ごと）
    const P = (pt, y, o) => [pt[0] + nx * o, y, pt[1] + nz * o];
    const nn = [nx * 0.93, 0.37, nz * 0.93];
    w.quad(P(p, G, 0), P(q, G, 0), P(q, F, OUT), P(p, F, OUT), nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLAT);
    const ks = Math.floor(L / 0.4);
    for (let j = 1; j < ks; j++) {
      const t = j / ks, x0 = p[0] + (q[0] - p[0]) * t, z0 = p[1] + (q[1] - p[1]) * t, ux = ((q[0] - p[0]) / L) * 0.05, uz = ((q[1] - p[1]) / L) * 0.05;
      const A = [x0 - ux + nx * 0.02, G, z0 - uz + nz * 0.02], B = [x0 + ux + nx * 0.02, G, z0 + uz + nz * 0.02];
      const C = [x0 + ux + nx * (OUT + 0.02), F, z0 + uz + nz * (OUT + 0.02)], D = [x0 - ux + nx * (OUT + 0.02), F, z0 - uz + nz * (OUT + 0.02)];
      w.quad(A, B, C, D, nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLAT_D);
    }
  }
  // 濃い緑の寄棟の屋根: 羽板の帯の上の縁（外へ OUT m）から、外形を中心へ 0.45 倍に縮めた輪（R）まで。上は平ら。帯の上の軒裏
  const out = ring.map(([x, z], i) => {
    const pv = ring[(i - 1 + ring.length) % ring.length], nx2 = ring[(i + 1) % ring.length];
    let ex = 0, ez = 0;
    for (const [a, b] of [[pv, [x, z]], [[x, z], nx2]]) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      ex += ((b[1] - a[1]) / L) * s;
      ez += (-(b[0] - a[0]) / L) * s;
    }
    const l = Math.hypot(ex, ez) || 1;
    return [x + (ex / l) * OUT, z + (ez / l) * OUT];
  });
  const inner = ring.map(([x, z]) => [cx + (x - cx) * 0.45, cz + (z - cz) * 0.45]);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [A, B] = s > 0 ? [out[j], out[i]] : [out[i], out[j]], [C, D] = s > 0 ? [inner[i], inner[j]] : [inner[j], inner[i]];
    w.quad([A[0], F, A[1]], [B[0], F, B[1]], [C[0], R, C[1]], [D[0], R, D[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    const [E, H] = s > 0 ? [ring[j], ring[i]] : [ring[i], ring[j]];
    w.quad([B[0], F - 0.02, B[1]], [A[0], F - 0.02, A[1]], [E[0], F - 0.02, E[1]], [H[0], F - 0.02, H[1]], [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SOFFIT);
  }
  const tri = triangulate(inner);
  for (let i = 0; i < tri.indices.length; i += 3) {
    const P3 = [0, 1, 2].map((k) => tri.points[tri.indices[i + k]]);
    const [A, B, C] = (s > 0 ? [P3[0], P3[2], P3[1]] : P3).map((v) => [v[0], R, v[1]]);
    w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
  }
  // 黄色の M（2 つのアーチ）
  const letter = (o, ux, uz, nx, nz, size) => {
    const pts = archM(size / 2, size * 0.85);
    for (const q of strokeQuads(pts, false, 0, size * 0.065)) {
      const V = q.map(([u, v]) => [o[0] + ux * u + nx * 0.02, o[1] + v + size * 0.42, o[2] + uz * u + nz * 0.02]);
      w.quad(V[0], V[1], V[2], V[3], [nx, 0, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, YELLOW);
    }
  };
  if (sign) {
    // 羽板の帯の端に黄色の M（帯の上に白い店名があるが、文字は描かない）
    const { p, q, n, L } = sign, ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    const o = [p[0] + ux * 1.2 + n[0] * (OUT + 0.15), F - 0.95, p[1] + uz * 1.2 + n[2] * (OUT + 0.15)];
    letter(o, ux, uz, n[0], n[2], 1.1);
  }
  // 道端の看板塔（高さ約 8 m: 灰色の柱の上に濃い緑の板と黄色の M、その下に赤い板）
  {
    const [px, pz] = m.pylon, g = groundAt(px, pz), ux = -fz / fl, uz = fx / fl, ex = fx / fl, ez = fz / fl;
    box(w, [px, g + 2.4, pz], [ux * 0.25, 0, uz * 0.25], [0, 2.4, 0], [ex * 0.25, 0, ez * 0.25], POLE);
    box(w, [px, g + 5.6, pz], [ux * 0.95, 0, uz * 0.95], [0, 0.8, 0], [ex * 0.18, 0, ez * 0.18], RED);
    const top = g + 6.4 + 1.0;
    box(w, [px, top, pz], [ux * 0.95, 0, uz * 0.95], [0, 1.0, 0], [ex * 0.18, 0, ez * 0.18], GREEN);
    letter([px + ex * 0.19, top - 0.85, pz + ez * 0.19], ux, uz, ex, ez, 1.6);
    letter([px - ex * 0.19, top - 0.85, pz - ez * 0.19], -ux, -uz, -ex, -ez, 1.6);
    colliders.push([px, pz, 0.6]);
  }
  // 白い砂利の植え込みと、赤茶の木のチップの島（地面に貼る板）、砂利の上の淡い色の大きな石
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    const sg = signedArea(poly) > 0 ? 1 : -1;
    for (let i = 0; i < t.indices.length; i += 3) {
      const P3 = [0, 1, 2].map((k) => t.points[t.indices[i + k]]);
      const [A, B, C] = (sg > 0 ? [P3[0], P3[2], P3[1]] : P3).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  flat(m.gravel, 0.03, col('#ecebe6'));
  for (const [x, z, r] of m.mulch) flat(circ(x, z, r, 0, Math.PI * 2, 16).slice(0, -1), 0.045, col('#8a4a36'));
  const rnd = mulberry32(911);
  const gx = m.gravel.map((p) => p[0]), gz = m.gravel.map((p) => p[1]);
  for (let k = 0, placed = 0; k < 80 && placed < 9; k++) {
    const x = Math.min(...gx) + rnd() * (Math.max(...gx) - Math.min(...gx)), z = Math.min(...gz) + rnd() * (Math.max(...gz) - Math.min(...gz));
    if (!pointInRing(x, z, m.gravel) || m.mulch.some(([mx, mz, r]) => Math.hypot(x - mx, z - mz) < r)) continue;
    const a = rnd() * Math.PI, sx = 0.5 + rnd() * 0.4, sz = 0.4 + rnd() * 0.3, sy = 0.3 + rnd() * 0.25;
    box(w, [x, groundAt(x, z) + sy * 0.8, z], [Math.cos(a) * sx, 0, Math.sin(a) * sx], [0, sy, 0], [-Math.sin(a) * sz, 0, Math.cos(a) * sz], col(rnd() < 0.5 ? '#cfc8bc' : '#bdb5a8'));
    placed++;
  }
}

// ---- オテル・デューの中庭
function writeParterre(m, W, groundAt) {
  const w = W.main, HEDGE = col('#3c5a2b'), CLIP = [col('#41602f'), col('#3a5829'), col('#46653a')], TRUNK = col('#5a4a3c');
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  // 砂利の園路の面と芝の区画
  flat(m.outer, 0.03, col('#c9bca4'));
  flat(m.lawn, 0.05, col('#5f803a'));
  // 低いツゲ（高さ 0.5 m、幅 0.4 m）: 芝の区画の縁と、対角線、内側の菱形
  const hedge = (a, b, h = 0.5, wd = 0.4, color = HEDGE) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.2) return;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, g = Math.min(groundAt(...a), groundAt(...b));
    box(w, [(a[0] + b[0]) / 2, g + h / 2, (a[1] + b[1]) / 2], [ux * L / 2, 0, uz * L / 2], [0, h / 2, 0], [-uz * wd / 2, 0, ux * wd / 2], color);
  };
  const lw = m.lawn, n = lw.length;
  for (let i = 0; i < n; i++) hedge(lw[i], lw[(i + 1) % n]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ms = lw.map((a, i) => mid(a, lw[(i + 1) % n]));
  for (let i = 0; i < n; i++) hedge(ms[i], ms[(i + 1) % n]);
  hedge(lw[0], lw[2]);
  hedge(lw[1], lw[3]);
  // 外周の北の丸い所の低い生け垣（高さ 1 m）
  for (let i = 0; i < 4; i++) hedge(m.outer[i], m.outer[i + 1], 1.0, 0.8);
  // 左右の刈り込んだ四角い木の列（幹 2 m、四角い樹冠 3 × 3 × 3 m、3.6 m おき）
  for (const [a, b] of m.rows) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, k = Math.floor(L / 3.6);
    for (let j = 0; j <= k; j++) {
      const x = a[0] + ux * (L * j) / k, z = a[1] + uz * (L * j) / k, g = groundAt(x, z);
      box(w, [x, g + 1.1, z], [0.12, 0, 0], [0, 1.1, 0], [0, 0, 0.12], TRUNK);
      box(w, [x, g + 3.6, z], [ux * 1.55, 0, uz * 1.55], [0, 1.5, 0], [-uz * 1.5, 0, ux * 1.5], CLIP[j % CLIP.length]);
    }
  }
  // 北の端の丸い池（石の縁、水面、真ん中の小さな噴水の台）
  const [bx, bz] = m.basin, g = groundAt(bx, bz);
  const rim = circ(bx, bz, 3.6, 0, Math.PI * 2, 24).slice(0, -1);
  for (const q of strokeQuads(rim, true, 0, 0.45)) w.quad(...q.map(([x, z]) => [x, g + 0.45, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#cfc6b6'));
  for (let i = 0; i < rim.length; i++) {
    const p = rim[i], q = rim[(i + 1) % rim.length], nx = (p[0] + q[0]) / 2 - bx, nz = (p[1] + q[1]) / 2 - bz;
    const o = (pt) => [bx + (pt[0] - bx) * 1.06, bz + (pt[1] - bz) * 1.06];
    wall(w, o(q), o(p), g, g + 0.45, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#c4bba9'));
  }
  flat(circ(bx, bz, 3.4, 0, Math.PI * 2, 24).slice(0, -1), 0.35, col('#5b6d6a'));
  box(w, [bx, g + 0.6, bz], [0.35, 0, 0], [0, 0.6, 0], [0, 0, 0.35], col('#c4bba9'));
}

// ---- 日本庭園（Jardin japonais Pierre-Baudis）
// 楕円体（x, z 方向の半径 rx, rz、高さの半径 ry）。石・刈り込みの植木に使う
function ellipsoid(w, c, rx, ry, rz, color, seg = 8) {
  const P = (i, j) => {
    const th = (i / seg) * Math.PI * 2, ph = (j / (seg / 2)) * Math.PI - Math.PI / 2;
    return [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg / 2; j++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      const V = q.map(([x, y, z]) => [c[0] + x * rx, c[1] + y * ry, c[2] + z * rz]);
      const n = q.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]);
      w.quad(V[0], V[1], V[2], V[3], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  }
}
function writeJgarden(m, W, groundAt, colliders, onRoad, keepOut) {
  const w = W.main, rnd = mulberry32(1983);
  const GRAVEL = col('#b5b4b0'), RAKE = col('#8f8e8a'), WALL = col('#ebe4d3'), TILE = col('#55574f'), ROCK = [col('#8f8d88'), col('#a19e97'), col('#7f7d78')];
  const PINE = [col('#2e4a2a'), col('#35532f'), col('#2a4426')], TRUNK = col('#5a4636'), WOOD = col('#8d7f72'), RED = col('#d9432a'), STONE = col('#9a978f');
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  // 枯山水: 灰白色の砂利の面に、塀と平行に 0.5 m おきの波の砂紋（面の中だけ）と、石組みのまわりの同心円
  flat(m.gravel, 0.04, GRAVEL);
  const [w0, w1] = [m.wall[m.wall.length - 2], m.wall[m.wall.length - 1]];
  const L0 = Math.hypot(w1[0] - w0[0], w1[1] - w0[1]), ux = (w1[0] - w0[0]) / L0, uz = (w1[1] - w0[1]) / L0;
  const inG = (x, z) => pointInRing(x, z, m.gravel);
  const inRock = (x, z) => m.rocks.some(([rx, rz]) => Math.hypot(x - rx, z - rz) < 2.2);
  const [gx, gz] = centroid(m.gravel);
  for (let off = -30; off <= 30; off += 0.5) {
    let run = [];
    const flush = () => {
      if (run.length > 1) for (const q of strokeQuads(run, false, 0, 0.035)) W.inlay.quad(...q.map(([x, z]) => [x, groundAt(x, z) + 0.05, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, RAKE);
      run = [];
    };
    for (let t = -30; t <= 30; t += 0.6) {
      const wv = Math.sin(t * 0.9 + off) * 0.12, x = gx + ux * t - uz * (off + wv), z = gz + uz * t + ux * (off + wv);
      if (inG(x, z) && !inRock(x, z)) run.push([x, z]);
      else flush();
    }
    flush();
  }
  for (const [rx, rz] of m.rocks) {
    if (!inG(rx, rz)) continue;
    for (const r of [1.5, 2.0]) for (const q of strokeQuads(circ(rx, rz, r, 0, Math.PI * 2, 20).slice(0, -1), true, 0, 0.035)) W.inlay.quad(...q.map(([x, z]) => [x, groundAt(x, z) + 0.05, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, RAKE);
  }
  // 白い塀（高さ 2 m、厚さ 0.35 m）と、少し張り出した暗い瓦の笠
  for (let i = 0; i + 1 < m.wall.length; i++) {
    const a = m.wall[i], b = m.wall[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L, y0 = Math.min(groundAt(...a), groundAt(...b)) - 0.1, y1 = y0 + 2.1;
    const o = 0.175;
    for (const sd of [1, -1]) wall(w, [a[0] + nx * o * sd, a[1] + nz * o * sd], [b[0] + nx * o * sd, b[1] + nz * o * sd], y0, y1, [nx * sd, 0, nz * sd], CELL.plain, 1e9, 1e9, WALL);
    const mid = [(a[0] + b[0]) / 2, y1 + 0.12, (a[1] + b[1]) / 2], e = [((b[0] - a[0]) / 2) * 1.01, 0, ((b[1] - a[1]) / 2) * 1.01];
    box(w, mid, e, [0, 0.12, 0], [nx * 0.42, 0, nz * 0.42], TILE);
    colliders.push([a[0], a[1], b[0], b[1]]);
  }
  // 石組み: 丸い灰色の石（0.5〜1.4 m）を 2〜4 個ずつ
  for (const [rx, rz] of m.rocks) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const x = rx + (rnd() - 0.5) * 2, z = rz + (rnd() - 0.5) * 2, r = 0.35 + rnd() * 0.45;
      ellipsoid(w, [x, groundAt(x, z) + r * 0.35, z], r * (1 + rnd() * 0.5), r * 0.7, r, ROCK[k % ROCK.length], 8);
    }
  }
  // 玉作りの松: 細い幹に平たい葉の玉を 3〜4 段。低いもの（1.6 m 未満）は地面から丸く刈り込んだ植え込み
  for (const [px, pz, ph] of m.pines) {
    const g = groundAt(px, pz), h = ph || 2.2 + rnd() * 1.6;
    if (h < 1.6) {
      ellipsoid(w, [px, g + h * 0.45, pz], h * 0.75, h * 0.5, h * 0.7, PINE[1], 8);
      continue;
    }
    box(w, [px, g + h / 2, pz], [0.09, 0, 0], [0, h / 2, 0], [0, 0, 0.09], TRUNK);
    const n = 3 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) {
      const t = (k + 1) / n, a = rnd() * Math.PI * 2, d = (1 - t) * 0.8, r = 0.9 - t * 0.35 + rnd() * 0.3;
      ellipsoid(w, [px + Math.cos(a) * d, g + h * t + 0.1, pz + Math.sin(a) * d], r * 1.2, r * 0.45, r, PINE[k % PINE.length], 8);
    }
  }
  // 州浜（白い玉石）と石灯籠
  flat(m.spit, 0.05, col('#e8e6df'));
  {
    const [lx, lz] = m.lantern, g = groundAt(lx, lz);
    box(w, [lx, g + 0.15, lz], [0.4, 0, 0], [0, 0.15, 0], [0, 0, 0.4], STONE);
    box(w, [lx, g + 0.75, lz], [0.12, 0, 0], [0, 0.45, 0], [0, 0, 0.12], STONE);
    box(w, [lx, g + 1.35, lz], [0.3, 0, 0], [0, 0.18, 0], [0, 0, 0.3], col('#b2aea5'));
    box(w, [lx, g + 1.6, lz], [0.45, 0, 0], [0, 0.07, 0], [0, 0, 0.45], STONE);
    ellipsoid(w, [lx, g + 1.7, lz], 0.18, 0.15, 0.18, STONE, 6);
  }
  // 茶屋へ渡る木の縁台（0.4 m の高さ、手すり）
  {
    const t = triangulate(m.deck);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + 0.4, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, WOOD);
    }
    for (const [x, z] of m.deck) box(w, [x, groundAt(x, z) + 0.6, z], [0.06, 0, 0], [0, 0.6, 0], [0, 0, 0.06], col('#7a6a58'));
  }
  // 朱色の太鼓橋（長さ L、幅 1.8 m、中ほどの高さ 1.5 m）: 反った床と、低い欄干（柱と 2 本の横木）
  {
    const [A, B] = m.bridge, L = Math.hypot(B[0] - A[0], B[1] - A[1]), bx = (B[0] - A[0]) / L, bz = (B[1] - A[1]) / L, nx = -bz, nz = bx;
    const ga = groundAt(...A), gb = groundAt(...B), n = 14;
    const at = (t) => [A[0] + bx * L * t, ga + (gb - ga) * t + 1.5 * Math.sin(Math.PI * t), A[1] + bz * L * t];
    for (let k = 0; k < n; k++) {
      const p = at(k / n), q = at((k + 1) / n), c = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const e = [(q[0] - p[0]) / 2 * 1.05, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2 * 1.05];
      box(w, c, e, [0, 0.08, 0], [nx * 0.9, 0, nz * 0.9], RED, { top: col('#a86a4a') });
      for (const sd of [1, -1]) {
        for (const hh of [0.5, 0.9]) box(w, [c[0] + nx * 0.85 * sd, c[1] + hh, c[2] + nz * 0.85 * sd], e, [0, 0.04, 0], [nx * 0.05, 0, nz * 0.05], RED);
      }
    }
    for (let k = 0; k <= n; k += 2) {
      const p = at(k / n);
      for (const sd of [1, -1]) box(w, [p[0] + nx * 0.85 * sd, p[1] + 0.47, p[2] + nz * 0.85 * sd], [0.06, 0, 0], [0, 0.5, 0], [0, 0, 0.06], RED);
    }
    // 橋の下の支え（両端と中の 2 本の柱）
    for (const t of [0.3, 0.7]) {
      const p = at(t);
      for (const sd of [1, -1]) box(w, [p[0] + nx * 0.7 * sd, (p[1] + Math.min(ga, gb) - 1) / 2, p[2] + nz * 0.7 * sd], [0.08, 0, 0], [0, (p[1] - Math.min(ga, gb) + 1) / 2, 0], [0, 0, 0.08], RED);
    }
  }
  // 茶屋: 0.5 m の木の床、細い柱、腰の低い板壁と障子の帯、深い軒（0.9 m）の苔むした寄棟の屋根
  if (m.tea) {
    const ring = m.tea, [cx, cz] = centroid(ring), g = Math.min(...ring.map(([x, z]) => groundAt(x, z)));
    const y0 = g + 0.5, y1 = y0 + 2.5, ROOF = col('#4b5544'), POST = col('#4a3a2c'), SHOJI = col('#e9e2cf');
    const sgn = signedArea(ring) > 0 ? 1 : -1;
    const flr = triangulate(ring);
    for (let i = 0; i < flr.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => flr.points[flr.indices[i + k]]).map((v) => [v[0], y0, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#7a6450'));
    }
    const ext = ring.map(([x, z]) => {
      const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
      return [x + (dx / l) * 1.2, z + (dz / l) * 1.2];
    });
    const ridge = ring.map(([x, z]) => [cx + (x - cx) * 0.25, cz + (z - cz) * 0.25]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length, a = ring[i], b = ring[j], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.5) continue;
      const nx = ((b[1] - a[1]) / L) * sgn, nz = (-(b[0] - a[0]) / L) * sgn;
      wall(w, a, b, g - 0.2, y0, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#6e5a48'));
      wall(w, a, b, y0, y0 + 0.8, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#8a7058'));
      if (i % 2 === 0) wall(w, [a[0] - nx * 0.4, a[1] - nz * 0.4], [b[0] - nx * 0.4, b[1] - nz * 0.4], y0 + 0.8, y1 - 0.3, [nx, 0, nz], CELL.plain, 1e9, 1e9, SHOJI);
      const k = Math.max(1, Math.round(L / 2));
      for (let s2 = 0; s2 <= k; s2++) {
        const x = a[0] + (b[0] - a[0]) * (s2 / k), z = a[1] + (b[1] - a[1]) * (s2 / k);
        box(w, [x, (y0 + y1) / 2, z], [0.09, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, 0.09], POST);
      }
      const E1 = ext[i], E2 = ext[j], R1 = ridge[i], R2 = ridge[j];
      w.quad([E1[0], y1 - 0.25, E1[1]], [E2[0], y1 - 0.25, E2[1]], [R2[0], y1 + 1.9, R2[1]], [R1[0], y1 + 1.9, R1[1]], [nx, 1.4, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
      w.quad([E1[0], y1 - 0.27, E1[1]], [E2[0], y1 - 0.27, E2[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#5b4a3a'));
    }
    const top = triangulate(ridge);
    for (let i = 0; i < top.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => top.points[top.indices[i + k]]).map((v) => [v[0], y1 + 1.9, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    }
  }
  // 見る人の側の砂利の縁（塀のない辺）: 低い木の杭（0.6 m、2.5 m おき）にたるんだ麻の縄、外に灰色の飛び石。
  // 塀の外（裏）に竹の茂み 2 つ、州浜のそばに白い石（利用者の写真 NCM_0117・0121・0122）
  const POST = col('#706964'), ROPE = col('#808288'), SLAB = col('#bababe'), BAMBOO = col('#6a7d3a'), BLEAF = col('#5d7a32'), WHITE = col('#d9d6cf');
  const g = m.gravel, wallSet = new Set(m.wall.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`));
  const isWall = (p, q) => wallSet.has(`${p[0].toFixed(2)},${p[1].toFixed(2)}`) && wallSet.has(`${q[0].toFixed(2)},${q[1].toFixed(2)}`);
  for (let i = 0; i < g.length; i++) {
    const p = g[i], q = g[(i + 1) % g.length];
    if (isWall(p, q)) continue;
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1) continue;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    // 外向き（砂利の中心から離れる向き）
    let nx = -uz, nz = ux;
    if ((p[0] + ux * L / 2 - gx) * nx + (p[1] + uz * L / 2 - gz) * nz < 0) [nx, nz] = [-nx, -nz];
    const n = Math.max(1, Math.round(L / 2.5));
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const x = p[0] + ux * (L * k) / n + nx * 0.3, z = p[1] + uz * (L * k) / n + nz * 0.3, y = groundAt(x, z);
      box(w, [x, y + 0.3, z], [0.06, 0, 0], [0, 0.3, 0], [0, 0, 0.06], POST);
      if (prev) {
        // 縄: 2 つの区間でたるませる
        const mx = (prev[0] + x) / 2, mz = (prev[1] + z) / 2, my = (prev[2] + y) / 2 + 0.42;
        for (const [a, b] of [[[prev[0], prev[2] + 0.55, prev[1]], [mx, my, mz]], [[mx, my, mz], [x, y + 0.55, z]]]) {
          w.quad([a[0], a[1], a[2]], [b[0], b[1], b[2]], [b[0], b[1] + 0.03, b[2]], [a[0], a[1] + 0.03, a[2]], [nx, 0, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROPE);
        }
      }
      prev = [x, z, y];
    }
    for (let t = 0.8; t < L - 0.6; t += 1.7) {
      const x = p[0] + ux * t + nx * 1.4, z = p[1] + uz * t + nz * 1.4;
      box(W.inlay, [x, groundAt(x, z) + 0.05, z], [ux * 0.6, 0, uz * 0.6], [0, 0.04, 0], [nx * 0.3, 0, nz * 0.3], SLAB);
    }
  }
  for (const end of [m.wall[0], m.wall[m.wall.length - 1]]) {
    let ox = end[0] - gx, oz = end[1] - gz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const bx = end[0] + ox * 2.2, bz = end[1] + oz * 2.2, y = groundAt(bx, bz);
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2, r = rnd() * 1.1, h = 3.8 + rnd() * 1.6;
      const sx = bx + Math.cos(a) * r, sz = bz + Math.sin(a) * r;
      cylinder(w, sx, sz, 0.035, 0.025, y, y + h, { seg: 4, color: BAMBOO });
      blob(w, [sx, y + h - 0.6, sz], [0.6, 0.9, 0.6], rnd() * 6, 6, 4, () => BLEAF);
    }
  }
  for (const [rx, rz] of m.spit.slice(0, 3)) blob(w, [rx, groundAt(rx, rz) + 0.25, rz], [0.55, 0.35, 0.45], rnd() * 6, 7, 4, () => WHITE);
  keepOut.push([m.x, m.z, 14]);
}

// ---- ラ・グラーヴの円屋根: 半円アーチの窓と付け柱のあるレンガのドラム、石の軒、鉛色のドーム（リブ付き）、頂塔
function writeDome(m, W, groundAt) {
  const { x, z } = m;
  const y0 = groundAt(x, z) + m.base - 0.6;
  // 鼓胴は地面から 28 m 以上まで（利用者の写真 NCM_0102・0106・211211: ドームは病院の屋根の上に高い鼓胴ごと突き出し、
  // ポン・ヌフからもオテル・デューの屋根の上に大きく見える）
  const rDr = 9.4, yDr = Math.max(y0 + 11.5, groundAt(x, z) + 28), rDo = 9.7, hDo = 12.5;
  const w = W.main, mt = W.metal;
  const STONE = col('#d9cfbf'), DARK = col('#2b2523'), LEAD = col('#8c9a92'), BRICK = col('#d6aa94'); // 鉛の屋根は灰緑
  cylinder(w, x, z, rDr, rDr, y0, yDr, { seg: 32, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BRICK });
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    if (k % 2) {
      // 付け柱
      vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, [[-0.45, y0 + 0.6], [0.45, y0 + 0.6], [0.45, yDr - 0.8], [-0.45, yDr - 0.8]], n, STONE);
    } else {
      // 鼓胴の上のほうの窓（高い鼓胴では窓の段を上に置き、下は低いアーチの窓）
      const yw = yDr - y0 > 16 ? yDr - 7.4 : y0 + 3.2;
      vpoly(w, [x + n[0] * (rDr + 0.06), z + n[2] * (rDr + 0.06)], s, archShape(2.4, 5.4, yw, 8), n, STONE);
      vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, archShape(1.8, 5.0, yw + 0.2, 8), n, DARK);
      if (yw > y0 + 6) vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, archShape(1.4, 2.6, y0 + 2.4, 6), n, DARK);
    }
  }
  cylinder(w, x, z, rDr + 0.5, rDr + 0.5, yDr - 0.8, yDr, { seg: 32, color: STONE });
  annulus(w, x, z, rDr, rDr + 0.5, yDr - 0.8, 32, STONE, false);
  annulus(w, x, z, rDo, rDr + 0.5, yDr, 32, STONE);
  // ドーム（だ円の断面）と 16 本のリブ
  const N = 10;
  for (let j = 0; j < N; j++) {
    const p0 = (j / N) * (Math.PI / 2), p1 = ((j + 1) / N) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * rDo, Math.max(1.4, Math.cos(p1) * rDo), yDr + Math.sin(p0) * hDo, yDr + Math.sin(p1) * hDo, { seg: 32, color: LEAD });
  }
  const yTop = yDr + hDo;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + Math.PI / 16;
    for (let j = 0; j < N; j++) {
      const p0 = (j / N) * (Math.PI / 2), p1 = ((j + 1) / N) * (Math.PI / 2);
      const r0 = Math.cos(p0) * rDo + 0.08, r1 = Math.max(1.4, Math.cos(p1) * rDo) + 0.08;
      const y0r = yDr + Math.sin(p0) * hDo, y1r = yDr + Math.sin(p1) * hDo;
      const s = [-Math.sin(a), Math.cos(a)], c = [Math.cos(a), Math.sin(a)];
      const P = (r, y, o) => [x + c[0] * r + s[0] * o, y, z + c[1] * r + s[1] * o];
      const nn = [c[0] * (y1r - y0r), r0 - r1, c[1] * (y1r - y0r)];
      const l = Math.hypot(...nn) || 1;
      mt.quad(P(r0, y0r, -0.18), P(r0, y0r, 0.18), P(r1, y1r, 0.18), P(r1, y1r, -0.18), [nn[0] / l, nn[1] / l, nn[2] / l], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#949ca3'));
    }
  }
  // 頂塔（窓のある円筒と小さな円屋根）と十字架
  cylinder(w, x, z, 1.5, 1.5, yTop - 0.3, yTop + 3.0, { seg: 12, color: STONE });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * 1.52, z + n[2] * 1.52], s, archShape(0.55, 1.8, yTop + 0.6, 6), n, DARK);
  }
  annulus(w, x, z, 0, 1.75, yTop + 3.0, 12, STONE, false);
  for (let j = 0; j < 4; j++) {
    const p0 = (j / 4) * (Math.PI / 2), p1 = ((j + 1) / 4) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * 1.75, Math.max(0.15, Math.cos(p1) * 1.75), yTop + 3.0 + Math.sin(p0) * 1.6, yTop + 3.0 + Math.sin(p1) * 1.6, { seg: 12, color: LEAD });
  }
  const yc = yTop + 4.6;
  box(mt, [x, yc + 1.0, z], [0.07, 0, 0], [0, 1.0, 0], [0, 0, 0.07], col('#3a3a38'));
  box(mt, [x, yc + 1.4, z], [0.45, 0, 0], [0, 0.07, 0], [0, 0, 0.07], col('#3a3a38'));
}

// ---- 円柱と破風の柱廊（壁 mid の前、外向き n、壁に沿った t、幅 width）
function writePortico(m, W, groundAt, colliders) {
  const { mid, t, n, width } = m;
  const w = W.main;
  const STONE = col('#cbc6bd'), SHADE = col('#b5b0a6'), DARK = col('#4a4744');
  const y0 = groundAt(mid[0] + n[0] * 1.5, mid[1] + n[1] * 1.5);
  const D = 2.6, hw = width / 2, yC = y0 + 1.0, yE = yC + 11.5, yP = yE + 1.6, rise = Math.min(4.6, hw * 0.38);
  const at = (u, v) => [mid[0] + t[0] * u + n[0] * v, mid[1] + t[1] * u + n[1] * v];
  const T = (h) => [t[0] * h, 0, t[1] * h], N = (h) => [n[0] * h, 0, n[1] * h], Y = (h) => [0, h, 0];
  // 段（基壇）と、柱の後ろの暗い壁（柱廊の奥）
  const c0 = at(0, D / 2);
  box(w, [c0[0], y0 + 0.5, c0[1]], T(hw + 0.4), Y(0.6), N(D / 2 + 0.2), SHADE);
  const back = at(0, 0.08);
  vpoly(w, back, t, [[-hw, yC], [hw, yC], [hw, yE], [-hw, yE]], [n[0], 0, n[1]], DARK);
  // 6 本の円柱（礎盤・柱身・柱頭）
  for (let k = 0; k < 6; k++) {
    const u = -hw + 1.0 + ((2 * hw - 2.0) * k) / 5, [px, pz] = at(u, D - 0.8);
    box(w, [px, yC + 0.25, pz], T(0.75), Y(0.25), N(0.75), STONE);
    cylinder(w, px, pz, 0.62, 0.55, yC + 0.5, yE - 0.7, { seg: 14, color: STONE });
    box(w, [px, yE - 0.35, pz], T(0.75), Y(0.35), N(0.75), STONE);
    colliders.push([px, pz, 0.7]);
  }
  // 梁（エンタブラチュア）と三角の破風（前面・屋根の斜面・下面）
  const ce = at(0, D / 2);
  box(w, [ce[0], (yE + yP) / 2, ce[1]], T(hw + 0.3), Y((yP - yE) / 2), N(D / 2 + 0.3), STONE);
  const fr = at(0, D + 0.3), bk = at(0, -0.2);
  const tri = [[-hw - 0.3, yP], [hw + 0.3, yP], [0, yP + rise]];
  vpoly(w, fr, t, tri, [n[0], 0, n[1]], STONE);
  vpoly(w, at(0, D + 0.35), t, [[-hw + 1.2, yP + 0.5], [hw - 1.2, yP + 0.5], [0, yP + rise - 0.6]], [n[0], 0, n[1]], SHADE);
  for (const sgn of [-1, 1]) {
    const e = [fr[0] + t[0] * sgn * (hw + 0.3), fr[1] + t[1] * sgn * (hw + 0.3)], e2 = [bk[0] + t[0] * sgn * (hw + 0.3), bk[1] + t[1] * sgn * (hw + 0.3)];
    const nn = [t[0] * sgn * rise, hw + 0.3, t[1] * sgn * rise], l = Math.hypot(...nn);
    w.quad([e[0], yP, e[1]], [e2[0], yP, e2[1]], [bk[0], yP + rise, bk[1]], [fr[0], yP + rise, fr[1]], [nn[0] / l, nn[1] / l, nn[2] / l], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#8a8580'));
  }
}

// ---- キャピトルの主塔
function writeDonjon(m, W, groundAt, colliders) {
  const { cx, cz, e1, e2, a, b } = m;
  const y0 = groundAt(cx, cz) - 0.3, H = 18, yM = y0 + H, yP = yM + 1.4;
  const w = W.main, mt = W.metal;
  const STONE = col('#e8dfd0'), SHADE = col('#cfc5b4'), DARK = col('#2c2826'), SLATE = col('#64666a'), WHITE_C = col('#f4f1ea');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y, cz + e1[1] * u + e2[1] * v];
  const E1 = (h) => [e1[0] * h, 0, e1[1] * h], E2 = (h) => [e2[0] * h, 0, e2[1] * h], EY = (h) => [0, h, 0];
  // 塔の体と、少し張り出した出し狭間の帯、狭間のある胸壁
  box(w, [cx, (y0 + yM) / 2, cz], E1(a), EY((yM - y0) / 2), E2(b), STONE);
  box(w, [cx, yM + 0.7, cz], E1(a + 0.4), EY(0.7), E2(b + 0.4), SHADE);
  // 四つの面: 外向きの法線 n・面に沿った向き t・面の半分の幅 hw・中心からの距離 d
  const sides = [[e1, e2, b, a], [[-e1[0], -e1[1]], e2, b, a], [e2, e1, a, b], [[-e2[0], -e2[1]], e1, a, b]];
  for (const [n, t, hw, d] of sides) {
    const N = [n[0], 0, n[1]];
    // 出し狭間の持ち送りのあいだの暗いすき間
    for (let o = -hw - 0.2; o <= hw + 0.2; o += 0.9) {
      vpoly(w, [cx + n[0] * (d + 0.41) + t[0] * o, cz + n[1] * (d + 0.41) + t[1] * o], t, [[-0.25, yM], [0.25, yM], [0.25, yM + 0.5], [-0.25, yM + 0.5]], N, DARK);
    }
    // 胸壁の凸部
    for (let o = -hw; o <= hw + 0.01; o += 1.6) {
      const q = [cx + n[0] * (d + 0.25) + t[0] * o, cz + n[1] * (d + 0.25) + t[1] * o];
      box(w, [q[0], yP + 0.5, q[1]], [t[0] * 0.4, 0, t[1] * 0.4], EY(0.5), [n[0] * 0.15, 0, n[1] * 0.15], STONE);
    }
    // 小さな窓（2 つずつ、4 段）
    for (const yw of [y0 + 4.5, y0 + 8.5, y0 + 12.5, y0 + 15.5]) {
      for (const o of [-hw * 0.45, hw * 0.45]) {
        for (const dx of [-0.45, 0.45]) {
          vpoly(w, [cx + n[0] * (d + 0.05) + t[0] * (o + dx), cz + n[1] * (d + 0.05) + t[1] * (o + dx)], t, [[-0.3, yw], [0.3, yw], [0.3, yw + 1.3], [-0.3, yw + 1.3]], N, DARK);
        }
      }
    }
  }
  // 急なスレートの寄棟屋根（棟は長い辺の向き）
  const A = a - 0.15, B = b - 0.15, yR = yP + B * 1.45, ra = Math.max(0.5, A - B);
  const face = (pts, n) => {
    for (let i = 1; i + 1 < pts.length; i++) mt.tri(pts[0], pts[i], pts[i + 1], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLATE);
  };
  const nrm = (p, q, r) => {
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...c) || 1;
    return c[1] < 0 ? [-c[0] / l, -c[1] / l, -c[2] / l] : [c[0] / l, c[1] / l, c[2] / l];
  };
  const c00 = P(-A, -B, yP), c10 = P(A, -B, yP), c11 = P(A, B, yP), c01 = P(-A, B, yP), r0 = P(-ra, 0, yR), r1 = P(ra, 0, yR);
  for (const f of [[c00, c10, r1, r0], [c11, c01, r0, r1], [c10, c11, r1], [c01, c00, r0]]) face(f, nrm(f[0], f[1], f[2]));
  // 時計の屋根窓（正面の側の屋根の真ん中）
  const fs = sides.reduce((best, sd) => (sd[0][0] * m.front[0] + sd[0][1] * m.front[1] > best[0][0] * m.front[0] + best[0][1] * m.front[1] ? sd : best));
  {
    const [n, t, , d] = fs;
    const N = [n[0], 0, n[1]];
    const q = [cx + n[0] * (d - 0.6), cz + n[1] * (d - 0.6)];
    box(w, [q[0], yP + 1.3, q[1]], [t[0] * 1.3, 0, t[1] * 1.3], EY(1.3), [n[0] * 0.6, 0, n[1] * 0.6], STONE);
    vpoly(mt, [q[0] + n[0] * 0.61, q[1] + n[1] * 0.61], t, [[-1.45, yP + 2.6], [1.45, yP + 2.6], [0, yP + 4.0]], N, SLATE);
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
      vpoly(w, [q[0] + n[0] * 0.62, q[1] + n[1] * 0.62], t, [[0, yP + 1.35], [Math.cos(a0) * 0.85, yP + 1.35 + Math.sin(a0) * 0.85], [Math.cos(a1) * 0.85, yP + 1.35 + Math.sin(a1) * 0.85]], N, k % 4 === 0 ? DARK : WHITE_C);
    }
  }
  // 正面の角の小塔（持ち送りの上の円筒と円錐の屋根）
  for (const sv of [-1, 1]) {
    const [n, t, hw, d] = fs;
    const q = [cx + n[0] * (d + 0.3) + t[0] * (hw + 0.3) * sv, cz + n[1] * (d + 0.3) + t[1] * (hw + 0.3) * sv];
    cylinder(w, q[0], q[1], 0.3, 1.25, yM - 4.5, yM - 2.5, { seg: 12, color: STONE });
    cylinder(w, q[0], q[1], 1.25, 1.25, yM - 2.5, yP + 1.0, { seg: 12, color: STONE });
    cylinder(mt, q[0], q[1], 1.45, 0.02, yP + 1.0, yP + 6.0, { seg: 12, color: SLATE });
  }
  // 真ん中の八角形の鐘楼（アーチの開口）と尖塔、頂の飾り
  const yb = yR - 0.8;
  cylinder(w, cx, cz, 1.7, 1.7, yb, yb + 4.2, { seg: 8, color: STONE });
  for (let k = 0; k < 8; k++) {
    const an = ((k + 0.5) / 8) * Math.PI * 2;
    const n = [Math.cos(an), 0, Math.sin(an)], t = [-Math.sin(an), Math.cos(an)];
    const rr = 1.7 * Math.cos(Math.PI / 8) + 0.03;
    vpoly(w, [cx + n[0] * rr, cz + n[2] * rr], t, archShape(0.8, 2.2, yb + 1.3, 6), n, DARK);
  }
  annulus(w, cx, cz, 0, 1.95, yb + 4.2, 8, SHADE, false);
  cylinder(w, cx, cz, 1.95, 1.95, yb + 4.2, yb + 4.5, { seg: 8, color: SHADE });
  cylinder(mt, cx, cz, 1.85, 0.03, yb + 4.5, yb + 11.5, { seg: 8, color: SLATE });
  box(mt, [cx, yb + 12.2, cz], [0.05, 0, 0], [0, 0.8, 0], [0, 0, 0.05], DARK);
  for (const [p, q] of [[P(-a, -b, 0), P(a, -b, 0)], [P(a, -b, 0), P(a, b, 0)], [P(a, b, 0), P(-a, b, 0)], [P(-a, b, 0), P(-a, -b, 0)]]) colliders.push([p[0], p[2], q[0], q[2]]);
}

// ---- ロマネスクの大聖堂（サン・セルナン）。u: 東へ（e1）、v: 横（e2）、高さは地面から
function writeBasilica(m, W, groundAt) {
  const { cx, cz, e1, e2, a, b, sc } = m;
  const y0 = groundAt(cx, cz) - 0.3;
  const w = W.main;
  const BR = col('#efc1a8'), TILE = col('#a35c47'), DARK = col('#3a2c26'), STONE = col('#ddd2c2');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
  const P2 = (u, v) => [cx + e1[0] * u + e2[0] * v, cz + e1[1] * u + e2[1] * v];
  const N = (du, dv) => [e1[0] * du + e2[0] * dv, 0, e1[1] * du + e2[1] * dv];
  const side = (p, q, ya, yb, n) => wall(w, P2(...p), P2(...q), y0 + ya, y0 + yb, n, CELL.brick, BRICK_CW, BRICK_CW, BR);
  // 窓: p・n・along は世界の座標（P2・T で変換したもの）
  const win = (p, n, along, yb, ht, wd = 1.3) => vpoly(w, [p[0] + n[0] * 0.06, p[1] + n[1] * 0.06], along, archShape(wd, ht, y0 + yb, 6), [n[0], 0, n[1]], DARK);
  const T = (dir) => [e1[0] * dir[0] + e2[0] * dir[1], e1[1] * dir[0] + e2[1] * dir[1]]; // (u, v) の向き → 世界
  // 箱（u0..u1 × v0..v1、高さ h）の 4 面と、窓（step m おき）
  const block = (u0, u1, v0, v1, h, winY = null, winH = 3.5, skip = '') => {
    if (!skip.includes('s')) side([u0, v0], [u1, v0], 0, h, N(0, -1));
    if (!skip.includes('n')) side([u1, v1], [u0, v1], 0, h, N(0, 1));
    if (!skip.includes('w')) side([u0, v1], [u0, v0], 0, h, N(-1, 0));
    if (!skip.includes('e')) side([u1, v0], [u1, v1], 0, h, N(1, 0));
    if (winY == null) return;
    for (let u = u0 + 3; u < u1 - 2; u += 6) {
      for (const [v, n] of [[v0, [0, -1]], [v1, [0, 1]]]) win(P2(u, v), T(n), T([1, 0]), winY, winH);
    }
  };
  // 切妻の瓦屋根（棟は along = 'u' か 'v'）。軒 ye・棟 yr
  const gable = (u0, u1, v0, v1, ye, yr, along) => {
    const q = (A, B, C, D) => {
      const n = (() => {
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
        const c = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...c) || 1;
        return c[1] < 0 ? c.map((t) => -t / l) : c.map((t) => t / l);
      })();
      w.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    };
    const tri = (A, B, C, n) => w.tri(A, B, C, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, BR);
    if (along === 'u') {
      const vm = (v0 + v1) / 2;
      q(P(u0 - 0.4, v0 - 0.6, ye), P(u1 + 0.4, v0 - 0.6, ye), P(u1 + 0.4, vm, yr), P(u0 - 0.4, vm, yr));
      q(P(u0 - 0.4, v1 + 0.6, ye), P(u1 + 0.4, v1 + 0.6, ye), P(u1 + 0.4, vm, yr), P(u0 - 0.4, vm, yr));
      tri(P(u0, v0, ye), P(u0, v1, ye), P(u0, vm, yr), N(-1, 0));
      tri(P(u1, v0, ye), P(u1, v1, ye), P(u1, vm, yr), N(1, 0));
    } else {
      const um = (u0 + u1) / 2;
      q(P(u0 - 0.6, v0 - 0.4, ye), P(u0 - 0.6, v1 + 0.4, ye), P(um, v1 + 0.4, yr), P(um, v0 - 0.4, yr));
      q(P(u1 + 0.6, v0 - 0.4, ye), P(u1 + 0.6, v1 + 0.4, ye), P(um, v1 + 0.4, yr), P(um, v0 - 0.4, yr));
      tri(P(u0, v0, ye), P(u1, v0, ye), P(um, v0, yr), N(0, -1));
      tri(P(u0, v1, ye), P(u1, v1, ye), P(um, v1, yr), N(0, 1));
    }
  };
  // 片流れの屋根（側廊）: 外の軒 yo（v = vo）から内の壁 yi（v = vi）へ
  const leanTo = (u0, u1, vo, vi, yo, yi) => {
    const A = P(u0, vo, yo), B = P(u1, vo, yo), C = P(u1, vi, yi), D = P(u0, vi, yi);
    const n = N(0, Math.sign(vo - vi) * (yi - yo));
    n[1] = Math.abs(vi - vo);
    const l = Math.hypot(...n);
    w.quad(A, B, C, D, n.map((t) => t / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
  };
  const tan = Math.tan((20 * Math.PI) / 180);
  const W0 = -a + 1, tH = 9, sA = sc + 16, vN = 6.5, vA = 16, hA = 12, hN = 21, hT = 21;
  const vT = Math.min(b - 1, 31);
  // 身廊と側廊（西の正面から交差部の手前まで）
  block(W0, sc - tH, -vA, vA, hA, 4.5, 4, 'e');
  block(W0, sc - tH, -vN, vN, hN, 16, 3.2, 'e');
  for (const sgn of [-1, 1]) leanTo(W0, sc - tH, sgn * vA, sgn * vN, hA, hA + (vA - vN) * tan * 1.6);
  gable(W0, sc - tH, -vN, vN, hN, hN + vN * tan, 'u');
  // 袖廊
  block(sc - tH, sc + tH, -vT, vT, hT, 5, 4.5, '');
  gable(sc - tH, sc + tH, -vT, vT, hT, hT + tH * tan, 'v');
  // 内陣（袖廊から後陣の中心まで）
  block(sc + tH, sA, -vA, vA, hA, null, 0, 'w');
  block(sc + tH, sA, -vN, vN, hN, null, 0, 'we');
  for (const sgn of [-1, 1]) leanTo(sc + tH, sA, sgn * vA, sgn * vN, hA, hA + (vA - vN) * tan * 1.6);
  gable(sc + tH, sA, -vN, vN, hN, hN + vN * tan, 'u');
  // 東の端: 半円の壁・半円錐の屋根（中心は後陣の中心、角度は e1 から ±90°）
  const dir = (t) => [Math.cos(t), Math.sin(t)];
  const arc = (ou, ov, r, t0, t1, h, seg, yb = 0) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      side([ou + ca * r, ov + sa * r], [ou + cb * r, ov + sb * r], yb, h, N(cm, sm));
    }
  };
  const cone = (ou, ov, r, t0, t1, ye, yt, seg, rIn = 0) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      const ro = r + 0.5, n = N(cm * (yt - ye), sm * (yt - ye));
      n[1] = ro - rIn;
      const l = Math.hypot(...n);
      w.quad(P(ou + ca * ro, ov + sa * ro, ye), P(ou + cb * ro, ov + sb * ro, ye), P(ou + cb * rIn, ov + sb * rIn, yt), P(ou + ca * rIn, ov + sa * rIn, yt), n.map((t) => t / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    }
  };
  // 半円の壁に沿った白い石の帯（半径 r、高さ ya〜yb）
  const band = (ou, ov, r, t0, t1, ya, yb, seg) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      w.quad(P(ou + ca * r, ov + sa * r, ya), P(ou + cb * r, ov + sb * r, ya), P(ou + cb * r, ov + sb * r, yb), P(ou + ca * r, ov + sa * r, yb), N(cm, sm), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STONE);
    }
  };
  const H = Math.PI / 2;
  // 後陣の円筒（20 m）と半円錐の屋根、半円アーチの窓
  arc(sA, 0, vN, -H, H, 20, 10, hA);
  cone(sA, 0, vN, -H, H, 20, 24.5, 10);
  for (let k = 0; k < 5; k++) {
    const t = -H + ((k + 0.5) / 5) * Math.PI, [c, sn] = dir(t);
    win(P2(sA + c * vN, sn * vN), T([c, sn]), T([-sn, c]), 15.2, 3.4, 1.1);
  }
  // 周歩廊（13 m）と片流れの屋根
  const rAm = 14;
  arc(sA, 0, rAm, -H, H, 13, 16);
  for (const [sgn] of [[-1], [1]]) side([sA, sgn * vA], [sA, sgn * rAm], 0, hA, N(-1, 0));
  cone(sA, 0, rAm, -H, H, 13, 15.5, 16, vN);
  // 放射状の 5 つの小礼拝堂（直径 6 m・8 m）と半円錐の屋根。窓は 3 つ（利用者の写真 NCM_0099: 礼拝堂・周歩廊・後陣が
  // 段々に重なり、どの段にも半円アーチの窓と白い石の帯）
  for (let k = 0; k < 5; k++) {
    const t = -H + ((k + 0.5) / 5) * Math.PI, [c, sn] = dir(t);
    const ou = sA + c * (rAm + 0.6), ov = sn * (rAm + 0.6);
    arc(ou, ov, 3, t - H, t + H, 8, 12);
    cone(ou, ov, 3, t - H, t + H, 8, 10.2, 12); // 12 に分けて半円錐に見せる（8 では角錐に見えた）
    for (const dt of [-0.75, 0, 0.75]) {
      const [cw, sw] = dir(t + dt);
      win(P2(ou + cw * 3, ov + sw * 3), T([cw, sw]), T([-sw, cw]), 3.0, 3.0, 0.85);
    }
    // 周歩廊の、礼拝堂の屋根の上の窓
    win(P2(sA + c * rAm, sn * rAm), T([c, sn]), T([-sn, c]), 10.5, 2.2, 1.0);
    band(ou, ov, 3.06, t - H, t + H, 7.5, 7.8, 12);
  }
  // 周歩廊の、礼拝堂のあいだの窓と、白い石の帯
  for (let k = 1; k < 5; k++) {
    const t = -H + (k / 5) * Math.PI, [c, sn] = dir(t);
    win(P2(sA + c * rAm, sn * rAm), T([c, sn]), T([-sn, c]), 4.5, 3.6, 1.2);
  }
  band(sA, 0, rAm + 0.06, -H, H, 12.4, 12.8, 16);
  band(sA, 0, vN + 0.06, -H, H, 19.4, 19.8, 10);
  // 白い石の帯（側廊の窓の下）
  for (const [v, n] of [[-vA, [0, -1]], [vA, [0, 1]]]) {
    const p = P2(W0, v), q = P2(sc - tH, v);
    const nn = N(...n);
    w.quad([p[0] + nn[0] * 0.05, y0 + 3.6, p[1] + nn[2] * 0.05], [q[0] + nn[0] * 0.05, y0 + 3.6, q[1] + nn[2] * 0.05], [q[0] + nn[0] * 0.05, y0 + 4.0, q[1] + nn[2] * 0.05], [p[0] + nn[0] * 0.05, y0 + 4.0, p[1] + nn[2] * 0.05], nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STONE);
  }
}

// ---- カピテヌリー: レンガの横の壁、北の半円のガラスの正面（暗い枠）、張り出した暗い金属のかまぼこ屋根
function writeCapitainerie(m, W, groundAt, colliders) {
  const { cx, cz, ax, hl, hw } = m;
  const w = W.main, mt = W.metal;
  const y0 = groundAt(cx, cz), hWall = 4.4, rise = Math.min(5.2, hw * 0.75);
  const side = [-ax[1], ax[0]];
  const P = (u, v, y) => [cx + ax[0] * u + side[0] * v, y0 + y, cz + ax[1] * u + side[1] * v];
  const P2 = (u, v) => [cx + ax[0] * u + side[0] * v, cz + ax[1] * u + side[1] * v];
  const ROOF = col('#525a64'), GLASS = col('#3d4a52'), FRAME = col('#2a2e30'), BRICKC = col('#d39a80');
  // 横の壁（レンガ）と裏の壁
  wall(w, P2(-hl, -hw), P2(hl, -hw), y0, y0 + hWall, [-side[0], 0, -side[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  wall(w, P2(hl, hw), P2(-hl, hw), y0, y0 + hWall, [side[0], 0, side[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  wall(w, P2(-hl, hw), P2(-hl, -hw), y0, y0 + hWall, [-ax[0], 0, -ax[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  // 屋根の断面（円弧）: v → 高さ
  const N = 12, arcY = (f) => hWall + rise * Math.sin(Math.acos(Math.max(-1, Math.min(1, f))));
  const ov = 1.5, ovs = 0.5;
  for (let i = 0; i < N; i++) {
    const f0 = -1 + (2 * i) / N, f1 = -1 + (2 * (i + 1)) / N;
    const v0 = f0 * (hw + ovs), v1 = f1 * (hw + ovs), y0a = arcY(f0), y1a = arcY(f1);
    const nn = [side[0] * -(y1a - y0a), v1 - v0, side[1] * -(y1a - y0a)], l = Math.hypot(...nn);
    mt.quad(P(-hl - ov, v0, y0a), P(hl + ov, v0, y0a), P(hl + ov, v1, y1a), P(-hl - ov, v1, y1a), nn.map((q) => q / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    // 正面のガラス（円弧の下の扇形）と裏の妻壁
    for (const [u, sg] of [[hl, 1], [-hl, -1]]) {
      const n3 = [ax[0] * sg, 0, ax[1] * sg];
      const vv0 = f0 * hw, vv1 = f1 * hw, ya = arcY(f0) - 0.1, yb = arcY(f1) - 0.1;
      if (sg > 0) w.quad(P(u, vv0, 0), P(u, vv1, 0), P(u, vv1, yb), P(u, vv0, ya), n3, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, GLASS);
      else w.quad(P(u, vv0, hWall), P(u, vv1, hWall), P(u, vv1, yb), P(u, vv0, ya), n3, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, BRICKC);
    }
  }
  // ガラスの正面の縦の枠
  for (let k = 0; k <= 8; k++) {
    const f = -1 + (2 * k) / 8, v = f * hw, yt = arcY(f) - 0.1;
    const c = P2(hl + 0.05, v);
    box(w, [c[0], y0 + yt / 2, c[1]], [ax[0] * 0.06, 0, ax[1] * 0.06], [0, yt / 2, 0], [side[0] * 0.08, 0, side[1] * 0.08], FRAME);
  }
  const c = P2(hl + 0.05, 0);
  box(w, [c[0], y0 + 2.6, c[1]], [ax[0] * 0.06, 0, ax[1] * 0.06], [0, 0.08, 0], [side[0] * hw, 0, side[1] * hw], FRAME);
}

// ---- つないだ平底船: 暗い紺〜黒の船体（へさきは細く）、白い操舵室とニスを塗った木の屋根
function writeMoorings(m, W, groundAt, colliders, onRoad, keepOut, waterAt) {
  const w = W.main;
  const HULLS = [col('#1e2a3a'), col('#202224'), col('#2c3b2e'), col('#3a2a24')], CABIN = col('#e8e6e0'), WOOD = col('#8a5e3a'), DECK = col('#6e6a62');
  const { t, n } = m;
  for (const { x, z, len, k } of m.boats) {
    const yw = waterAt(x, z, m.area);
    const hl = len / 2, hb = 2.2, fb = 0.9;
    const P = (u, v, y) => [x + t[0] * u + n[0] * v, yw + y, z + t[1] * u + n[1] * v];
    const hull = HULLS[k % HULLS.length];
    // 船体: 四角い胴と、細くなるへさき
    box(w, [x + t[0] * -1.5, yw + fb / 2 - 0.3, z + t[1] * -1.5], [t[0] * (hl - 1.5), 0, t[1] * (hl - 1.5)], [0, fb / 2 + 0.3, 0], [n[0] * hb, 0, n[1] * hb], hull, { top: DECK });
    const bow = [P(hl - 3, -hb, -0.6), P(hl - 3, hb, -0.6), P(hl, 0, -0.6), P(hl - 3, -hb, fb + 0.1), P(hl - 3, hb, fb + 0.1), P(hl + 0.4, 0, fb + 0.1)];
    for (const sg of [-1, 1]) {
      const a = sg < 0 ? 0 : 1, nn = [n[0] * sg + t[0] * 0.8, 0, n[1] * sg + t[1] * 0.8], l = Math.hypot(...nn);
      w.quad(bow[a], bow[2], bow[5], bow[a + 3], nn.map((q) => q / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, hull);
    }
    w.tri(bow[3], bow[4], bow[5], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, DECK);
    // 操舵室・居室（後ろ寄り）と木の屋根
    const cl = Math.min(hl * 1.1, 8 + hash01(k, 74) * 6), cu = -hl + 1.5 + cl / 2;
    const cc = P(cu, 0, 0);
    box(w, [cc[0], yw + fb + 0.9, cc[2]], [t[0] * cl / 2, 0, t[1] * cl / 2], [0, 0.9, 0], [n[0] * (hb - 0.4), 0, n[1] * (hb - 0.4)], CABIN, { top: WOOD });
    for (let j = 0; j < Math.floor(cl / 1.6); j++) {
      const wc = P(cu - cl / 2 + 0.9 + j * 1.6, hb - 0.38, fb + 1.15);
      for (const sg of [-1, 1]) vpoly(w, [wc[0] + n[0] * (sg < 0 ? -2 * (hb - 0.38) : 0), wc[2] + n[1] * (sg < 0 ? -2 * (hb - 0.38) : 0)], t, [[-0.45, wc[1] - 0.35], [0.45, wc[1] - 0.35], [0.45, wc[1] + 0.35], [-0.45, wc[1] + 0.35]], [n[0] * sg, 0, n[1] * sg], col('#2c3238'));
    }
  }
}

// ---- 川に面した正面: 破風・水際のアーチ・古い橋脚の跡
function writeRiverfront(m, W, groundAt) {
  const w = W.main;
  const { p, q, L, n, height: H } = m;
  const STONE = col('#d8ccb8'), DARK = col('#262322'), BRICK = col('#b78268'), PIER = col('#9a7262');
  const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
  const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
  const y0 = groundAt(...at(L / 2, -2));
  // 真ん中の張り出し（幅 14 m の淡い石の枠）と三角の破風
  const c = at(L / 2, 0.08);
  vpoly(w, c, t, [[-7, y0 + H - 1.2], [7, y0 + H - 1.2], [7, y0 + H], [-7, y0 + H]], N, STONE);
  vpoly(w, at(L / 2, 0.1), t, [[-7.4, y0 + H], [7.4, y0 + H], [0, y0 + H + 3.4]], N, STONE);
  vpoly(w, at(L / 2, 0.12), t, [[-5.6, y0 + H + 0.4], [5.6, y0 + H + 0.4], [0, y0 + H + 2.7]], N, BRICK);
  for (const sx of [-7, 7]) vpoly(w, at(L / 2 + sx, 0.09), t, [[-0.5, y0], [0.5, y0], [0.5, y0 + H], [-0.5, y0 + H]], N, STONE);
  // 水際の 2 つの大きなアーチ（真ん中の左）
  const yw = groundAt(...at(L / 2, 6));
  for (const sx of [-14, -7.5]) {
    vpoly(w, at(L / 2 + sx, 0.08), t, archShape(5.0, 5.8, yw - 0.5, 10), N, STONE);
    vpoly(w, at(L / 2 + sx, 0.11), t, archShape(4.2, 5.3, yw - 0.5, 10), N, DARK);
  }
  // 川の中の古い橋脚の跡（正面から 14 m 沖）: 尖った水切りの付いた台と、片側に残るアーチの付け根
  const pc = at(L / 2 + 4, 14), yb = groundAt(...pc) - 0.5, yt = y0 - 0.6;
  if (yt - yb > 1) {
    box(w, [pc[0], (yb + yt) / 2, pc[1]], [t[0] * 4, 0, t[1] * 4], [0, (yt - yb) / 2, 0], [n[0] * 2.6, 0, n[1] * 2.6], PIER);
    cylinder(w, pc[0] + n[0] * 2.6, pc[1] + n[1] * 2.6, 2.6, 0.2, yb, yt, { seg: 4, color: PIER });
    vpoly(w, at(L / 2 + 8.05, 14), [n[0], n[1]], [[-2.6, yt], [2.6, yt], [2.6, yt + 2.2], [-2.6, yt + 0.6]], [t[0], 0, t[1]], BRICK);
  }
}

// ---- ネオロマネスクのアーケードの正面（オーギュスタン美術館）
function writeArcades(m, W, groundAt) {
  const w = W.main;
  const SAND = col('#8f877c'), STONE = col('#d2c7b6'), DARK = col('#2a2624'), GLASS = col('#46525a'), TRIM = col('#c98c6c');
  for (const { p, q, L, n } of m.edges) {
    const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
    const y0 = groundAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
    const band = (ya, yb, o, color) => vpoly(w, at(L / 2, o), t, [[-L / 2, y0 + ya], [L / 2, y0 + ya], [L / 2, y0 + yb], [-L / 2, y0 + yb]], N, color);
    band(0, 1.5, 0.06, SAND); // 腰石
    band(7.4, 7.9, 0.08, STONE); // 石の帯
    band(11.7, 12.4, 0.12, STONE); // 軒の持ち送り
    const nb = Math.max(1, Math.floor(L / 4.6));
    for (let k = 0; k < nb; k++) {
      const sm = (L * (k + 0.5)) / nb;
      vpoly(w, at(sm, 0.07), t, archShape(4.1, 7.0, y0 + 0.2, 10), N, TRIM); // アーチの迫石
      vpoly(w, at(sm, 0.1), t, archShape(3.4, 6.6, y0 + 0.2, 10), N, GLASS); // ガラスの開口
      vpoly(w, at(sm, 0.11), t, [[-0.06, y0 + 0.2], [0.06, y0 + 0.2], [0.06, y0 + 6.6], [-0.06, y0 + 6.6]], N, DARK);
      for (const dx of [-0.75, 0.75]) vpoly(w, at(sm + dx, 0.09), t, archShape(1.0, 2.6, y0 + 8.6, 6), N, DARK); // 2 つ並びの窓
      for (const dx of [-0.6, 0, 0.6]) vpoly(w, at(sm + dx, 0.13), t, [[-0.12, y0 + 11.2], [0.12, y0 + 11.2], [0.12, y0 + 11.7], [-0.12, y0 + 11.7]], N, STONE); // 持ち送り
    }
  }
}

// ---- ゴシックの石の内陣: 辺ごとに控え壁（尖塔飾り付き）と、そのあいだの 2 段の尖頭アーチの窓
const lancet = (wd, ht, y0) => {
  const r = wd / 2, ys = y0 + ht - wd * 0.95;
  return [[-r, y0], [r, y0], [r, ys], [r * 0.72, ys + (y0 + ht - ys) * 0.55], [0, y0 + ht], [-r * 0.72, ys + (y0 + ht - ys) * 0.55], [-r, ys]];
};
function writeChoir(m, W, groundAt, colliders) {
  const w = W.main;
  const STONE = col('#b3a696'), SOOT = col('#4f4843'), DARK = col('#26282c'), TRACERY = col('#9a8f82');
  const H = m.height;
  for (const { p, q, L, n } of m.edges) {
    const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
    const y0 = groundAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
    // すすけた足元（6 m）
    vpoly(w, at(L / 2, 0.04), t, [[-L / 2, y0], [L / 2, y0], [L / 2, y0 + 6], [-L / 2, y0 + 6]], N, SOOT);
    // 控え壁: 辺の両端と 6.5 m ごと
    const nb = Math.max(1, Math.round(L / 6.5));
    for (let k = 0; k <= nb; k++) {
      const c = at((L * k) / nb, 0.9);
      box(w, [c[0], y0 + H * 0.42, c[1]], [t[0] * 0.6, 0, t[1] * 0.6], [0, H * 0.42, 0], [n[0] * 0.9, 0, n[1] * 0.9], STONE);
      const c2 = at((L * k) / nb, 0.5);
      box(w, [c2[0], y0 + H * 0.92, c2[1]], [t[0] * 0.45, 0, t[1] * 0.45], [0, H * 0.08, 0], [n[0] * 0.5, 0, n[1] * 0.5], STONE);
      cylinder(w, c2[0], c2[1], 0.45, 0.02, y0 + H, y0 + H + 3.2, { seg: 4, color: STONE });
      colliders.push([c[0], c[1], 1.0]);
    }
    // 窓（控え壁のあいだごとに、下の段 4〜9 m と上の段 10.5〜19 m）
    for (let k = 0; k < nb; k++) {
      const sm = (L * (k + 0.5)) / nb, span = L / nb;
      if (span < 3) continue;
      const wd = Math.min(2.6, span - 2.2), o = at(sm, 0.05);
      vpoly(w, o, t, lancet(wd + 0.5, 6.3, y0 + 3.7), N, TRACERY);
      vpoly(w, at(sm, 0.08), t, lancet(wd, 5.8, y0 + 4), N, DARK);
      if (H > 16) {
        vpoly(w, o, t, lancet(wd + 0.5, Math.min(9, H - 12) + 0.4, y0 + 10.3), N, TRACERY);
        vpoly(w, at(sm, 0.08), t, lancet(wd, Math.min(9, H - 12), y0 + 10.5), N, DARK);
      }
    }
    // 軒の手すり（細い帯）
    vpoly(w, at(L / 2, 0.06), t, [[-L / 2, y0 + H - 0.9], [L / 2, y0 + H - 0.9], [L / 2, y0 + H + 0.6], [-L / 2, y0 + H + 0.6]], N, STONE);
  }
}

// ---- 遊歩道の植え込み: 低木の塊（高さ 1〜2 m）と、幹の細い若い木（高さ 6〜9 m）
function writeRamblas(m, W, groundAt) {
  const w = W.main;
  const SHRUB = [col('#5a6026'), col('#4a5328'), col('#3f4628'), col('#66692e')], LEAF = [col('#5f7a35'), col('#6b8238'), col('#577030')];
  for (const [x, z, k] of m.shrubs) {
    const h = 1 + hash01(k, 64) * 1.0, r = 0.7 + hash01(k, 65) * 0.5;
    blob(w, [x, groundAt(x, z) + h * 0.55, z], [r * 1.2, h * 0.55, r], hash01(k, 66) * 6, 7, 4, (f) => SHRUB[(k + f) % SHRUB.length]);
  }
  for (const [x, z, k] of m.young) {
    const y = groundAt(x, z), h = 6 + hash01(k, 67) * 3, r = 1.6 + hash01(k, 68) * 0.9;
    for (const [dx, dz] of [[0.18, 0], [-0.12, 0.15]]) cylinder(w, x + dx, z + dz, 0.08, 0.05, y, y + h - r, { seg: 5, color: col('#6a6058') });
    blob(w, [x, y + h - r * 0.9, z], [r, r * 0.95, r * 0.9], hash01(k, 69) * 6, 9, 5, (f) => LEAF[(k + f) % LEAF.length]);
  }
}

// ---- 閘門（利用者の写真 NCM_0185）: 幅 6.4 m・深さ約 4 m の石積みの閘室（灰色の切石）、底に暗い水。運河の側の端に
// 錆色の鋼の扉と、その上を渡る鋼の歩道橋（格子の床）。閘室のまわりは黒い鋼の柵（2 m ごとの X の筋交いと、交点の丸い飾り）。
// 地形モデルでは閘室が浅い窪みなので、閘室の上の面（ステンシル）で地面を切り抜き、中を壁と水で描く（メトロの出入口と同じ）
function writeLock(m, W, groundAt, colliders, onRoad, keepOut, waterAt) {
  const w = W.main, mt = W.metal;
  const { L, u, v, at: P } = lockFrame(m.a, m.b);
  const hw = m.width / 2;
  const yw = waterAt(...P(L / 2, 0), m.area) + 0.02;
  const STONE = ['#b9b3a8', '#aea89d', '#c2bcb1', '#a7a196'].map(col), COPING = col('#bfbab0'), WATER = col('#2f3a38');
  const GATE = col('#8a6a60'), IRON = col('#3a3a3c'), GRATE = col('#4a4c4e');
  const u0 = m.from, u1 = L, step = 3;
  const us = [];
  for (let k = 0; k <= Math.ceil((u1 - u0) / step); k++) us.push(Math.min(u1, u0 + k * step));
  // 両側の縁の高さ: 壁のすぐ外の地面と、閘室の中の地面（地形モデルの浅い窪み。切り抜く面より下にする）の高い方
  const inner = us.map((t) => {
    let y = -Infinity;
    for (let du = -1.5; du <= 1.5; du += 0.75) for (let dv = -hw; dv <= hw + 1e-6; dv += hw / 4) y = Math.max(y, groundAt(...P(Math.min(u1, Math.max(u0, t + du)), dv)));
    return y;
  });
  const edge = [-1, 1].map((sd) => us.map((t) => groundAt(...P(t, sd * (hw + 0.9)))));
  const top = edge.map((E) => E.map((e, k) => Math.max(yw + 1.5, e, inner[k]) + 0.05));
  // 段にならないよう、隣との差を 1 区間 0.35 m までに（低い方を持ち上げる）
  for (const T of top) {
    for (let k = 1; k < T.length; k++) T[k] = Math.max(T[k], T[k - 1] - 0.35);
    for (let k = T.length - 2; k >= 0; k--) T[k] = Math.max(T[k], T[k + 1] - 0.35);
  }
  const topAt = (si, t) => {
    const T = top[si], f = Math.min(us.length - 1.001, Math.max(0, (t - u0) / step)), i = Math.floor(f);
    return T[i] + (T[i + 1] - T[i]) * (f - i);
  };
  const ashlar = (p0, p1, y0, y1, n, seed) => {
    // 切石の目地（幅 1.2 m・高さ 0.55 m の石を半分ずつずらして積む。石ごとに色を少し変える）
    const Lw = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d = [(p1[0] - p0[0]) / Lw, (p1[1] - p0[1]) / Lw];
    const rows = Math.max(1, Math.round((y1 - y0) / 0.55));
    for (let r = 0; r < rows; r++) {
      const ya = y0 + ((y1 - y0) * r) / rows, yb = y0 + ((y1 - y0) * (r + 1)) / rows;
      const off = r % 2 ? 0.6 : 0;
      for (let s0 = -off; s0 < Lw; s0 += 1.2) {
        const sa = Math.max(0, s0), sb = Math.min(Lw, s0 + 1.2);
        if (sb - sa < 0.05) continue;
        const c = STONE[Math.floor(hash01(seed + r * 131 + Math.round(s0 * 10), 41) * STONE.length)];
        const A = [p0[0] + d[0] * sa, p0[1] + d[1] * sa], B = [p0[0] + d[0] * sb, p0[1] + d[1] * sb];
        w.quad([A[0], ya + 0.02, A[1]], [B[0], ya + 0.02, B[1]], [B[0], yb, B[1]], [A[0], yb, A[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
      }
      w.quad([p0[0], ya, p0[1]], [p1[0], ya, p1[1]], [p1[0], ya + 0.02, p1[1]], [p0[0], ya + 0.02, p0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#8d877c'));
    }
  };
  const yBot = yw - 0.4;
  // 長い側の壁（内向き）と笠石、地面の切り抜き
  for (let k = 0; k + 1 < us.length; k++) {
    const t0 = us[k], t1 = us[k + 1];
    for (const [si, sd] of [[0, -1], [1, 1]]) {
      const p0 = P(t0, sd * hw), p1 = P(t1, sd * hw), yt = Math.min(top[si][k], top[si][k + 1]);
      const n = [-v[0] * sd, 0, -v[1] * sd];
      ashlar(sd < 0 ? p0 : p1, sd < 0 ? p1 : p0, yBot, yt, n, k * 7 + si * 3);
      // 笠石（幅 0.9 m の淡い花崗岩。上の面と、外側の面を 1.2 m 下ろす）と、壁の上の端（切石の上から笠石まで）
      const y0 = top[si][k] + 0.1, y1 = top[si][k + 1] + 0.1, o0 = P(t0, sd * (hw + 0.9)), o1 = P(t1, sd * (hw + 0.9));
      const up = sd < 0 ? [p0, p1, o1, o0] : [p1, p0, o0, o1], ys = sd < 0 ? [y0, y1, y1, y0] : [y1, y0, y0, y1];
      w.quad(...up.map((q, i) => [q[0], ys[i], q[1]]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
      const on = [v[0] * sd, 0, v[1] * sd], [e0, e1, f0, f1] = sd < 0 ? [o1, o0, y1, y0] : [o0, o1, y0, y1];
      // 外側の面: 上の 0.3 m は笠石、その下は地面の下まで切石
      const yg = Math.min(edge[si][k], edge[si][k + 1]) - 0.3;
      w.quad([e0[0], f0 - 0.3, e0[1]], [e1[0], f1 - 0.3, e1[1]], [e1[0], f1, e1[1]], [e0[0], f0, e0[1]], on, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
      if (yg < Math.min(f0, f1) - 0.3) ashlar(e0, e1, yg, Math.min(f0, f1) - 0.3, on, 501 + k * 5 + si);
      const [g0, g1, h0, h1] = sd < 0 ? [p0, p1, y0, y1] : [p1, p0, y1, y0];
      w.quad([g0[0], yt, g0[1]], [g1[0], yt, g1[1]], [g1[0], h1, g1[1]], [g0[0], h0, g0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
    }
    // 水面と、地面の切り抜き（閘室の上の面。上向き）
    const A = P(t0, -hw), B = P(t1, -hw), C = P(t1, hw), D = P(t0, hw);
    w.quad([A[0], yw, A[1]], [D[0], yw, D[1]], [C[0], yw, C[1]], [B[0], yw, B[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, WATER);
    const yA = top[0][k] + 0.1, yB = top[0][k + 1] + 0.1, yC = top[1][k + 1] + 0.1, yD = top[1][k] + 0.1;
    W.mask.quad([A[0], yA, A[1]], [D[0], yD, D[1]], [C[0], yC, C[1]], [B[0], yB, B[1]], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], WHITE);
  }
  // 両端: 下流は石の壁、上流（運河の側）は錆色の扉（上の 0.5 m は石）
  for (const [t, sg, gate] of [[u0, 1, false], [u1, -1, true]]) {
    const yt = Math.min(topAt(0, t), topAt(1, t));
    const p0 = P(t, -hw), p1 = P(t, hw), n = [u[0] * sg, 0, u[1] * sg];
    if (gate) {
      const c = P(t, 0);
      box(w, [c[0], (yBot + yt - 0.5) / 2, c[1]], [v[0] * hw, 0, v[1] * hw], [0, (yt - 0.5 - yBot) / 2, 0], [u[0] * 0.15, 0, u[1] * 0.15], GATE);
      // 扉の縦の補強（1.1 m ごと）
      for (let k = -2; k <= 2; k++) {
        const q = P(t - sg * 0.18, k * 1.1);
        box(w, [q[0], (yBot + yt - 0.5) / 2, q[1]], [v[0] * 0.06, 0, v[1] * 0.06], [0, (yt - 0.5 - yBot) / 2, 0], [u[0] * 0.04, 0, u[1] * 0.04], col('#6e5048'));
      }
      ashlar(sg > 0 ? p1 : p0, sg > 0 ? p0 : p1, yt - 0.5, yt, n, 991);
    } else ashlar(sg > 0 ? p1 : p0, sg > 0 ? p0 : p1, yBot, yt, n, 977);
    const q = P(t - sg * 0.45, 0);
    box(w, [q[0], yt - 0.45, q[1]], [v[0] * (hw + 0.9), 0, v[1] * (hw + 0.9)], [0, 0.55, 0], [u[0] * 0.45, 0, u[1] * 0.45], COPING);
  }
  // 鋼の柵（高さ 1.1 m。2 m ごとの柱、上下の横桟、X の筋交いと交点の丸い飾り）
  const rail = (p0, p1, y0f, y1f) => {
    const Lr = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d = [(p1[0] - p0[0]) / Lr, (p1[1] - p0[1]) / Lr], nn = [-d[1] * 0.025, 0, d[0] * 0.025];
    const n = Math.max(1, Math.round(Lr / 2));
    for (let k = 0; k <= n; k++) {
      const f = k / n, q = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f], y = y0f + (y1f - y0f) * f;
      box(mt, [q[0], y + 0.55, q[1]], [0.035, 0, 0], [0, 0.55, 0], [0, 0, 0.035], IRON);
    }
    for (const h of [0.08, 1.08]) {
      box(mt, [(p0[0] + p1[0]) / 2, (y0f + y1f) / 2 + h, (p0[1] + p1[1]) / 2], [(p1[0] - p0[0]) / 2, (y1f - y0f) / 2, (p1[1] - p0[1]) / 2], [0, 0.025, 0], nn, IRON);
    }
    for (let k = 0; k < n; k++) {
      const f0 = k / n, f1 = (k + 1) / n;
      const A = [p0[0] + (p1[0] - p0[0]) * f0, y0f + (y1f - y0f) * f0, p0[1] + (p1[1] - p0[1]) * f0];
      const B = [p0[0] + (p1[0] - p0[0]) * f1, y0f + (y1f - y0f) * f1, p0[1] + (p1[1] - p0[1]) * f1];
      for (const [ya, yb] of [[0.1, 1.06], [1.06, 0.1]]) {
        const c = [(A[0] + B[0]) / 2, (A[1] + B[1] + ya + yb) / 2, (A[2] + B[2]) / 2];
        box(mt, c, [(B[0] - A[0]) / 2, (B[1] + yb - A[1] - ya) / 2, (B[2] - A[2]) / 2], [0, 0.018, 0], nn, IRON);
      }
      const c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 + 0.58, (A[2] + B[2]) / 2];
      box(mt, c, [d[0] * 0.07, 0, d[1] * 0.07], [0, 0.07, 0], [nn[0] * 1.6, 0, nn[2] * 1.6], IRON);
    }
    colliders.push([p0[0], p0[1], p1[0], p1[1]]);
  };
  for (const [si, sd] of [[0, -1], [1, 1]]) {
    for (let k = 0; k + 1 < us.length; k++) rail(P(us[k], sd * (hw + 0.3)), P(us[k + 1], sd * (hw + 0.3)), top[si][k] + 0.1, top[si][k + 1] + 0.1);
  }
  rail(P(u0 - 0.3, -(hw + 0.3)), P(u0 - 0.3, hw + 0.3), topAt(0, u0) + 0.1, topAt(1, u0) + 0.1);
  // 上流の扉の上の歩道橋（幅 2 m、格子の床、両側に柵）
  const yd = Math.max(topAt(0, u1), topAt(1, u1)) + 0.15;
  const c = P(u1 - 1, 0);
  box(mt, [c[0], yd, c[1]], [u[0] * 1, 0, u[1] * 1], [0, 0.08, 0], [v[0] * (hw + 0.9), 0, v[1] * (hw + 0.9)], GRATE);
  for (const sd of [-1, 1]) {
    const q = P(u1 - 1 - sd * 0.97, 0), e = [v[0] * (hw + 0.9), v[1] * (hw + 0.9)];
    rail([q[0] - e[0], q[1] - e[1]], [q[0] + e[0], q[1] + e[1]], yd, yd);
  }
}

// ---- 入市税の門の小屋: 淡い石の平屋（台座・角の付け柱・軒の蛇腹）、正面（f の向き）に三角の破風と頂の壺の飾り、
// 戸口と、横の壁のめくら窓
function writePavilion(m, W, groundAt, colliders) {
  const w = W.main;
  const { x, z, f, h: H } = m, [wd, dp] = m.size, a = wd / 2, b = dp / 2;
  const s = [-f[1], f[0]];
  const P2 = (u, v) => [x + f[0] * u + s[0] * v, z + f[1] * u + s[1] * v];
  let y0 = Infinity;
  for (const [u, v] of [[-b, -a], [b, -a], [b, a], [-b, a]]) y0 = Math.min(y0, groundAt(...P2(u, v)));
  const STONE = col('#dec6a0'), SHADE = col('#ccb48f'), DARK = col('#3e3a36'), CORN = col('#e6d2b0');
  const B = (u, v, y, hu, hv, hy, c) => {
    const p = P2(u, v);
    box(w, [p[0], y, p[1]], [f[0] * hu, 0, f[1] * hu], [0, hy, 0], [s[0] * hv, 0, s[1] * hv], c);
  };
  B(0, 0, y0 + 0.1, b + 0.15, a + 0.15, 0.45, SHADE); // 台座
  B(0, 0, y0 + H / 2, b, a, H / 2, STONE); // 壁
  for (const su of [-1, 1]) for (const sv of [-1, 1]) B(su * (b - 0.2), sv * (a - 0.2), y0 + H / 2, 0.28, 0.28, H / 2, CORN); // 角の付け柱
  B(0, 0, y0 + H + 0.18, b + 0.3, a + 0.3, 0.18, CORN); // 軒の蛇腹
  B(0, 0, y0 + H + 0.5, b, a, 0.14, SHADE); // 屋上の縁
  // 正面の三角の破風（奥行き 0.5 m の三角柱）と頂の壺
  const ph = 1.25, y1 = y0 + H + 0.36;
  for (const du of [b + 0.3, b - 0.2]) {
    const o = P2(du, 0);
    vpoly(w, o, s, [[-(a + 0.3), y1], [a + 0.3, y1], [0, y1 + ph]], [f[0] * Math.sign(du - b + 0.05), 0, f[1] * Math.sign(du - b + 0.05)], CORN);
  }
  const sl = Math.hypot(a + 0.3, ph);
  for (const sv of [-1, 1]) {
    const e0 = P2(b + 0.3, sv * (a + 0.3)), e1 = P2(b - 0.2, sv * (a + 0.3)), t0 = P2(b + 0.3, 0), t1 = P2(b - 0.2, 0);
    const n = [s[0] * sv * (ph / sl), (a + 0.3) / sl, s[1] * sv * (ph / sl)];
    w.quad([e0[0], y1, e0[1]], [e1[0], y1, e1[1]], [t1[0], y1 + ph, t1[1]], [t0[0], y1 + ph, t0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SHADE);
  }
  const u0 = P2(b + 0.05, 0);
  cylinder(w, u0[0], u0[1], 0.14, 0.2, y1 + ph, y1 + ph + 0.25, { seg: 10, color: CORN });
  cylinder(w, u0[0], u0[1], 0.26, 0.14, y1 + ph + 0.25, y1 + ph + 0.7, { seg: 10, color: CORN });
  annulus(w, u0[0], u0[1], 0, 0.14, y1 + ph + 0.7, 10, CORN);
  // 戸口（正面）とめくら窓（横）
  B(b + 0.02, 0, y0 + 0.55 + 1.25, 0.04, 0.65, 1.25, DARK);
  for (const sv of [-1, 1]) B(0, sv * (a + 0.02), y0 + 2.2, 0.6, 0.04, 1.0, SHADE);
  const C = [[-b, -a], [b, -a], [b, a], [-b, a]].map(([u, v]) => P2(u, v));
  for (let i = 0; i < 4; i++) colliders.push([...C[i], ...C[(i + 1) % 4]]);
}

// ---- 係船柱の列: 白い短い円柱に丸い頭
function writeBollards(m, W, groundAt, colliders) {
  const WHITE_B = col('#e8e7e2');
  for (let i = 0; i + 1 < m.pts.length; i++) {
    const [ax, az] = m.pts[i], [bx, bz] = m.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
    for (let t = m.step / 2; t < L; t += m.step) {
      const x = ax + ((bx - ax) * t) / L, z = az + ((bz - az) * t) / L, g = groundAt(x, z);
      cylinder(W.main, x, z, 0.17, 0.17, g - 0.1, g + 0.42, { seg: 10, color: WHITE_B });
      cylinder(W.main, x, z, 0.17, 0.06, g + 0.42, g + 0.55, { seg: 10, color: WHITE_B });
      colliders.push([x - 0.17, z, x + 0.17, z], [x, z - 0.17, x, z + 0.17]);
    }
  }
}

// ---- 病院の門: 長い塀（四角い開口・瓦の笠）と北の端のレンガのアーチの通り抜け・瓦のひさし、門柱と鉄の柵
function writeHospitalGate(m, W, groundAt, colliders) {
  const w = W.main;
  const RENDER = col('#e4d8bd'), SHADE = col('#d4c6a8'), TILE = col('#b0644a'), BRICK = [col('#a9563e'), col('#b8654a')], WOOD = col('#5b4030'), PILLAR = col('#ece7da'), GREEN = col('#a7cfbb');
  const [ax, az] = m.a, [bx, bz] = m.b, L = Math.hypot(bx - ax, bz - az);
  const u = [(bx - ax) / L, (bz - az) / L];
  let n = [-u[1], u[0]];
  if ((m.face[0] - ax) * n[0] + (m.face[1] - az) * n[1] < 0) n = [-n[0], -n[1]]; // 表（道の側）
  const P2 = (s, t) => [ax + u[0] * s + n[0] * t, az + u[1] * s + n[1] * t];
  let y0 = Infinity;
  for (let s = 0; s <= L; s += 2) y0 = Math.min(y0, groundAt(...P2(s, 0)));
  const T = 0.5, H = 3.6, HG = 5.0; // 塀の厚さ・高さ、アーチの所の高さ
  // 塀の一片（s0〜s1、高さ ya〜yb）
  const piece = (s0, s1, ya, yb, c = RENDER) => {
    const p = P2((s0 + s1) / 2, 0);
    box(w, [p[0], y0 + (ya + yb) / 2, p[1]], [u[0] * (s1 - s0) / 2, 0, u[1] * (s1 - s0) / 2], [0, (yb - ya) / 2, 0], [n[0] * T / 2, 0, n[1] * T / 2], c);
  };
  const sa = (m.arch[0] - ax) * u[0] + (m.arch[1] - az) * u[1]; // アーチの中心
  const R = 1.6, SPRING = 2.3, PW = 1.2; // アーチの半径・起拱点の高さ・脇の柱の幅
  // アーチの部分: 両脇の柱、アーチの上の壁（縦の細い帯で半円の開口を作る）、レンガの迫石の輪
  piece(sa - R - PW, sa - R, -0.3, HG);
  piece(sa + R, sa + R + PW, -0.3, HG);
  const NS = 16;
  for (let k = 0; k < NS; k++) {
    const x0 = -R + (2 * R * k) / NS, x1 = -R + (2 * R * (k + 1)) / NS, xm = (x0 + x1) / 2;
    piece(sa + x0, sa + x1, SPRING + Math.sqrt(Math.max(0, R * R - xm * xm)), HG);
  }
  for (let k = 0; k < 15; k++) {
    const t0 = Math.PI - (Math.PI * k) / 15, t1 = Math.PI - (Math.PI * (k + 1)) / 15, tm = (t0 + t1) / 2;
    const r = R + 0.18, cxp = sa + Math.cos(tm) * r, cy = SPRING + Math.sin(tm) * r;
    const p = P2(cxp, 0), half = (R * (t0 - t1)) / 2 + 0.03;
    box(w, [p[0], y0 + cy, p[1]], [u[0] * -Math.sin(tm) * half, Math.cos(tm) * half, u[1] * -Math.sin(tm) * half], [u[0] * Math.cos(tm) * 0.2, Math.sin(tm) * 0.2, u[1] * Math.cos(tm) * 0.2], [n[0] * (T / 2 + 0.03), 0, n[1] * (T / 2 + 0.03)], BRICK[k % 2]);
  }
  // 瓦の切妻のひさし（表へ 1.4 m）と木の持ち送り
  {
    const hw = R + PW, eave = HG - 0.9, ridge = HG + 0.1, out = 1.4;
    const Q = (s, t, y) => { const p = P2(sa + s, t); return [p[0], y0 + y, p[1]]; };
    for (const sd of [-1, 1]) {
      const nrm = [u[0] * sd * 0.7, 0.7, u[1] * sd * 0.7];
      w.quad(Q(sd * hw, T / 2, eave), Q(sd * hw, out, eave), Q(0, out, ridge), Q(0, T / 2, ridge), nrm, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
      w.quad(Q(0, T / 2, ridge), Q(0, out, ridge), Q(sd * hw, out, eave), Q(sd * hw, T / 2, eave), [-nrm[0], -nrm[1], -nrm[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, WOOD);
    }
    vpoly(w, P2(sa, out), u, [[-hw, y0 + eave], [hw, y0 + eave], [0, y0 + ridge]], [n[0], 0, n[1]], SHADE);
    for (const sd of [-1, 1]) {
      const p = P2(sa + sd * (hw - 0.25), out / 2 + T / 4);
      box(w, [p[0], y0 + eave - 0.35, p[1]], [n[0] * (out / 2), -0.3, n[1] * (out / 2)], [0, 0.07, 0], [u[0] * 0.07, 0, u[1] * 0.07], WOOD);
    }
  }
  // 長い塀: アーチの北は無地、南は 3.4 m おきに四角い開口（幅 1.7 m・高さ 1.2〜2.8 m）
  piece(0, sa - R - PW, -0.3, H);
  let s = sa + R + PW;
  const winW = 1.7;
  while (s < L - 0.5) {
    const s1 = Math.min(L, s + 3.4);
    const w0 = s + (s1 - s - winW) / 2;
    if (s1 - s > winW + 0.8) {
      piece(s, w0, -0.3, H);
      piece(w0, w0 + winW, -0.3, 1.2);
      piece(w0, w0 + winW, 2.8, H);
      piece(w0 + winW, s1, -0.3, H);
    } else piece(s, s1, -0.3, H);
    s = s1;
  }
  // 瓦の笠
  const cap = (s0, s1, yb) => {
    const p = P2((s0 + s1) / 2, 0);
    box(w, [p[0], y0 + yb + 0.08, p[1]], [u[0] * (s1 - s0) / 2, 0, u[1] * (s1 - s0) / 2], [0, 0.08, 0], [n[0] * (T / 2 + 0.12), 0, n[1] * (T / 2 + 0.12)], TILE);
  };
  cap(0, sa - R - PW, H);
  cap(sa + R + PW, L, H);
  cap(sa - R - PW, sa + R + PW, HG);
  colliders.push([...P2(0, 0), ...P2(sa - R, 0)], [...P2(sa + R, 0), ...P2(L, 0)]);
  // 白い飾りの門柱（台座・柱・張り出した笠と丸い頂）
  for (const [px, pz] of m.pillars) {
    const g = groundAt(px, pz);
    box(w, [px, g + 0.25, pz], [0.55, 0, 0], [0, 0.25, 0], [0, 0, 0.55], PILLAR);
    box(w, [px, g + 1.9, pz], [0.4, 0, 0], [0, 1.4, 0], [0, 0, 0.4], PILLAR);
    box(w, [px, g + 3.38, pz], [0.52, 0, 0], [0, 0.1, 0], [0, 0, 0.52], PILLAR);
    cylinder(w, px, pz, 0.32, 0.12, g + 3.48, g + 4.0, { seg: 12, color: PILLAR });
    colliders.push([px - 0.4, pz - 0.4, px + 0.4, pz - 0.4], [px + 0.4, pz - 0.4, px + 0.4, pz + 0.4], [px + 0.4, pz + 0.4, px - 0.4, pz + 0.4], [px - 0.4, pz + 0.4, px - 0.4, pz - 0.4]);
  }
  // 淡い緑の鉄の柵（上と下の横棒、0.14 m おきの縦棒）
  for (let i = 0; i + 1 < m.railing.length; i++) {
    const [x0, z0] = m.railing[i], [x1, z1] = m.railing[i + 1], RL = Math.hypot(x1 - x0, z1 - z0);
    const e = [(x1 - x0) / RL, (z1 - z0) / RL], q = [-e[1], e[0]];
    const g = Math.min(groundAt(x0, z0), groundAt(x1, z1));
    for (const y of [0.15, 1.95]) box(w, [(x0 + x1) / 2, g + y, (z0 + z1) / 2], [e[0] * RL / 2, 0, e[1] * RL / 2], [0, 0.03, 0], [q[0] * 0.03, 0, q[1] * 0.03], GREEN);
    for (let t = 0.5; t < RL - 0.3; t += 0.14) box(w, [x0 + e[0] * t, g + 1.05, z0 + e[1] * t], [e[0] * 0.012, 0, e[1] * 0.012], [0, 0.95, 0], [q[0] * 0.012, 0, q[1] * 0.012], GREEN);
    colliders.push([x0, z0, x1, z1]);
  }
}

// ---- メトロのエレベーターの小屋: 細い灰色の金属の枠のガラスの箱、張り出した平らな屋根、屋根の上の黄色い M の看板
function writeLift(m, W, groundAt, colliders) {
  const { x, z, f, h: H } = m, [wd, dp] = m.size, a = wd / 2, b = dp / 2;
  const s = [-f[1], f[0]];
  const P2 = (u, v) => [x + f[0] * u + s[0] * v, z + f[1] * u + s[1] * v];
  let y0 = Infinity;
  for (const [u, v] of [[-b, -a], [b, -a], [b, a], [-b, a]]) y0 = Math.min(y0, groundAt(...P2(u, v)));
  const FRAME = col('#6c7378'), GLASS = col('#5d7480'), ROOF = col('#d4d3cf'), YELLOW = col('#f2c230'), NAVY = col('#1f2c5c'), DOOR = col('#3d4a52');
  const B = (w, u, v, y, hu, hv, hy, c) => {
    const p = P2(u, v);
    box(w, [p[0], y, p[1]], [f[0] * hu, 0, f[1] * hu], [0, hy, 0], [s[0] * hv, 0, s[1] * hv], c);
  };
  B(W.main, 0, 0, y0 + 0.06, b + 0.1, a + 0.1, 0.08, FRAME); // 床
  B(W.metal, 0, 0, y0 + H / 2, b - 0.03, a - 0.03, H / 2, GLASS); // ガラスの壁
  for (const su of [-1, 1]) for (const sv of [-1, 1]) B(W.main, su * (b - 0.04), sv * (a - 0.04), y0 + H / 2, 0.05, 0.05, H / 2, FRAME); // 角の柱
  for (const y of [0.9, H - 0.05]) {
    // 横の枠
    for (const su of [-1, 1]) B(W.main, su * (b - 0.02), 0, y0 + y, 0.03, a, 0.035, FRAME);
    for (const sv of [-1, 1]) B(W.main, 0, sv * (a - 0.02), y0 + y, b, 0.03, 0.035, FRAME);
  }
  B(W.main, b + 0.01, 0, y0 + 1.1, 0.02, 0.55, 1.05, DOOR); // 正面の扉
  B(W.main, 0, 0, y0 + H + 0.12, b + 0.35, a + 0.35, 0.12, ROOF); // 屋根
  // M の看板（屋根の上の黄色い板に紺の四角）
  const c = P2(b - 0.2, 0);
  B(W.main, b - 0.2, 0, y0 + H + 0.6, 0.06, 0.42, 0.36, YELLOW);
  box(W.main, [c[0] + f[0] * 0.07, y0 + H + 0.6, c[1] + f[1] * 0.07], [f[0] * 0.005, 0, f[1] * 0.005], [0, 0.22, 0], [s[0] * 0.22, 0, s[1] * 0.22], NAVY);
  const C = [[-b, -a], [b, -a], [b, a], [-b, a]].map(([u, v]) => P2(u, v));
  for (let i = 0; i < 4; i++) colliders.push([...C[i], ...C[(i + 1) % 4]]);
}

// ---- 騎馬像: 花崗岩の段と台座、ブロンズの馬（歩く姿）と旗を掲げた騎士
function writeEquestrian(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const w = W.main, mt = W.metal;
  const GRANITE = col('#8c8a85'), GRANITE_D = col('#7a7873'), BRONZE = col('#3d3a36');
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  const F = (h) => [c * h, 0, s * h], S = (h) => [-s * h, 0, c * h], Y = (h) => [0, h, 0];
  const at = (f, sd, y) => [x + c * f - s * sd, y, z + s * f + c * sd];
  box(w, [x, y0 + 0.15, z], F(2.2), Y(0.3), S(2.2), GRANITE_D);
  box(w, [x, y0 + 0.5, z], F(1.8), Y(0.25), S(1.8), GRANITE);
  cylinder(w, x, z, 1.75, 1.45, y0 + 0.75, y0 + 1.4, { seg: 4, color: GRANITE }); // 下の台（四角錐台）
  box(w, [x, y0 + 3.0, z], F(1.25), Y(1.6), S(1.0), GRANITE);
  box(w, [x, y0 + 4.75, z], F(1.45), Y(0.15), S(1.2), GRANITE_D); // 軒
  box(w, [x, y0 + 5.0, z], F(1.35), Y(0.1), S(1.1), GRANITE);
  const yb = y0 + 5.1;
  // 馬: 胴・首・頭・4 本の脚・尾
  blob(mt, at(0, 0, yb + 1.45), [1.15, 0.5, 0.42], -m.angle, 10, 6, () => BRONZE);
  blob(mt, at(1.05, 0, yb + 2.05), [0.45, 0.62, 0.26], -m.angle, 8, 5, () => BRONZE);
  blob(mt, at(1.45, 0, yb + 2.45), [0.42, 0.2, 0.17], -m.angle, 8, 5, () => BRONZE);
  for (const [f, sd, lift] of [[0.8, 0.22, 0.25], [0.75, -0.22, 0], [-0.8, 0.22, 0], [-0.75, -0.22, 0]]) {
    const p = at(f, sd, 0);
    cylinder(mt, p[0], p[2], 0.1, 0.07, yb + lift, yb + 1.25, { seg: 5, color: BRONZE });
  }
  blob(mt, at(-1.25, 0, yb + 1.1), [0.12, 0.5, 0.12], -m.angle, 5, 4, () => BRONZE);
  // 騎士: 脚・胴・頭、右手に高く掲げた旗竿と旗
  blob(mt, at(-0.05, 0, yb + 2.35), [0.28, 0.5, 0.3], -m.angle, 8, 5, () => BRONZE);
  blob(mt, at(0, 0, yb + 3.0), [0.14, 0.17, 0.14], 0, 6, 4, () => BRONZE);
  for (const sd of [-0.32, 0.32]) blob(mt, at(0.1, sd, yb + 1.85), [0.32, 0.12, 0.1], -m.angle, 6, 4, () => BRONZE);
  const p0 = at(0.2, 0.3, yb + 1.9), p1 = at(0.55, 0.45, yb + 4.6);
  box(mt, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], [(p1[0] - p0[0]) / 2, (p1[1] - p0[1]) / 2, (p1[2] - p0[2]) / 2], [0.03, 0, 0], [0, 0, 0.03], BRONZE); // 旗竿
  vpoly(mt, [p1[0], p1[2]], [-c, -s], [[0, p1[1] - 1.1], [0.95, p1[1] - 0.95], [0.85, p1[1] - 0.15], [0, p1[1] - 0.05]], [-s, 0, c], BRONZE);
  vpoly(mt, [p1[0], p1[2]], [-c, -s], [[0, p1[1] - 1.1], [0.95, p1[1] - 0.95], [0.85, p1[1] - 0.15], [0, p1[1] - 0.05]], [s, 0, -c], BRONZE);
  colliders.push([x, z, 2.3]);
  keepOut.push([x, z, 3]);
}

// ---- 壁泉: 淡い石の付け柱と軒、半円のニッチ、白い大理石の像、貝の形の小さな水盤と丸い縁の大きな水盤
function writeWallFountain(m, W, groundAt, colliders) {
  const { mid, n, t } = m;
  const w = W.main;
  const STONE = col('#d6d2d4'), SHADE = col('#b9b5b8'), MARBLE = col('#eceae6'), WATER = col('#53645d'), DARK = col('#6e6b6d');
  const at = (u, o) => [mid[0] + t[0] * u + n[0] * o, mid[1] + t[1] * u + n[1] * o];
  const y0 = groundAt(...at(0, 2));
  const N = [n[0], 0, n[1]];
  const T = (h) => [t[0] * h, 0, t[1] * h], O = (h) => [n[0] * h, 0, n[1] * h], Y = (h) => [0, h, 0];
  // 背の壁面・付け柱・軒
  vpoly(w, at(0, 0.05), t, [[-3, y0], [3, y0], [3, y0 + 6.2], [-3, y0 + 6.2]], N, SHADE);
  for (const u of [-2.6, 2.6]) {
    const c = at(u, 0.35);
    for (let k = 0; k < 9; k++) box(w, [c[0], y0 + 0.35 + k * 0.62, c[1]], T(0.42), Y(k % 2 ? 0.28 : 0.3), O(0.32), STONE);
  }
  const ce = at(0, 0.4);
  box(w, [ce[0], y0 + 6.0, ce[1]], T(3.2), Y(0.35), O(0.45), STONE);
  box(w, [ce[0], y0 + 6.5, ce[1]], T(3.4), Y(0.15), O(0.55), STONE);
  // 半円のニッチ（奥の暗い面と迫石の縁）
  vpoly(w, at(0, 0.08), t, archShape(3.6, 5.2, y0 + 0.6, 12), N, DARK);
  vpoly(w, at(0, 0.06), t, archShape(4.2, 5.5, y0 + 0.5, 12), N, STONE);
  // 大理石の像（立つ女性・ひざまずく女性・岩）
  blob(w, [ce[0] + n[0] * -0.05, y0 + 1.4, ce[1] + n[1] * -0.05], [1.3, 0.8, 0.45], 0, 8, 5, () => MARBLE);
  const fs = at(0.2, 0.55);
  blob(w, [fs[0], y0 + 2.9, fs[1]], [0.28, 0.85, 0.22], 0, 8, 5, () => MARBLE);
  blob(w, [fs[0], y0 + 4.0, fs[1]], [0.13, 0.16, 0.13], 0, 6, 4, () => MARBLE);
  const k2 = at(-0.9, 0.6);
  blob(w, [k2[0], y0 + 1.85, k2[1]], [0.3, 0.45, 0.25], 0, 8, 5, () => MARBLE);
  // 水盤: 貝の形の小さな水盤と、張り出した大きな水盤（丸い縁）
  const sb = at(0, 0.9);
  cylinder(w, sb[0], sb[1], 0.4, 1.2, y0 + 1.0, y0 + 1.3, { seg: 12, color: STONE });
  annulus(w, sb[0], sb[1], 0, 1.1, y0 + 1.28, 12, WATER);
  const lb = at(0, 1.6);
  cylinder(w, lb[0], lb[1], 2.4, 2.4, y0, y0 + 0.6, { seg: 20, color: STONE });
  annulus(w, lb[0], lb[1], 2.05, 2.4, y0 + 0.6, 20, MARBLE);
  annulus(w, lb[0], lb[1], 0, 2.05, y0 + 0.45, 20, WATER);
  colliders.push([lb[0], lb[1], 2.4]);
}

// ---- 歩行者の島: 東の端（a）が丸く、西の端（b）が四角い、高さ 0.2 m の石の板の島と縁石、鉄の格子 2 枚
function writeIsland(m, W, groundAt, colliders, onRoad, keepOut) {
  const { a, b, half } = m;
  const LL = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / LL, (b[1] - a[1]) / LL], v = [-u[1], u[0]];
  const L = LL * 0.3; // 石の島は東の 3 割
  const e = [a[0] + u[0] * L, a[1] + u[1] * L];
  const ring = [];
  for (let k = 0; k <= 12; k++) {
    const t = Math.PI / 2 + (k / 12) * Math.PI; // a の側の半円
    ring.push([a[0] + (u[0] * Math.cos(t) + v[0] * Math.sin(t)) * half, a[1] + (u[1] * Math.cos(t) + v[1] * Math.sin(t)) * half]);
  }
  ring.push([e[0] - v[0] * half, e[1] - v[1] * half], [e[0] + v[0] * half, e[1] + v[1] * half]);
  const y0 = groundAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), yt = y0 + 0.2;
  const w = W.main, mt = W.metal, KERB = col('#ccb696'), TOP = col('#c5b9a6'), GRATE = col('#6f6e64');
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
    const sg = signedArea(ring) > 0 ? 1 : -1;
    w.quad([p[0], y0 - 0.2, p[1]], [q[0], y0 - 0.2, q[1]], [q[0], yt, q[1]], [p[0], yt, p[1]], [(dz / l) * sg, 0, (-dx / l) * sg], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, KERB);
  }
  const tr = triangulate(ring);
  for (let i = 0; i < tr.indices.length; i += 3) {
    const [A, B, C] = [0, 1, 2].map((k) => tr.points[tr.indices[i + k]]).map((p) => [p[0], yt, p[1]]);
    w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, TOP);
  }
  const P = (s, o, y) => [a[0] + u[0] * s + v[0] * o, y, a[1] + u[1] * s + v[1] * o];
  const U = (h) => [u[0] * h, 0, u[1] * h], V = (h) => [v[0] * h, 0, v[1] * h], Y = (h) => [0, h, 0];
  for (const f of [0.35, 0.72]) box(w, P(L * f, 0, yt + 0.005), U(1.8), Y(0.005), V(1), GRATE);
  // 案内の柱（東の端の近く。白い板に暗い帯）
  box(w, P(1.2, -1.2, yt + 1.05), U(0.08), Y(1.05), V(0.45), col('#e9e7e1'));
  box(w, P(1.2, -1.2, yt + 1.95), U(0.085), Y(0.12), V(0.455), col('#3a4046'));
  // 駅の明かり取り: 低い石の腰壁の上に、鋼の枠の格子の屋根（東: 暗い青のガラス、西: 赤茶色の板と灰色のガラスが交互）
  const FRAME = col('#cfd2d2'), GLASS = col('#34465a'), GLASS2 = col('#5b6871'), RED = col('#8a4a3a'), WALL = col('#b9ab96');
  const hw = half - 1.3, yw = y0 + 0.5;
  for (const [f0, f1, kind] of [[0.32, 0.64, 'glass'], [0.66, 1.0, 'mixed']]) {
    const s0 = LL * f0, s1 = LL * f1, sm = (s0 + s1) / 2, hl = (s1 - s0) / 2;
    box(w, P(sm, 0, (y0 - 0.2 + yw) / 2), U(hl), Y((yw - y0 + 0.2) / 2), V(hw), WALL);
    box(mt, P(sm, 0, yw + 0.04), U(hl + 0.06), Y(0.04), V(hw + 0.06), FRAME);
    const nx = Math.max(3, Math.round((s1 - s0) / 2.9)), nz = 3;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const cs = s0 + ((i + 0.5) / nx) * (s1 - s0), co = -hw + ((k + 0.5) / nz) * 2 * hw;
        const c = kind === 'glass' ? ((i + k) % 5 === 0 ? GLASS2 : GLASS) : (i + k) % 2 ? RED : GLASS2;
        box(w, P(cs, co, yw + 0.1), U((s1 - s0) / nx / 2 - 0.09), Y(0.02), V(hw / nz - 0.09), c);
      }
    }
    const C = [P(s0, -hw, 0), P(s1, -hw, 0), P(s1, hw, 0), P(s0, hw, 0)];
    for (let i = 0; i < 4; i++) colliders.push([C[i][0], C[i][2], C[(i + 1) % 4][0], C[(i + 1) % 4][2]]);
  }
  // まわりの車道に路上駐車の車を置かない
  for (let s = 0; s <= LL + 1; s += 8) keepOut.push([a[0] + u[0] * s, a[1] + u[1] * s, half + 8.6]);
}

// ---- ロータリーの島: 白いコンクリートの縁石、ばら色のレンガの低い擁壁、盛り土の植え込み（低木・小さな木）、鋼の門の彫刻
function writeRoundabout(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z, radius: R } = m;
  const y0 = groundAt(x, z);
  const w = W.main, mt = W.metal;
  const KERB = col('#d8d6d0'), SOIL = col('#4a3c2c'), SHRUB = [col('#333a1b'), col('#3d4622'), col('#2c3418')], STEEL = col('#737d83');
  cylinder(w, x, z, R + 0.35, R + 0.35, y0 - 0.2, y0 + 0.15, { seg: 40, color: KERB });
  annulus(w, x, z, R, R + 0.35, y0 + 0.15, 40, KERB);
  cylinder(w, x, z, R, R, y0 + 0.15, y0 + 0.75, { seg: 40, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: col('#d6a088') });
  annulus(w, x, z, R - 0.25, R, y0 + 0.75, 40, col('#b98a72'));
  annulus(w, x, z, 0, R - 0.25, y0 + 0.65, 40, SOIL);
  // 低木の塊（縁に沿って 2 重の輪）と小さな木 3 本
  const rnd = mulberry32(4711);
  for (const [rr, n] of [[R - 1.2, 18], [R - 3.4, 11]]) {
    for (let k = 0; k < n; k++) {
      const a = ((k + rnd() * 0.5) / n) * Math.PI * 2, r = rr + (rnd() - 0.5) * 0.8;
      const sz = 0.8 + rnd() * 0.5;
      blob(w, [x + Math.cos(a) * r, y0 + 0.65 + sz * 0.7, z + Math.sin(a) * r], [sz * 1.2, sz * 0.9, sz * 1.1], rnd() * 6, 8, 5, () => SHRUB[Math.floor(rnd() * 3)]);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.6, r = R * 0.5;
    const tx = x + Math.cos(a) * r, tz = z + Math.sin(a) * r;
    cylinder(w, tx, tz, 0.13, 0.1, y0 + 0.65, y0 + 3.4, { seg: 6, color: col('#5a4e44') });
    blob(w, [tx, y0 + 5.0, tz], [2.0, 2.0, 2.0], rnd() * 6, 10, 6, () => col(['#4d5f2c', '#566a31', '#465a28'][Math.floor(rnd() * 3)]));
  }
  // 鋼の門の形の彫刻（2 本の柱と梁、断面 0.4 m 角）。向きは島の南北
  const hw = 3.5, H = 6;
  for (const sg of [-1, 1]) box(mt, [x + sg * hw, y0 + 0.65 + H / 2, z], [0.2, 0, 0], [0, H / 2, 0], [0, 0, 0.2], STEEL);
  box(mt, [x, y0 + 0.65 + H - 0.2, z], [hw + 0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.2], STEEL);
  colliders.push([x, z, R + 0.35]);
  keepOut.push([x, z, R + 0.6]);
}

// ---- 台座の上の立像（リケの像）: 花崗岩の島、2 段の台、モールディングの付いた台座、白い大理石のマントの立像
function writeStatue(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const w = W.main;
  const GRANITE = col('#acacac'), LIME = col('#d3cbbd'), LIME_D = col('#bdb4a5'), MARBLE = col('#e2ded6');
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  const ex = (h) => [c * h, 0, s * h], ez = (h) => [-s * h, 0, c * h], ey = (h) => [0, h, 0];
  // 花崗岩の島（低い円）
  cylinder(w, x, z, 6, 6, y0 - 0.3, y0 + 0.12, { seg: 28, color: GRANITE });
  annulus(w, x, z, 0, 6, y0 + 0.12, 28, GRANITE);
  // 2 段の台と台座
  const step = (half, y1, y2, color) => box(w, [x, (y1 + y2) / 2, z], ex(half), ey((y2 - y1) / 2), ez(half), color);
  step(2.1, y0 + 0.12, y0 + 0.5, LIME_D);
  step(1.8, y0 + 0.5, y0 + 0.9, LIME_D);
  step(1.55, y0 + 0.9, y0 + 1.5, LIME);
  step(1.35, y0 + 1.5, y0 + 4.6, LIME);
  step(1.55, y0 + 4.6, y0 + 5.0, LIME); // 軒のモールディング
  step(1.3, y0 + 5.0, y0 + 5.4, LIME_D);
  // 正面の銘板（暗い石）
  box(w, [x + c * 1.37, y0 + 3.0, z + s * 1.37], ex(0.03), ey(0.8), ez(0.9), col('#8d857a'));
  // 立像: 足元の台、マントの体（だ円体を 2 つ）、頭、前に出した腕
  const yb = y0 + 5.4;
  box(w, [x, yb + 0.15, z], ex(0.7), ey(0.15), ez(0.7), MARBLE);
  blob(w, [x, yb + 1.25, z], [0.55, 1.15, 0.5], -m.angle, 10, 6, () => MARBLE);
  blob(w, [x, yb + 2.35, z], [0.5, 0.55, 0.42], -m.angle, 10, 6, () => MARBLE);
  blob(w, [x, yb + 3.15, z], [0.2, 0.25, 0.2], 0, 8, 5, () => MARBLE);
  blob(w, [x + c * 0.45 + -s * 0.3, yb + 2.45, z + s * 0.45 + c * 0.3], [0.45, 0.13, 0.13], -m.angle, 8, 4, () => MARBLE);
  colliders.push([x, z, 2.3]);
  keepOut.push([x, z, 6]);
}

// ---- 戦没者記念碑の凱旋門（François Verdier）。f: 通路の向き、s: 横（門の幅）の向き
// 写真（Wikimedia Commons「Monument aux Combattants de la Haute-Garonne」の正面と側面）の寸法の比と、LiDAR の外形
// （幅 16〜17 m・奥行き 11.5 m・高さ 16 m）から: 丸いアーチではなく、太い円柱が支える門。
//   真ん中: 通路（幅 3.7 m、平らな格間の天井）をはさむ 2 枚の厚い壁（内側の面に浮き彫り）と、その前後の端に立つ 4 本の
//           大きな円柱（直径 1.3 m・柱頭まで 9.6 m）。上にエンタブラチュア（浮き彫りの帯）と、銘の板のある屋階（16 m まで）
//   両脇:   段の上の開いた列柱の翼（外の角に円柱 2 本ずつ、柱頭まで 8.9 m）と、戦場の名（FLANDRE・SOMME…）の帯のある
//           低いエンタブラチュア（11.7 m まで）。翼の屋根の上、屋階の脇に座った像が 4 体
export const MEMORIAL = {
  pass: 1.85, wall: 1.25, wallDepth: 3.4, // 通路の半分の幅、壁の厚さ、壁の奥行きの半分
  col: 0.65, colA: 3.2, colD: 4.45, colTop: 9.6, // 真ん中の円柱: 半径、横・奥行きの位置、柱頭の上
  wcol: 0.6, wcolA: 6.6, wcolD: 2.9, wcolTop: 8.9, // 翼の円柱
  half: 4.3, depth: 5.75, ent: 12.5, top: 16, // 真ん中のエンタブラチュアの半分の幅・奥行き、上端、屋階の上端
  wingA: 7.6, wingD: 4.0, wingTop: 11.7, step: 0.8, // 翼の端・奥行きの半分・上端、段の高さ
};
// ぶつかる所: 通路の両脇の壁（外形の線分）と 8 本の円柱。通路（幅 3.7 m）は通り抜けられる
export function memorialColliders(x, z, f) {
  const M = MEMORIAL, s = [-f[1], f[0]], P = (a, d) => [x + s[0] * a + f[0] * d, z + s[1] * a + f[1] * d];
  const out = [];
  for (const sg of [1, -1]) {
    const ring = [[M.pass, -M.wallDepth], [M.pass + M.wall, -M.wallDepth], [M.pass + M.wall, M.wallDepth], [M.pass, M.wallDepth]].map(([a, d]) => P(a * sg, d));
    ring.forEach((p, i) => out.push([...p, ...ring[(i + 1) % ring.length]]));
    for (const dg of [1, -1]) {
      out.push([...P(M.colA * sg, M.colD * dg), M.col + 0.1]);
      out.push([...P(M.wcolA * sg, M.wcolD * dg), M.wcol + 0.1]);
    }
  }
  return out;
}
function writeMemorial(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z, f } = m, M = MEMORIAL, s = [-f[1], f[0]];
  const y0 = groundAt(x, z), w = W.main;
  const STONE = col('#e6dcc4'), SHADE = col('#cfc3a6'), DARK = col('#a2957a'), CEIL = col('#b9ad92'), REL_A = col('#d8ccb0'), REL_B = col('#b3a587'), BASE = col('#c4baa6'), LETTER = col('#8a7c62');
  const P = (a, d) => [x + s[0] * a + f[0] * d, z + s[1] * a + f[1] * d];
  const P3 = (a, y, d) => [x + s[0] * a + f[0] * d, y0 + y, z + s[1] * a + f[1] * d];
  const ex = (h) => [s[0] * h, 0, s[1] * h], ez = (h) => [f[0] * h, 0, f[1] * h], ey = (h) => [0, h, 0];
  // 箱: 横 a0〜a1、高さ y0〜y1、奥行き d0〜d1
  const bx = (a0, a1, ya, yb, d0, d1, color, opt) => box(w, P3((a0 + a1) / 2, (ya + yb) / 2, (d0 + d1) / 2), ex(Math.abs(a1 - a0) / 2), ey((yb - ya) / 2), ez(Math.abs(d1 - d0) / 2), color, opt);
  // 円柱: 四角い台座、礎盤、柱身（上へ少し細く）、帯の飾りのある柱頭、四角い頂板
  const column = (a, d, r, top) => {
    const [cx, cz] = P(a, d);
    bx(a - r - 0.22, a + r + 0.22, 0, 0.5, d - r - 0.22, d + r + 0.22, SHADE);
    cylinder(w, cx, cz, r + 0.12, r + 0.03, y0 + 0.5, y0 + 0.85, { seg: 20, color: STONE });
    cylinder(w, cx, cz, r, r * 0.9, y0 + 0.85, y0 + top - 1.1, { seg: 20, color: STONE });
    cylinder(w, cx, cz, r * 0.94, r * 0.98, y0 + top - 1.1, y0 + top - 0.4, { seg: 20, color: REL_B }); // 柱頭の浮き彫りの帯
    cylinder(w, cx, cz, r * 0.98, r + 0.14, y0 + top - 0.4, y0 + top - 0.18, { seg: 20, color: STONE });
    bx(a - r - 0.2, a + r + 0.2, top - 0.18, top, d - r - 0.2, d + r + 0.2, STONE);
  };
  // 浮き彫りの帯（人の形を並べて表す）: 面 a0〜a1（奥行き d の面、向き sgn）か d0〜d1（横 a の面）
  const frieze = (fixed, lo, hi, ya, yb, along, sgn, label = 0) => {
    const n = Math.max(1, Math.floor((hi - lo - 0.2) / 0.5)), mid = (lo + hi) / 2;
    for (let i = 0; i < n; i++) {
      const t = lo + 0.1 + ((hi - lo - 0.2) * (i + 0.5)) / n;
      if (label && Math.abs(t - mid) < label) continue; // 真ん中の名前の板の所
      const hgt = (yb - ya) * (0.72 + 0.22 * hash01(i * 13 + Math.round(fixed * 7 + lo * 3), 9)), c = i % 2 ? REL_A : REL_B;
      if (along === 'a') bx(t - 0.17, t + 0.17, ya, ya + hgt, fixed, fixed + sgn * 0.07, c);
      else bx(fixed, fixed + sgn * 0.07, ya, ya + hgt, t - 0.17, t + 0.17, c);
    }
    if (label) {
      if (along === 'a') bx(mid - label, mid + label, ya + 0.12, yb - 0.12, fixed, fixed + sgn * 0.09, LETTER);
      else bx(fixed, fixed + sgn * 0.09, ya + 0.12, yb - 0.12, mid - label, mid + label, LETTER);
    }
  };
  // 低い石の台（広場の石畳の上の 2 段）
  bx(-M.wingA - 1.6, M.wingA + 1.6, 0, 0.1, -M.depth - 1.2, M.depth + 1.2, BASE);
  bx(-M.half - 0.4, M.half + 0.4, 0.1, 0.2, -M.depth - 0.5, M.depth + 0.5, BASE);
  for (const sg of [1, -1]) {
    // 通路の壁（腰の帯・内側の面の浮き彫りの板と刻んだ名前の板・外側の面の「GLOIRE AUX HEROS」の板と剣）
    const a0 = sg * M.pass, a1 = sg * (M.pass + M.wall);
    bx(a0, a1, 0.2, M.colTop, -M.wallDepth, M.wallDepth, STONE);
    bx(a0 - sg * 0.08, a1 + sg * 0.08, 0.2, 1.3, -M.wallDepth - 0.08, M.wallDepth + 0.08, SHADE);
    bx(a0 - sg * 0.05, a0, 2.2, 7.6, -M.wallDepth + 0.5, M.wallDepth - 0.5, REL_A);
    frieze(a0 - sg * 0.05, -M.wallDepth + 0.7, M.wallDepth - 0.7, 5.2, 7.3, 'd', -sg);
    bx(a1, a1 + sg * 0.05, 1.8, 8.3, -M.wallDepth + 0.45, M.wallDepth - 0.45, REL_A);
    bx(a1 + sg * 0.05, a1 + sg * 0.1, 7.2, 8.0, -1.6, 1.6, REL_B);
    bx(a1 + sg * 0.05, a1 + sg * 0.11, 3.4, 6.6, -0.09, 0.09, LETTER); // 剣
    bx(a1 + sg * 0.05, a1 + sg * 0.11, 5.9, 6.05, -0.4, 0.4, LETTER);
    for (const dg of [1, -1]) {
      column(sg * M.colA, dg * M.colD, M.col, M.colTop);
      column(sg * M.wcolA, dg * M.wcolD, M.wcol, M.wcolTop + M.step * 0 );
    }
    // 翼: 段（4 段）の上の床、外の円柱の上のエンタブラチュア（梁・浮き彫りの帯と戦場の名の板・軒）、平らな屋根
    const wi = sg * (M.pass + M.wall), wo = sg * M.wingA;
    for (let k = 0; k < 4; k++) {
      const g = (3 - k) * 0.32;
      bx(wi, wo + sg * g, 0.2 + k * 0.15, 0.2 + (k + 1) * 0.15, -M.wingD - g, M.wingD + g, k === 3 ? STONE : BASE);
    }
    const e0 = sg * (M.half - 0.2), e1 = sg * (M.wingA - 0.25), wd = M.wingD - 0.25;
    bx(e0, e1, M.wcolTop, M.wcolTop + 0.55, -wd, wd, STONE);
    bx(e0, e1, M.wcolTop + 0.55, M.wingTop - 0.75, -wd + 0.05, wd - 0.05, SHADE);
    for (const dg of [1, -1]) frieze(dg * (wd - 0.05), Math.min(e0, e1), Math.max(e0, e1), M.wcolTop + 0.62, M.wingTop - 0.82, 'a', dg, 1.0);
    frieze(e1 - sg * 0.05, -wd + 0.05, wd - 0.05, M.wcolTop + 0.62, M.wingTop - 0.82, 'd', sg, 1.3);
    bx(e0, e1 + sg * 0.45, M.wingTop - 0.75, M.wingTop - 0.45, -wd - 0.45, wd + 0.45, STONE); // 張り出した軒
    bx(e0, e1 + sg * 0.3, M.wingTop - 0.45, M.wingTop, -wd - 0.3, wd + 0.3, STONE, { top: SHADE });
    // 翼の天井（暗い格間）
    bx(e0, e1, M.wcolTop - 0.06, M.wcolTop, -wd, wd, CEIL);
    // 屋階の脇に座った像（前後に 1 体ずつ。ずんぐりした塊で表す）
    for (const dg of [1, -1]) {
      const sa = sg * (M.half + 0.9), sd = dg * 2.6;
      bx(sa - 0.75, sa + 0.75, M.wingTop, M.wingTop + 0.45, sd - 0.75, sd + 0.75, STONE);
      blob(w, P3(sa, M.wingTop + 1.15, sd), [0.62, 0.8, 0.62], 0, 8, 5, (i) => (i % 2 ? REL_A : SHADE));
      blob(w, P3(sa - sg * 0.1, M.wingTop + 2.0, sd), [0.36, 0.42, 0.36], 0, 8, 5, () => REL_A);
      blob(w, P3(sa + sg * 0.45, M.wingTop + 1.5, sd + dg * 0.2), [0.2, 0.75, 0.2], 0, 6, 4, () => SHADE); // 翼・旗
    }
  }
  // 真ん中のエンタブラチュア: 梁、浮き彫りの帯、張り出した軒（ライオンの頭の飾り）
  const A = M.half, Dp = M.depth - 0.35;
  bx(-A + 0.25, A - 0.25, M.colTop, M.colTop + 0.7, -Dp, Dp, STONE);
  bx(-A + 0.3, A - 0.3, M.colTop + 0.7, M.ent - 0.8, -Dp + 0.05, Dp - 0.05, SHADE);
  for (const dg of [1, -1]) frieze(dg * (Dp - 0.05), -A + 0.3, A - 0.3, M.colTop + 0.78, M.ent - 0.88, 'a', dg);
  for (const sg of [1, -1]) frieze(sg * (A - 0.3), -Dp + 0.05, Dp - 0.05, M.colTop + 0.78, M.ent - 0.88, 'd', sg, 1.2);
  bx(-A - 0.25, A + 0.25, M.ent - 0.8, M.ent - 0.45, -Dp - 0.5, Dp + 0.5, STONE);
  bx(-A - 0.1, A + 0.1, M.ent - 0.45, M.ent, -Dp - 0.35, Dp + 0.35, STONE, { top: SHADE });
  for (const dg of [1, -1]) for (const a of [-A + 0.5, A - 0.5]) bx(a - 0.18, a + 0.18, M.ent - 0.42, M.ent - 0.06, dg * (Dp + 0.35), dg * (Dp + 0.47), REL_B);
  // 通路の天井（格間: 暗い板に明るい桟）
  bx(-M.pass, M.pass, M.colTop - 0.05, M.colTop, -Dp, Dp, CEIL);
  for (let k = -2; k <= 2; k++) bx(-M.pass, M.pass, M.colTop - 0.16, M.colTop - 0.05, k * 2.1 - 0.12, k * 2.1 + 0.12, STONE);
  bx(-0.1, 0.1, M.colTop - 0.16, M.colTop - 0.05, -Dp, Dp, STONE);
  // 屋階: 無地の塊、前後に銘の板（額縁と刻んだ文字の列）、横に月桂樹の浮き彫りの板、上の軒
  const AA = 3.95, AD = M.depth - 0.9;
  bx(-AA, AA, M.ent, M.top - 0.35, -AD, AD, STONE);
  bx(-AA - 0.15, AA + 0.15, M.top - 0.35, M.top, -AD - 0.15, AD + 0.15, STONE, { top: SHADE });
  for (const dg of [1, -1]) {
    bx(-3.3, 3.3, M.ent + 0.55, M.top - 0.8, dg * AD, dg * (AD + 0.06), REL_A);
    bx(-3.45, 3.45, M.ent + 0.4, M.ent + 0.55, dg * AD, dg * (AD + 0.1), SHADE);
    bx(-3.45, 3.45, M.top - 0.8, M.top - 0.65, dg * AD, dg * (AD + 0.1), SHADE);
    // 3 行の文字（AVX COMBATTANTS / DE LA HAVTE-GARONNE / 1914 1918）: 文字の太さの小さな板の列
    const rows = [[M.top - 1.35, 2.4, 14], [M.top - 1.95, 2.9, 17], [M.top - 2.5, 1.3, 8]];
    for (const [yy, hw, n] of rows) {
      for (let i = 0; i < n; i++) {
        if (n === 8 && (i === 3 || i === 4)) continue; // 1914 と 1918 の間
        const a = -hw + ((2 * hw) * (i + 0.5)) / n;
        bx(a - (hw / n) * 0.62, a + (hw / n) * 0.62, yy, yy + 0.36, dg * (AD + 0.06), dg * (AD + 0.1), LETTER);
      }
    }
  }
  for (const sg of [1, -1]) {
    bx(sg * AA, sg * (AA + 0.06), M.ent + 0.5, M.top - 0.75, -AD + 0.6, AD - 0.6, REL_A);
    for (let k = -3; k <= 3; k++) bx(sg * (AA + 0.06), sg * (AA + 0.1), M.ent + 0.8 + Math.abs(k) * 0.12, M.top - 1.1 - Math.abs(k) * 0.12, k * 1.1 - 0.3, k * 1.1 + 0.3, REL_B);
  }
  void DARK;
  for (const c of memorialColliders(x, z, f)) colliders.push(c);
  keepOut.push([x, z, 10]);
}

// ---- 市場のハレット（サン・シプリアン）: 外形の向きの付いた箱ごとに、レンガの腰壁・鉄とガラスの窓の帯・張り出した瓦の寄棟屋根
function writeHalls(m, W, groundAt) {
  const w = W.main, mt = W.metal;
  const BRICK = col('#b8735a'), IRON = col('#9fb1b8'), GLASS = col('#3d4a52'), GLASS_L = col('#5b6b74'), TILE = col('#a5573f'), TILE_D = col('#8d4a36'), FRIEZE = col('#d9d2c4'), SOFFIT = col('#6f5446');
  for (const h of m.halls) {
    const { cx, cz, e1, e2, a, b } = h;
    let y0 = Infinity;
    for (const [x, z] of h.bld.outer) y0 = Math.min(y0, groundAt(x, z));
    y0 -= 0.1;
    const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
    const N = (du, dv) => [e1[0] * du + e2[0] * dv, 0, e1[1] * du + e2[1] * dv];
    const bx = (u0, u1, ya, yb, v0, v1, color) => box(w, P((u0 + u1) / 2, (v0 + v1) / 2, (ya + yb) / 2), [e1[0] * Math.abs(u1 - u0) / 2, 0, e1[1] * Math.abs(u1 - u0) / 2], [0, (yb - ya) / 2, 0], [e2[0] * Math.abs(v1 - v0) / 2, 0, e2[1] * Math.abs(v1 - v0) / 2], color);
    const q = (A, B, C, D, n, c, wr = w) => wr.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
    const BASE = 1.1, EAVE = 4.6, OV = 1.3, RH = Math.min(3.2, b * 0.45);
    // 腰壁と、窓の帯の奥の暗いガラス（箱の 4 面）
    bx(-a, a, 0, BASE, -b, b, BRICK);
    bx(-a + 0.15, a - 0.15, BASE, EAVE, -b + 0.15, b - 0.15, GLASS);
    // 窓の帯の鉄の枠: 4 面に、1.6 m おきの縦の柱・細い縦桟・2 本の横桟
    const faces = [[[-a, -b], [a, -b], N(0, -1)], [[a, b], [-a, b], N(0, 1)], [[-a, b], [-a, -b], N(-1, 0)], [[a, -b], [a, b], N(1, 0)]];
    for (const [[u0, v0], [u1, v1], n] of faces) {
      const L = Math.hypot(u1 - u0, v1 - v0), np = Math.max(2, Math.round(L / 1.6));
      const at = (t, y, d = 0) => P(u0 + (u1 - u0) * t + (n[0] * e1[0] + n[2] * e1[1]) * d, v0 + (v1 - v0) * t + (n[0] * e2[0] + n[2] * e2[1]) * d, y);
      for (let k = 0; k <= np; k++) {
        const t = k / np, dt = 0.07 / L;
        q(at(t - dt, BASE, 0.03), at(t + dt, BASE, 0.03), at(t + dt, EAVE, 0.03), at(t - dt, EAVE, 0.03), n, IRON, mt);
        if (k < np) {
          for (const f of [0.34, 0.67]) {
            const tt = (k + f) / np, d2 = 0.025 / L;
            q(at(tt - d2, BASE, 0.02), at(tt + d2, BASE, 0.02), at(tt + d2, EAVE, 0.02), at(tt - d2, EAVE, 0.02), n, IRON, mt);
          }
          // 明るいガラスの区画（ときどき）
          if (hash01(Math.round(u0 * 7 + v0 * 13) + k, 51) < 0.35) q(at(t + 0.1 / np, BASE + 1.6, 0.01), at(t + 0.9 / np, BASE + 1.6, 0.01), at(t + 0.9 / np, EAVE - 0.5, 0.01), at(t + 0.1 / np, EAVE - 0.5, 0.01), n, GLASS_L);
        }
      }
      for (const y of [BASE + 0.08, BASE + 1.55, EAVE - 0.45]) q(at(0, y, 0.035), at(1, y, 0.035), at(1, y + 0.08, 0.035), at(0, y + 0.08, 0.035), n, IRON, mt);
      // 軒下の淡い帯
      q(at(0, EAVE - 0.3, 0.04), at(1, EAVE - 0.3, 0.04), at(1, EAVE, 0.04), at(0, EAVE, 0.04), n, FRIEZE);
    }
    // 張り出した寄棟の瓦屋根（軒の下面も）
    const A = a + OV, B2 = b + OV, r = Math.max(0.5, a - b);
    const C = [P(-A, -B2, EAVE), P(A, -B2, EAVE), P(A, B2, EAVE), P(-A, B2, EAVE)], R1 = P(-r, 0, EAVE + RH + 0.4), R2 = P(r, 0, EAVE + RH + 0.4);
    const tq = (p1, p2, p3, p4, c) => {
      const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2], vx = p4[0] - p1[0], vy = p4[1] - p1[1], vz = p4[2] - p1[2];
      let nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      if (nn[1] < 0) nn = nn.map((t) => -t);
      const l = Math.hypot(...nn) || 1;
      q(p1, p2, p3, p4, nn.map((t) => t / l), c);
    };
    tq(C[0], C[1], R2, R1, TILE);
    tq(C[2], C[3], R1, R2, TILE);
    const tt = (p1, p2, p3, c) => {
      const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2], vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2];
      let nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      if (nn[1] < 0) nn = nn.map((t) => -t);
      const l = Math.hypot(...nn) || 1;
      w.tri(p1, p2, p3, nn.map((t) => t / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
    };
    tt(C[1], C[2], R2, TILE_D);
    tt(C[3], C[0], R1, TILE_D);
    q(C[0], C[1], C[2], C[3], [0, -1, 0], SOFFIT);
    // 長い辺の真ん中の入口の小さな切妻（両側）
    for (const sg of [1, -1]) {
      const v = sg * (b + 0.2), y1 = EAVE + 0.15, y2 = EAVE + 1.9;
      bx(-2.2, 2.2, BASE, y1, v - 0.1, v + 0.1, FRIEZE);
      tt(P(-2.6, sg * B2, y1), P(2.6, sg * B2, y1), P(0, sg * B2, y2), FRIEZE);
      tq(P(-2.6, sg * B2, y1), P(0, sg * B2, y2), P(0, sg * (b - 1), y2), P(-2.6, sg * (b - 1), y1), TILE);
      tq(P(2.6, sg * B2, y1), P(0, sg * B2, y2), P(0, sg * (b - 1), y2), P(2.6, sg * (b - 1), y1), TILE);
    }
  }
}

// ---- 南仏ゴシックの教会（ダルバード）。e1: 正面から奥へ、e2: 横。a・b: 半分の長さ・幅（外形の向きの付いた箱）
function writeGothic(m, W, groundAt) {
  const { cx, cz, e1, e2, a, b } = m, w = W.main;
  const y0 = groundAt(cx - e1[0] * (a + 2), cz - e1[1] * (a + 2)) - 0.15; // 正面の前の通りの高さ
  const BR = col('#d79e86'), BR_D = col('#b87a63'), TILE = col('#a15b45'), DARK = col('#2c2420'), STONE = col('#e6dcc6'), STONE_D = col('#cbbfa5'), WOOD = col('#7b5434');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
  const P2 = (u, v) => [cx + e1[0] * u + e2[0] * v, cz + e1[1] * u + e2[1] * v];
  const N = (du, dv) => [e1[0] * du + e2[0] * dv, 0, e1[1] * du + e2[1] * dv];
  const side = (p, q, ya, yb, n, c = BR) => wall(w, P2(...p), P2(...q), y0 + ya, y0 + yb, n, CELL.brick, BRICK_CW, BRICK_CW, c);
  const bx = (u0, u1, ya, yb, v0, v1, color) => box(w, P((u0 + u1) / 2, (v0 + v1) / 2, (ya + yb) / 2), [e1[0] * Math.abs(u1 - u0) / 2, 0, e1[1] * Math.abs(u1 - u0) / 2], [0, (yb - ya) / 2, 0], [e2[0] * Math.abs(v1 - v0) / 2, 0, e2[1] * Math.abs(v1 - v0) / 2], color);
  const q = (A, B, C, D, n, c) => w.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
  const HW = 21, HF = 31, uF = -a - 0.6; // 身廊の壁の高さ、正面の壁の高さ、正面の面
  // 身廊: 横の壁と東の壁（レンガ）、控え壁（6.5 m おき、1.3 m 張り出す）、あいだの尖頭アーチの高窓
  side([-a, -b], [a, -b], 0, HW, N(0, -1));
  side([a, b], [-a, b], 0, HW, N(0, 1));
  side([a, -b], [a, b], 0, HW, N(1, 0));
  const pier = (u, sg) => {
    const v0 = sg * b, v1 = sg * (b + 1.3), u0 = u - 0.7, u1 = u + 0.7, h = HW - 1.2;
    side([u0, v1], [u1, v1], 0, h, N(0, sg), BR_D);
    side([u0, v0], [u0, v1], 0, h, N(-1, 0), BR_D);
    side([u1, v1], [u1, v0], 0, h, N(1, 0), BR_D);
    q(P(u0, v0, h + 1.2), P(u1, v0, h + 1.2), P(u1, v1, h), P(u0, v1, h), [N(0, sg)[0] * 0.7, 0.7, N(0, sg)[2] * 0.7], TILE);
  };
  const n = Math.max(2, Math.round((2 * a - 6) / 6.5));
  for (let k = 0; k <= n; k++) {
    const u = -a + 3 + ((2 * a - 6) * k) / n;
    for (const sg of [1, -1]) pier(u, sg);
    if (k === n) continue;
    const um = -a + 3 + ((2 * a - 6) * (k + 0.5)) / n;
    for (const sg of [1, -1]) {
      const p = P2(um, sg * (b + 0.05)), nn = N(0, sg);
      vpoly(w, p, [e1[0], e1[1]], lancet(1.7, 8.5, y0 + 9), nn, DARK);
      vpoly(w, P2(um, sg * (b + 0.03)), [e1[0], e1[1]], lancet(2.2, 9.1, y0 + 8.7), nn, STONE_D);
    }
  }
  // 低い勾配の瓦屋根（正面の壁の裏から東の端まで）と東の妻
  const yr = HW + 3.6, ue = a + 0.5, us = -a + 1;
  for (const sg of [1, -1]) {
    const nn = N(0, sg * 3.6);
    nn[1] = b + 0.6;
    const l = Math.hypot(...nn);
    q(P(us, sg * (b + 0.6), HW), P(ue, sg * (b + 0.6), HW), P(ue, 0, yr), P(us, 0, yr), nn.map((t) => t / l), TILE);
  }
  w.tri(P(a, -b, HW), P(a, b, HW), P(a, 0, yr), N(1, 0), PLAIN_UV, PLAIN_UV, PLAIN_UV, BR);
  // 正面の壁（張り出した厚い壁、屋根より高い）: 前・横・後ろ・上面
  const vb = b + 0.5;
  side([uF, vb], [uF, -vb], 0, HF, N(-1, 0));
  side([uF, -vb], [-a + 0.8, -vb], 0, HF, N(0, -1));
  side([-a + 0.8, vb], [uF, vb], 0, HF, N(0, 1));
  side([-a + 0.8, -vb], [-a + 0.8, vb], HW - 0.5, HF, N(1, 0));
  q(P(uF, -vb, HF), P(-a + 0.8, -vb, HF), P(-a + 0.8, vb, HF), P(uF, vb, HF), [0, 1, 0], BR_D);
  // 上の縁: 持ち送りの帯（小さなレンガの台が 0.9 m おき）と張り出した帯、狭間の胸壁
  for (let v = -vb + 0.5; v < vb - 0.3; v += 0.9) bx(uF - 0.45, uF, HF - 1.9, HF - 1.3, v - 0.22, v + 0.22, BR_D);
  bx(uF - 0.55, uF, HF - 1.3, HF - 0.75, -vb - 0.1, vb + 0.1, BR_D);
  for (let v = -vb + 0.6; v < vb - 0.5; v += 1.8) bx(uF - 0.5, uF + 0.1, HF, HF + 0.9, v, v + 1.0, BR_D);
  // 小塔（八角形のレンガの筒に、円錐の尖塔と十字架）: 両角と真ん中
  const turret = (v, uc, yb, yt, r, spire) => {
    const [x, z] = P2(uc, v);
    cylinder(w, x, z, r, r, y0 + yb, y0 + yt, { seg: 8, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BR });
    cylinder(w, x, z, r + 0.18, r + 0.18, y0 + yt - 0.4, y0 + yt, { seg: 8, color: BR_D });
    cylinder(w, x, z, r + 0.05, 0.06, y0 + yt, y0 + yt + spire, { seg: 8, color: BR_D });
    box(w, [x, y0 + yt + spire + 0.6, z], [0.04, 0, 0], [0, 0.6, 0], [0, 0, 0.04], DARK);
    box(w, [x, y0 + yt + spire + 0.8, z], [e2[0] * 0.3, 0, e2[1] * 0.3], [0, 0.04, 0], [e1[0] * 0.04, 0, e1[1] * 0.04], DARK);
  };
  turret(-vb + 1.0, uF + 1.0, HF - 9, HF + 3.2, 1.25, 6.2);
  turret(vb - 1.0, uF + 1.0, HF - 9, HF + 3.2, 1.25, 6.2);
  turret(0.6, uF + 1.2, HF - 1, HF + 2.6, 1.0, 5.4);
  // 正面の面に描く物の座標: (v, y) → 世界（面より d m 手前）
  const F = (v, y, d = 0.02) => P(uF - d, v, y), nF = N(-1, 0);
  // 輪（面の上、半径 r0〜r1、中心 (vc, yc)、角度 t0〜t1）
  const ring = (vc, yc, r0, r1, d, color, seg = 32, t0 = 0, t1 = Math.PI * 2) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg;
      const A = F(vc + Math.cos(ta) * r1, yc + Math.sin(ta) * r1, d), B = F(vc + Math.cos(tb) * r1, yc + Math.sin(tb) * r1, d);
      if (r0 < 0.01) w.tri(F(vc, yc, d), A, B, nF, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
      else q(F(vc + Math.cos(ta) * r0, yc + Math.sin(ta) * r0, d), F(vc + Math.cos(tb) * r0, yc + Math.sin(tb) * r0, d), B, A, nF, color);
    }
  };
  const rect = (v0, v1, ya, yb, d, color) => q(F(v0, ya, d), F(v1, ya, d), F(v1, yb, d), F(v0, yb, d), nF, color);
  // バラ窓: 石の縁、暗いガラス、放射状の石の格子と内側の輪
  const RY = HF - 11, RR = 3.5;
  ring(0, RY, RR, RR + 0.55, 0.05, STONE, 40);
  ring(0, RY, 0, RR, 0.02, DARK, 40);
  ring(0, RY, 1.0, 1.3, 0.06, STONE, 24);
  ring(0, RY, 0, 0.35, 0.06, STONE, 12);
  for (let k = 0; k < 12; k++) {
    const t = (k / 12) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t), pc = -sn * 0.08, ps = c * 0.08;
    q(F(c * 1.3 + pc, RY + sn * 1.3 + ps, 0.06), F(c * 1.3 - pc, RY + sn * 1.3 - ps, 0.06), F(c * RR - pc, RY + sn * RR - ps, 0.06), F(c * RR + pc, RY + sn * RR + ps, 0.06), nF, STONE);
    ring(c * 2.45, RY + sn * 2.45, 0.42, 0.55, 0.06, STONE, 10);
  }
  // 入口（淡い石のルネサンスの枠、2 枚の木の扉、陶板の半円の浮き彫り、像の壁がん、上の飾り）
  const PW = 3.9, PE = 5.4, PT = PE + 1.0, TR = 2.85;
  bx(uF - 0.7, uF, 0, PT + 7.6, -PW, -PW + 0.95, STONE); // 両脇の柱
  bx(uF - 0.7, uF, 0, PT + 7.6, PW - 0.95, PW, STONE);
  bx(uF - 0.85, uF, 0, 0.8, -PW - 0.2, PW + 0.2, STONE_D); // 台座
  rect(-PW + 0.95, PW - 0.95, 0, PE, 0.03, STONE_D);
  rect(-2.75, -0.25, 0, PE - 0.25, 0.08, WOOD); // 扉
  rect(0.25, 2.75, 0, PE - 0.25, 0.08, WOOD);
  bx(uF - 0.45, uF, 0, PE, -0.25, 0.25, STONE); // 真ん中の柱と像
  bx(uF - 0.62, uF - 0.45, 1.6, 3.9, -0.2, 0.2, col('#f1ebdd'));
  bx(uF - 0.9, uF, PE, PT, -PW - 0.15, PW + 0.15, STONE); // 楣（まぐさ）の帯
  rect(-PW + 0.95, PW - 0.95, PT, PT + TR + 0.8, 0.03, STONE_D);
  // 陶板の半円（青い地に、真ん中の聖母と冠、両側に並ぶ人の姿。白・赤・金・緑・水色）
  ring(0, PT, 0, TR, 0.06, col('#3f63a8'), 24, 0, Math.PI);
  ring(0, PT, TR, TR + 0.5, 0.1, STONE, 24, 0, Math.PI);
  ring(0, PT, TR + 0.5, TR + 0.7, 0.07, STONE_D, 24, 0, Math.PI);
  ring(0, PT + 1.25, 0.75, 0.95, 0.09, col('#d8b14a'), 16); // 光輪
  const FIG = ['#efe9da', '#b9483e', '#d8b14a', '#4f8b5a', '#7fb0d8', '#efe9da', '#a43a52'];
  for (let k = -5; k <= 5; k++) {
    const v = k * 0.46, top = Math.sqrt(Math.max(0, (TR - 0.35) ** 2 - v * v));
    if (top < 0.6) continue;
    const ht = Math.min(top - 0.1, Math.abs(k) <= 1 ? 2.1 : 1.6);
    rect(v - 0.18, v + 0.18, PT + 0.15, PT + 0.15 + ht, 0.09, col(FIG[(k + 7) % FIG.length]));
    rect(v - 0.12, v + 0.12, PT + 0.2 + ht, PT + 0.42 + ht, 0.09, col('#e8c9a6'));
  }
  rect(-0.5, 0.5, PT + 0.15, PT + 2.3, 0.1, col('#f4efe2')); // 聖母
  rect(-0.3, 0.3, PT + 2.3, PT + 2.6, 0.1, col('#d8b14a'));
  rect(-TR, TR, PT, PT + 0.15, 0.1, col('#4f8b5a'));
  // 柱の壁がんの像（白い石、両側に 3 段）と、上の飾り（真ん中の壁がん・尖塔飾り）
  for (const sg of [1, -1]) {
    for (const y of [1.6, PT + 0.6, PT + 3.6]) {
      const v = sg * (PW - 0.48);
      bx(uF - 0.95, uF - 0.7, y, y + 1.9, v - 0.22, v + 0.22, col('#f1ebdd'));
      bx(uF - 0.98, uF - 0.7, y + 1.9, y + 2.15, v - 0.32, v + 0.32, STONE_D);
    }
    const [x, z] = P2(uF - 0.35, sg * (PW - 0.48));
    cylinder(w, x, z, 0.35, 0.05, y0 + PT + 7.6, y0 + PT + 9.3, { seg: 8, color: STONE });
  }
  bx(uF - 0.6, uF, PT + TR + 0.8, PT + TR + 3.3, -1.0, 1.0, STONE);
  bx(uF - 0.85, uF - 0.6, PT + TR + 1.1, PT + TR + 2.8, -0.3, 0.3, col('#f1ebdd'));
  const [tx, tz] = P2(uF - 0.3, 0);
  cylinder(w, tx, tz, 0.5, 0.05, y0 + PT + TR + 3.3, y0 + PT + TR + 4.6, { seg: 8, color: STONE });
}

// ---- 正面がバシリカの形の大きな建物（レ・ザバトワール）。写真（Wikimedia Commons「Les abattoirs - Musée d'art moderne de Toulouse」）:
// 真ん中の高い身廊（幅約 11.6 m、軒 10 m・棟 12.9 m）の瓦の切妻は、木の持ち送りで正面へ深く張り出す。妻の壁にレンガの大きな
// 半円アーチ（径 9.6 m、起拱 6.2 m）の窓（2 本のレンガの方立てで 3 つ）、1 階は半円アーチの 3 つのガラスの扉。両側の低い翼
// （軒 7.2 m）は、軒下の窓の帯（3 つずつ、レンガの柱の間）と 1 階の大きな盲アーチ、ほとんど平らな瓦の寄棟屋根。1 階から 3 m は
// クリーム色の漆喰、上はレンガで、5.6 m の高さにレンガの帯。横の壁（写真「Abattoirs de Toulouse 02」）は、1 階にレンガの
// アーチの窓、上に横長の窓。m: { cx, cz, e1（正面から奥へ）, e2, a（奥行きの半分）, b（幅の半分） }
function writeHall(m, W, groundAt) {
  const { cx, cz, e1, e2, a, b } = m, w = W.main;
  const y0 = groundAt(cx - e1[0] * (a + 3), cz - e1[1] * (a + 3)) - 0.1; // 正面の広場の高さ
  const BR = col('#d9876a'), BR_D = col('#bd6a50'), RENDER = col('#f3e3bd'), PLINTH = col('#d6d1c6'), TILE = col('#bf7052');
  const DARK = col('#2b3036'), FRAME = col('#3c4146'), WOOD = col('#5e3f2b');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
  const P2 = (u, v) => [cx + e1[0] * u + e2[0] * v, cz + e1[1] * u + e2[1] * v];
  const N = (du, dv) => [e1[0] * du + e2[0] * dv, 0, e1[1] * du + e2[1] * dv];
  const unit = (n) => {
    const l = Math.hypot(...n) || 1;
    return n.map((t) => t / l);
  };
  const side = (p, q2, ya, yb, n, c = BR) => wall(w, P2(...p), P2(...q2), y0 + ya, y0 + yb, n, CELL.brick, BRICK_CW, BRICK_CW, c);
  const q = (A, B, C, D, n, c) => w.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
  const bx = (u0, u1, ya, yb, v0, v1, color) => box(w, P((u0 + u1) / 2, (v0 + v1) / 2, (ya + yb) / 2), [e1[0] * Math.abs(u1 - u0) / 2, 0, e1[1] * Math.abs(u1 - u0) / 2], [0, (yb - ya) / 2, 0], [e2[0] * Math.abs(v1 - v0) / 2, 0, e2[1] * Math.abs(v1 - v0) / 2], color);
  const NV = Math.min(5.8, b * 0.38), HA = 7.2, HN = 10.0, HR = 12.9, BAND = 5.6, BASE = 3.0, YA = 8.1; // YA: 翼の屋根が身廊の壁に当たる高さ
  // ---- 壁: 翼の外の横の壁、前後の壁（翼・身廊の妻）、翼の屋根より上の身廊の横の壁
  for (const sg of [1, -1]) {
    side([-a, sg * b], [a, sg * b], 0, HA, N(0, sg));
    side([-a, sg * NV], [a, sg * NV], YA - 0.3, HN, N(0, sg));
  }
  for (const su of [-1, 1]) {
    const u = su * a, n = N(su, 0);
    side([u, -b], [u, -NV], 0, HA, n);
    side([u, NV], [u, b], 0, HA, n);
    side([u, -NV], [u, NV], 0, HN, n);
    w.tri(P(u, -NV, HN), P(u, NV, HN), P(u, 0, HR), n, PLAIN_UV, PLAIN_UV, PLAIN_UV, BR);
  }
  // ---- 身廊の切妻屋根（正面へ 1.3 m・奥へ 0.6 m・横へ 0.9 m 張り出す）と、張り出しの下の板・縁の板・木の持ち送り
  const uf = -a - 1.3, ub = a + 0.6, ve = NV + 0.9, ye = HN - 0.15, yr = HR + 0.15;
  const roofY = (v) => yr - ((yr - ye) * Math.abs(v)) / ve;
  for (const sg of [1, -1]) {
    const n = unit([...N(0, sg * (yr - ye))].map((t, i) => (i === 1 ? ve : t)));
    q(P(uf, 0, yr), P(ub, 0, yr), P(ub, sg * ve, ye), P(uf, sg * ve, ye), n, TILE);
    q(P(uf, sg * ve, ye - 0.22), P(ub, sg * ve, ye - 0.22), P(ub, 0, yr - 0.22), P(uf, 0, yr - 0.22), n.map((t) => -t), WOOD); // 裏
    q(P(uf, sg * ve, ye - 0.22), P(uf, 0, yr - 0.22), P(uf, 0, yr), P(uf, sg * ve, ye), N(-1, 0), WOOD); // 縁の板
    q(P(ub, 0, yr - 0.22), P(ub, sg * ve, ye - 0.22), P(ub, sg * ve, ye), P(ub, 0, yr), N(1, 0), WOOD);
    q(P(uf, sg * ve, ye - 0.22), P(ub, sg * ve, ye - 0.22), P(ub, sg * ve, ye), P(uf, sg * ve, ye), N(0, sg), WOOD);
    // 持ち送り（妻の縁の下に 1.5 m おき、正面の壁から張り出しの先まで）
    for (let v = 0.9; v < ve - 0.2; v += 1.5) {
      const yv = roofY(v) - 0.22;
      bx(uf + 0.15, -a, yv - 0.45, yv, sg * v - 0.11, sg * v + 0.11, WOOD);
    }
  }
  // ---- 翼の屋根（ほとんど平らな瓦の寄棟。外と前後の 3 方に 0.8 m の軒、身廊の壁に当たる）
  for (const sg of [1, -1]) {
    const vo = sg * (b + 0.8), vi = sg * NV, ue0 = -a - 0.8, ue1 = a + 0.8, run = Math.abs(vo - vi), yo = HA - 0.1;
    const top0 = ue0 + run, top1 = ue1 - run;
    const n = unit([...N(0, sg * (YA - yo))].map((t, i) => (i === 1 ? run : t)));
    q(P(ue0, vo, yo), P(ue1, vo, yo), P(top1, vi, YA), P(top0, vi, YA), n, TILE);
    const nf = unit([...N(-(YA - yo), 0)].map((t, i) => (i === 1 ? run : t))), nb = unit([...N(YA - yo, 0)].map((t, i) => (i === 1 ? run : t)));
    w.tri(P(ue0, vi, yo), P(ue0, vo, yo), P(top0, vi, YA), nf, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    w.tri(P(ue1, vo, yo), P(ue1, vi, yo), P(top1, vi, YA), nb, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    // 軒の裏（外の横と正面）
    q(P(ue0, vo, yo - 0.18), P(ue1, vo, yo - 0.18), P(ue1, sg * b, yo - 0.18), P(ue0, sg * b, yo - 0.18), [0, -1, 0], WOOD);
    q(P(ue0, vo, yo - 0.18), P(ue0, vi, yo - 0.18), P(-a, vi, yo - 0.18), P(-a, vo, yo - 0.18), [0, -1, 0], WOOD);
    q(P(ue0, vo, yo - 0.18), P(ue1, vo, yo - 0.18), P(ue1, vo, yo), P(ue0, vo, yo), N(0, sg), WOOD);
    q(P(ue0, vi, yo - 0.18), P(ue0, vo, yo - 0.18), P(ue0, vo, yo), P(ue0, vi, yo), N(-1, 0), WOOD);
  }
  // ---- 正面（u = −a）。F(v, y, d): 面より d m 手前の点
  const uF = -a, nF = N(-1, 0), sF = [e2[0], e2[1]];
  const F = (v, y, d = 0.02) => P(uF - d, v, y);
  const rect = (v0, v1, ya, yb, d, color) => q(F(v0, ya, d), F(v1, ya, d), F(v1, yb, d), F(v0, yb, d), nF, color);
  // アーチの形: 幅 wd、足元 yb から頂 yt まで（yt − yb は幅の半分以上）
  const arch = (vc, wd, yt, yb, d, color) => vpoly(w, P2(uF - d, vc), sF, archShape(wd, yt - yb, y0 + yb, 12), nF, color);
  // 腰の漆喰（3 m）と淡い石の台座、5.6 m のレンガの帯、身廊の両端の付け柱
  rect(-b, b, 0, BASE, 0.03, RENDER);
  rect(-b, b, 0, 0.45, 0.05, PLINTH);
  bx(uF - 0.22, uF, BAND - 0.15, BAND + 0.2, -b, b, BR_D);
  for (const sg of [1, -1]) bx(uF - 0.3, uF, BASE, HN, sg * NV - 0.35, sg * NV + 0.35, BR_D);
  // 1 階の 3 つの扉: レンガのアーチの縁、ガラスの扉（暗い金属の枠、扉の上の欄間）
  for (const vc of [-3.15, 0, 3.15]) {
    arch(vc, 2.85, 4.95, BASE, 0.04, BR_D);
    arch(vc, 2.25, 4.6, 0, 0.06, DARK);
    rect(vc - 1.43, vc + 1.43, BASE - 0.02, BASE + 0.08, 0.05, RENDER); // 漆喰の上の縁
    rect(vc - 1.12, vc + 1.12, 2.45, 2.6, 0.08, FRAME);
    rect(vc - 0.05, vc + 0.05, 0, 2.45, 0.08, FRAME);
    rect(vc - 1.12, vc - 1.0, 0, 3.4, 0.08, FRAME);
    rect(vc + 1.0, vc + 1.12, 0, 3.4, 0.08, FRAME);
  }
  // 翼の 1 階の大きな盲アーチ（レンガの縁と、少し奥のレンガ）と、軒下の窓の帯（3 つずつ、あいだはレンガの柱）
  for (const sg of [1, -1]) {
    const vm = sg * (NV + (b - NV) / 2);
    arch(vm, 3.9, 5.3, BASE, 0.05, BR_D);
    arch(vm, 3.2, 4.95, BASE + 0.02, 0.07, BR);
    for (let k = 0; k < 3; k++) {
      const vc = sg * (NV + 1.6 + k * ((b - NV - 3.0) / 2));
      rect(vc - 1.0, vc + 1.0, BAND + 0.3, HA - 0.25, 0.04, DARK);
      rect(vc - 1.0, vc + 1.0, BAND + 1.1, BAND + 1.18, 0.06, FRAME);
      for (const dv of [-0.33, 0.33]) rect(vc + dv - 0.03, vc + dv + 0.03, BAND + 0.3, HA - 0.25, 0.06, FRAME);
    }
  }
  // 身廊の大きな半円アーチの窓: レンガのアーチの縁（張り出す）、暗いガラス、2 本のレンガの方立て、横の桟
  const RA = 4.8, YS = 6.2;
  arch(0, 2 * (RA + 0.6), YS + RA + 0.6, BAND + 0.2, 0.12, BR_D);
  arch(0, 2 * RA, YS + RA, BAND + 0.2, 0.14, BR);
  arch(0, 2 * RA - 0.4, YS + RA - 0.2, BAND + 0.35, 0.16, DARK);
  for (const sg of [1, -1]) {
    const vm = sg * 1.6, top = YS + Math.sqrt(Math.max(0, (RA - 0.2) ** 2 - (Math.abs(vm) + 0.5) ** 2));
    bx(uF - 0.24, uF, BAND + 0.35, top, vm - 0.5, vm + 0.5, BR);
    rect(sg * 2.1, sg * (RA - 0.2), 8.3, 8.38, 0.18, FRAME);
    for (const dv of [3.0, 3.9]) {
      const v = sg * dv, tv = YS + Math.sqrt(Math.max(0, (RA - 0.2) ** 2 - dv * dv));
      rect(v - 0.03, v + 0.03, BAND + 0.35, tv, 0.18, FRAME);
    }
  }
  rect(-1.1, 1.1, 8.3, 8.38, 0.18, FRAME);
  // ---- 横の壁: 1 階のレンガのアーチの窓と、上の横長の窓（6.3 m おき）。後ろの妻にも小さなアーチの窓
  for (const sg of [1, -1]) {
    const nS = N(0, sg), sS = [e1[0], e1[1]];
    const n2 = Math.max(2, Math.round((2 * a - 6) / 6.3));
    for (let k = 0; k < n2; k++) {
      const u = -a + 3 + ((2 * a - 6) * (k + 0.5)) / n2;
      vpoly(w, P2(u, sg * (b + 0.04)), sS, archShape(3.0, 4.3, y0 + 0.4, 10), nS, BR_D);
      vpoly(w, P2(u, sg * (b + 0.06)), sS, archShape(2.4, 3.95, y0 + 0.45, 10), nS, DARK);
      const p0 = P2(u - 1.3, sg * (b + 0.05)), p1 = P2(u + 1.3, sg * (b + 0.05));
      q([p0[0], y0 + BAND, p0[1]], [p1[0], y0 + BAND, p1[1]], [p1[0], y0 + HA - 0.5, p1[1]], [p0[0], y0 + HA - 0.5, p0[1]], nS, DARK);
    }
    bx(-a, a, 0, 0.45, sg * b - 0.05, sg * (b + 0.05), PLINTH);
  }
  const nB = N(1, 0), sB = [e2[0], e2[1]];
  vpoly(w, P2(a + 0.05, 0), sB, archShape(4.6, 3.6, y0 + BAND + 0.6, 12), nB, DARK);
  for (const vc of [-3.5, 3.5]) vpoly(w, P2(a + 0.05, vc), sB, archShape(2.2, 3.8, y0 + 0.45, 10), nB, DARK);
}

// ---- 市場と駐車場の円い建物（カルム市場）: 外形 outer、高さ height
function writeMarket(m, W, groundAt) {
  const w = W.main, R0 = m.outer;
  const ccw = signedArea(R0) > 0;
  const ring = ccw ? R0 : R0.slice().reverse();
  let gx = 0, gz = 0;
  for (const [x, z] of ring) {
    gx += x;
    gz += z;
  }
  gx /= ring.length;
  gz /= ring.length;
  let y0 = Infinity;
  for (const [x, z] of ring) y0 = Math.min(y0, groundAt(x, z));
  y0 -= 0.2;
  const H = Math.max(14, Math.min(24, m.height)), GF = 4.6;
  const CON = col('#d2cec5'), CON_D = col('#b9b5ac'), DARK = col('#2a2f35'), METAL = col('#c4c8cb'), WOOD = col('#8a6342'), SHOP = col('#3b464f'), ROOF = col('#8f8e8a');
  // 辺ごとの外向きの向き（反時計回りに並べた外形の右側が外）
  const nrm = ring.map((a, i) => {
    const b2 = ring[(i + 1) % ring.length], L = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1;
    return [(b2[1] - a[1]) / L, -(b2[0] - a[0]) / L];
  });
  // 外向きが中心から離れる向きになるように（外形の向きの約束によらず）
  const s0 = Math.sign((ring[0][0] + ring[1][0]) / 2 - gx) * nrm[0][0] + Math.sign((ring[0][1] + ring[1][1]) / 2 - gz) * nrm[0][1] >= 0 ? 1 : -1;
  const out = nrm.map(([x, z]) => [x * s0, z * s0]);
  // 外形を d m 外へずらした頂点
  const off = (d) => ring.map((p, i) => {
    const a = out[(i - 1 + ring.length) % ring.length], b2 = out[i];
    let nx = a[0] + b2[0], nz = a[1] + b2[1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const c = Math.max(0.5, nx * b2[0] + nz * b2[1]);
    return [p[0] + (nx * d) / c, p[1] + (nz * d) / c];
  });
  const q = (A, B, C, D, n, c) => w.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
  // 辺ごとの縦の帯（外形 R を y0+ya〜y0+yb、外向き）
  const band = (R, ya, yb, color, inward = false) => {
    for (let i = 0; i < R.length; i++) {
      const a = R[i], b2 = R[(i + 1) % R.length], n = out[i];
      q([a[0], y0 + ya, a[1]], [b2[0], y0 + ya, b2[1]], [b2[0], y0 + yb, b2[1]], [a[0], y0 + yb, a[1]], inward ? [-n[0], 0, -n[1]] : [n[0], 0, n[1]], color);
    }
  };
  // 水平の輪（外形 A と B のあいだ、高さ y、上向きか下向き）
  const flat = (A, B, y, color, up = true) => {
    for (let i = 0; i < A.length; i++) {
      const j = (i + 1) % A.length;
      q([A[i][0], y0 + y, A[i][1]], [A[j][0], y0 + y, A[j][1]], [B[j][0], y0 + y, B[j][1]], [B[i][0], y0 + y, B[i][1]], [0, up ? 1 : -1, 0], color);
    }
  };
  const inner = off(-2.2), mid = off(-1.0), edge = off(0.18);
  // 1 階: 奥まったガラスの店先と木の帯、外形の上の柱、張り出した 2 階の床の下面
  band(inner, 0, GF - 0.7, SHOP);
  band(inner, GF - 0.7, GF, WOOD);
  flat(ring, inner, GF, CON_D, false);
  for (let i = 0; i < ring.length; i++) {
    const [x, z] = ring[i], n = out[i];
    box(w, [x - n[0] * 0.3, y0 + GF / 2, z - n[1] * 0.3], [0.28, 0, 0], [0, GF / 2, 0], [0, 0, 0.28], CON);
  }
  // 駐車場の 4 層: 床の縁のコンクリートの帯、奥の暗い壁、外のガラスの板と金属の格子（縦 1.3 m おき、横は階の真ん中）
  const nL = 4, LH = (H - 1.1 - GF) / nL;
  for (let k = 0; k < nL; k++) {
    const ya = GF + k * LH;
    band(edge, ya, ya + 0.5, CON);
    flat(edge, ring, ya + 0.5, CON, true);
    band(mid, ya + 0.5, ya + LH, DARK);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b2 = ring[(i + 1) % ring.length], n = out[i], L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
      const np = Math.max(1, Math.round(L / 1.3));
      for (let j = 0; j < np; j++) {
        const t0 = j / np, t1 = (j + 1) / np;
        const A = [a[0] + (b2[0] - a[0]) * t0 + n[0] * 0.02, a[1] + (b2[1] - a[1]) * t0 + n[1] * 0.02], B = [a[0] + (b2[0] - a[0]) * t1 + n[0] * 0.02, a[1] + (b2[1] - a[1]) * t1 + n[1] * 0.02];
        const h = hash01(i * 31 + j * 7 + k * 101, 41), g = h < 0.18 ? DARK : col(h < 0.6 ? '#7e8b96' : h < 0.85 ? '#97a3ac' : '#b2bcc2');
        q([A[0], y0 + ya + 0.5, A[1]], [B[0], y0 + ya + 0.5, B[1]], [B[0], y0 + ya + LH, B[1]], [A[0], y0 + ya + LH, A[1]], [n[0], 0, n[1]], g);
        // 縦の方立て
        const M = [A[0] + n[0] * 0.04, A[1] + n[1] * 0.04], t = [(b2[0] - a[0]) / L * 0.05, (b2[1] - a[1]) / L * 0.05];
        q([M[0] - t[0], y0 + ya + 0.5, M[1] - t[1]], [M[0] + t[0], y0 + ya + 0.5, M[1] + t[1]], [M[0] + t[0], y0 + ya + LH, M[1] + t[1]], [M[0] - t[0], y0 + ya + LH, M[1] - t[1]], [n[0], 0, n[1]], METAL);
      }
      const ym = ya + 0.5 + (LH - 0.5) * 0.48;
      const A = [a[0] + n[0] * 0.07, a[1] + n[1] * 0.07], B = [b2[0] + n[0] * 0.07, b2[1] + n[1] * 0.07];
      q([A[0], y0 + ym, A[1]], [B[0], y0 + ym, B[1]], [B[0], y0 + ym + 0.08, B[1]], [A[0], y0 + ym + 0.08, A[1]], [n[0], 0, n[1]], METAL);
    }
  }
  // 屋上（駐車場）: 床、コンクリートの胸壁（外と内の面・笠）、白い区画の線の代わりの明るい輪
  const yR = H - 1.1;
  band(edge, yR, H, CON);
  const pin = off(-0.25);
  band(pin, yR, H, CON_D, true);
  flat(edge, pin, H, CON, true);
  const { points, indices } = triangulate(pin, []);
  for (let i = 0; i < indices.length; i += 3) {
    const [A, B, C] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
    w.tri([A[0], y0 + yR, A[1]], [B[0], y0 + yR, B[1]], [C[0], y0 + yR, C[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
  }
  // 屋上の駐車場の白い区画の線（放射状）と、真ん中の円いスロープの穴（暗い穴と縁の壁）
  let rAvg = 0;
  for (const [x, z] of pin) rAvg += Math.hypot(x - gx, z - gz);
  rAvg /= pin.length;
  const rHole = rAvg * 0.3, nS = Math.round((2 * Math.PI * rAvg * 0.75) / 2.5);
  for (let k = 0; k < nS; k++) {
    const t = (k / nS) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t), pc = -sn * 0.06, ps = c * 0.06;
    for (const [r0, r1] of [[rAvg * 0.5, rAvg * 0.72], [rAvg * 0.78, rAvg - 0.6]]) {
      w.quad([gx + c * r0 + pc, y0 + yR + 0.03, gz + sn * r0 + ps], [gx + c * r1 + pc, y0 + yR + 0.03, gz + sn * r1 + ps], [gx + c * r1 - pc, y0 + yR + 0.03, gz + sn * r1 - ps], [gx + c * r0 - pc, y0 + yR + 0.03, gz + sn * r0 - ps], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#e6e4dc'));
    }
  }
  annulus(w, gx, gz, 0, rHole, y0 + yR + 0.02, 28, col('#3a3c3f'));
  cylinder(w, gx, gz, rHole + 0.25, rHole + 0.25, y0 + yR, y0 + yR + 1.0, { seg: 28, color: CON });
  annulus(w, gx, gz, rHole, rHole + 0.25, y0 + yR + 1.0, 28, CON);
  annulus(w, gx, gz, rHole * 0.35, rHole * 0.5, y0 + yR + 0.04, 20, col('#6f7377'));
  // 穴あきの金属の板の塔（南西の角の前）: 淡い灰色の箱に縦の板の目地と、上の縁
  if (m.tower) {
    const t = m.tower, ht = Math.max(6, Math.min(12, t.height));
    const yt = groundAt(t.cx, t.cz);
    box(w, [t.cx, yt + ht / 2, t.cz], [t.e1[0] * t.a, 0, t.e1[1] * t.a], [0, ht / 2, 0], [t.e2[0] * t.b, 0, t.e2[1] * t.b], col('#c9cbc8'), { top: col('#9a9c99') });
    for (const [e, ext, f, fe] of [[t.e1, t.a, t.e2, t.b], [t.e2, t.b, t.e1, t.a]]) {
      for (const sg of [1, -1]) {
        const n = Math.max(2, Math.round((2 * ext) / 1.2));
        for (let k = 1; k < n; k++) {
          const u = -ext + (2 * ext * k) / n;
          box(W.metal, [t.cx + e[0] * u + f[0] * sg * (fe + 0.02), yt + ht / 2, t.cz + e[1] * u + f[1] * sg * (fe + 0.02)], [e[0] * 0.03, 0, e[1] * 0.03], [0, ht / 2, 0], [f[0] * 0.02, 0, f[1] * 0.02], col('#8d908e'));
        }
      }
    }
  }
  // 屋上の街灯（中心のまわりに 4 本）
  for (let k = 0; k < 4; k++) {
    const t = (k / 4) * Math.PI * 2 + 0.4, r = 9;
    const x = gx + Math.cos(t) * r, z = gz + Math.sin(t) * r;
    box(W.metal, [x, y0 + yR + 3, z], [0.07, 0, 0], [0, 3, 0], [0, 0, 0.07], col('#55595d'));
    box(W.metal, [x, y0 + yR + 6.05, z], [0.35, 0, 0], [0, 0.08, 0], [0, 0, 0.15], col('#55595d'));
  }
}

// ---- 旧ニエル兵舎の本館（Maison des associations）。e1: 長い向き、e2: 奥行きの向き。a・b: 半分の長さ・奥行き
function writeBarracks(m, W, groundAt) {
  const { cx, cz, e1, e2, a, b } = m, w = W.main;
  const y0 = groundAt(cx, cz);
  const CREAM = col('#efe6d2'), STONE = col('#d9cfb8'), BRICK = col('#c2674a'), SLATE = col('#4d525b'), SLATE_D = col('#3f444c'), GLASS = col('#27303a'), TILE = col('#b5573c'), BASE = col('#b9b0a0');
  const P3 = (u, y, v) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
  const bx = (u0, u1, ya, yb, v0, v1, color, opt) => box(w, P3((u0 + u1) / 2, (ya + yb) / 2, (v0 + v1) / 2), [e1[0] * Math.abs(u1 - u0) / 2, 0, e1[1] * Math.abs(u1 - u0) / 2], [0, (yb - ya) / 2, 0], [e2[0] * Math.abs(v1 - v0) / 2, 0, e2[1] * Math.abs(v1 - v0) / 2], color, opt);
  const q = (A, B, C, D, n, color) => w.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  const F1 = 4.6, F2 = 4.4, EAVE = F1 + F2 + 0.4, MANS = 3.2; // 1 階・2 階の高さ、翼の軒、マンサードの高さ
  const PAV = Math.min(9, a * 0.25), OUT = 0.6, PEAVE = EAVE + 4.2; // 中央の棟の半分の長さ・張り出し・軒
  // 壁の塊（翼と中央の棟）、腰の石、階の帯、軒の蛇腹
  bx(-a, a, 0, EAVE, -b, b, CREAM);
  bx(-PAV, PAV, 0, PEAVE, -b - OUT, b + OUT, CREAM);
  bx(-a - 0.06, a + 0.06, 0, 0.9, -b - 0.06, b + 0.06, BASE);
  bx(-PAV - 0.06, PAV + 0.06, 0, 0.9, -b - OUT - 0.06, b + OUT + 0.06, BASE);
  bx(-a - 0.08, a + 0.08, F1 - 0.15, F1 + 0.1, -b - 0.08, b + 0.08, STONE);
  bx(-a - 0.3, a + 0.3, EAVE - 0.45, EAVE, -b - 0.3, b + 0.3, STONE);
  bx(-PAV - 0.3, PAV + 0.3, PEAVE - 0.45, PEAVE, -b - OUT - 0.3, b + OUT + 0.3, STONE);
  bx(-PAV - 0.08, PAV + 0.08, F1 + F2 - 0.05, F1 + F2 + 0.2, -b - OUT - 0.08, b + OUT + 0.08, STONE);
  // 窓: 暗いガラス、レンガと石を交互に積んだ枠（縦の両脇に 5 段）、石の窓台と楣
  const win = (u, yb, h, v, sg, wd = 1.15) => {
    const o = v + sg * 0.05;
    bx(u - wd / 2, u + wd / 2, yb, yb + h, o, o + sg * 0.03, GLASS);
    for (let k = 0; k < 5; k++) {
      const ya = yb + (h * k) / 5, c = k % 2 ? STONE : BRICK;
      bx(u - wd / 2 - 0.22, u - wd / 2, ya, ya + h / 5, v, v + sg * 0.1, c);
      bx(u + wd / 2, u + wd / 2 + 0.22, ya, ya + h / 5, v, v + sg * 0.1, c);
    }
    bx(u - wd / 2 - 0.3, u + wd / 2 + 0.3, yb - 0.16, yb, v, v + sg * 0.16, STONE);
    bx(u - wd / 2 - 0.26, u + wd / 2 + 0.26, yb + h, yb + h + 0.3, v, v + sg * 0.12, BRICK);
    bx(u - 0.14, u + 0.14, yb + h, yb + h + 0.36, v, v + sg * 0.15, STONE);
  };
  // 角のレンガと石の縞
  const quoin = (u, v, top, su, sv) => {
    for (let y = 0.9, k = 0; y < top - 0.5; y += 0.42, k++) {
      const c = k % 2 ? STONE : BRICK;
      bx(u, u - su * 0.55, y, y + 0.42, v, v + sv * 0.07, c);
      bx(u, u + su * 0.07, y, y + 0.42, v, v - sv * 0.55, c);
    }
  };
  const BAY = 3.6;
  for (const sg of [1, -1]) {
    // 翼の窓（2 階分）と屋根窓
    const v = sg * b;
    const n = Math.max(1, Math.floor((a - PAV - 1.6) / BAY));
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const u = side * (PAV + 1.8 + (a - PAV - 1.6 - 1.8) * ((i + 0.5) / n) + 0.0);
        win(u, 1.5, 2.5, v, sg);
        win(u, F1 + 1.1, 2.4, v, sg);
        // 屋根窓: レンガの脇・石の縁・小さな切妻
        const d0 = sg * (b - 0.25);
        bx(u - 0.75, u + 0.75, EAVE, EAVE + 2.1, d0, d0 - sg * 1.2, BRICK);
        bx(u - 0.5, u + 0.5, EAVE + 0.35, EAVE + 1.75, d0 + sg * 0.02, d0 + sg * 0.05, GLASS);
        bx(u - 0.9, u + 0.9, EAVE + 2.1, EAVE + 2.35, d0 + sg * 0.12, d0 - sg * 1.3, STONE);
        bx(u - 0.6, u + 0.6, EAVE + 2.35, EAVE + 2.6, d0 + sg * 0.06, d0 - sg * 1.3, STONE);
      }
      quoin(side * a, v, EAVE, side, sg);
      quoin(side * PAV, sg * (b + OUT), PEAVE, side, sg);
    }
    // 中央の棟の窓（3 階分、5 列）と入口
    for (let i = -2; i <= 2; i++) {
      const u = (i * (PAV * 2 - 3)) / 4, vv = sg * (b + OUT);
      if (i === 0) {
        bx(-0.95, 0.95, 0.2, 3.5, vv + sg * 0.05, vv + sg * 0.09, GLASS);
        bx(-1.25, 1.25, 0.2, 3.8, vv, vv + sg * 0.06, BRICK);
        bx(-1.4, 1.4, 3.8, 4.1, vv, vv + sg * 0.14, STONE);
      } else win(u, 1.5, 2.5, vv, sg);
      win(u, F1 + 1.1, 2.4, vv, sg);
      win(u, F1 + F2 + 1.0, 2.2, vv, sg);
    }
  }
  // 妻の窓
  for (const side of [1, -1]) for (const vv of [-b / 2, b / 2]) {
    const e = (u, yb, h) => {
      bx(side * a + side * 0.05, side * a + side * 0.08, yb, yb + h, vv - 0.58, vv + 0.58, GLASS);
      bx(side * a, side * a + side * 0.1, yb - 0.16, yb, vv - 0.9, vv + 0.9, STONE);
      bx(side * a, side * a + side * 0.1, yb + h, yb + h + 0.3, vv - 0.85, vv + 0.85, BRICK);
    };
    e(0, 1.5, 2.5);
    e(0, F1 + 1.1, 2.4);
  }
  // 屋根: 翼はスレートのマンサード（急な面）と上の赤い瓦のゆるい面、中央はスレートの寄棟
  const frustum = (u0, u1, v0, v1, ya, yb, inset, side, top) => {
    const A = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], B = [[u0 + inset, v0 + inset], [u1 - inset, v0 + inset], [u1 - inset, v1 - inset], [u0 + inset, v1 - inset]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4, mu = (A[i][0] + A[j][0]) / 2 - (u0 + u1) / 2, mv = (A[i][1] + A[j][1]) / 2 - (v0 + v1) / 2, l = Math.hypot(mu, mv) || 1;
      const n = [(e1[0] * mu + e2[0] * mv) / l * 0.8, 0.6, (e1[1] * mu + e2[1] * mv) / l * 0.8];
      q(P3(A[i][0], ya, A[i][1]), P3(A[j][0], ya, A[j][1]), P3(B[j][0], yb, B[j][1]), P3(B[i][0], yb, B[i][1]), n, side);
    }
    q(P3(B[0][0], yb, B[0][1]), P3(B[1][0], yb, B[1][1]), P3(B[2][0], yb, B[2][1]), P3(B[3][0], yb, B[3][1]), [0, 1, 0], top);
    return B;
  };
  for (const side of [1, -1]) {
    const u0 = side > 0 ? PAV : -a, u1 = side > 0 ? a : -PAV;
    frustum(u0, u1, -b, b, EAVE, EAVE + MANS, 1.3, SLATE, TILE);
    // 上のゆるい瓦の屋根（低い寄棟）
    frustum(u0 + 1.3, u1 - 1.3, -b + 1.3, b - 1.3, EAVE + MANS, EAVE + MANS + 1.1, Math.min(b - 1.6, 4.5), TILE, TILE);
    // 煙突（赤レンガ、石の笠）
    for (const t of [0.2, 0.5, 0.8]) {
      const u = u0 + (u1 - u0) * t;
      for (const vv of [-b + 2.2, b - 2.2]) {
        bx(u - 0.7, u + 0.7, EAVE + MANS - 0.4, EAVE + MANS + 2.4, vv - 0.4, vv + 0.4, BRICK);
        bx(u - 0.8, u + 0.8, EAVE + MANS + 2.4, EAVE + MANS + 2.6, vv - 0.5, vv + 0.5, STONE);
      }
    }
  }
  frustum(-PAV - 0.2, PAV + 0.2, -b - OUT - 0.2, b + OUT + 0.2, PEAVE, PEAVE + 4.2, Math.min(PAV, b + OUT) - 1.2, SLATE, SLATE_D);
  for (const u of [-PAV + 1.2, PAV - 1.2]) {
    bx(u - 0.6, u + 0.6, PEAVE + 0.5, PEAVE + 5.4, -0.9, 0.9, BRICK);
    bx(u - 0.7, u + 0.7, PEAVE + 5.4, PEAVE + 5.6, -1.0, 1.0, STONE);
  }
}

// ---- 店の並ぶ通りの建物の正面の飾り（Rue de la République）
// 窓の並びは buildings.js の writeWalls と同じ: 辺の真ん中から FACADE_BAY m ごとの窓の列、1 階の高さは max(3.4, 階高 × 1.15)、
// 上の階の窓は階の床から階高の 0.13〜0.83
const FACADE_BAY = 3.5;
const AWNING = ['#7b1f24', '#1f4a3a', '#2a3550', '#a8782a', '#5a2d42', '#8c3b1e', '#34312e', '#6e7f3a'];
const SIGN = ['#b4242a', '#2a7a3a', '#d9b232', '#24508f', '#e8e6e0', '#c2571f', '#6a2a6e'];
function writeShopstreet(m, W, groundAt) {
  const w = W.main, mt = W.metal;
  const IRON = col('#26272a'), ZINC = col('#5d6266'), SILL = col('#d8d0c2');
  const pipes = []; // 立てた縦樋 [x, z]（隣の家の縦樋と 1.2 m 以内に 2 本並べない。境の 1 本を共有する）
  for (const f of m.fronts) {
    const { a, n, L, b } = f;
    const u = [(f.c[0] - a[0]) / L, (f.c[1] - a[1]) / L];
    const base = b.terrainBase ?? groundAt(a[0] + n[0], a[1] + n[1]);
    const H = b.info.height, fh = b.info.floorHeight, gh = Math.max(3.4, fh * 1.15);
    // 建物と辺ごとの乱数（hash01 は整数の種。建物の id はタイルごとの番号なので、建物の中の点の位置から作る）
    const seed = (Math.imul(Math.round(b.inside[0] * 10), 73856093) ^ Math.imul(Math.round(b.inside[1] * 10), 19349663) ^ Math.imul(f.i + 1, 83492791)) | 0;
    const r = (k) => hash01(seed, k);
    const P = (t, o, y) => [a[0] + u[0] * t + n[0] * o, y, a[1] + u[1] * t + n[1] * o];
    const U = (h) => [u[0] * h, 0, u[1] * h], N = (h) => [n[0] * h, 0, n[1] * h], Y = (h) => [0, h, 0];
    // 亜鉛の縦樋（正面の両端。軒の下の受け口から地面まで）
    for (const t of [0.25, L - 0.25]) {
      const p = P(t, 0.12, 0);
      if (pipes.some(([x, z]) => Math.hypot(x - p[0], z - p[2]) < 1.2)) continue;
      pipes.push([p[0], p[2]]);
      cylinder(mt, p[0], p[2], 0.05, 0.05, base, base + H - 0.35, { seg: 6, color: ZINC });
      box(mt, P(t, 0.14, base + H - 0.25), U(0.12), Y(0.1), N(0.1), ZINC);
    }
    // 窓の列（辺の真ん中から FACADE_BAY m ごと。端から 0.9 m 以内は除く）
    const bays = [];
    for (let k = -Math.floor(L / 2 / FACADE_BAY); k <= Math.floor(L / 2 / FACADE_BAY); k++) {
      const t = L / 2 + k * FACADE_BAY;
      if (t > 0.9 && t < L - 0.9) bays.push(t);
    }
    if (!bays.length) continue;
    const yb = base + gh;
    // 1 階の店の日よけ（建物の 4 割。続いた 1〜3 列、布の色は建物ごと）。斜めの布と前の垂れ、両脇の三角
    if (r(1) < 0.4) {
      const color = col(AWNING[Math.floor(r(2) * AWNING.length)]);
      const k0 = Math.floor(r(3) * bays.length), k1 = Math.min(bays.length, k0 + 1 + Math.floor(r(4) * 3));
      for (let k = k0; k < k1; k++) {
        const t = bays[k], hw = FACADE_BAY / 2 - 0.3, ya = yb - 0.35, yo = yb - 0.95, d = 1.15;
        const q = [P(t - hw, 0.05, ya), P(t + hw, 0.05, ya), P(t + hw, d, yo), P(t - hw, d, yo)];
        const ny = [n[0] * 0.5, 1, n[1] * 0.5];
        w.quad(q[0], q[1], q[2], q[3], ny, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
        w.quad(q[3], q[2], q[1], q[0], [-ny[0], -1, -ny[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
        const v = [P(t - hw, d, yo), P(t + hw, d, yo), P(t + hw, d, yo - 0.25), P(t - hw, d, yo - 0.25)];
        w.quad(v[0], v[1], v[2], v[3], [n[0], 0, n[1]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
        w.quad(v[3], v[2], v[1], v[0], [-n[0], 0, -n[1]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
        for (const sd of [-1, 1]) {
          const A = P(t + sd * hw, 0.05, ya), B = P(t + sd * hw, d, yo), C = P(t + sd * hw, d, yo - 0.25);
          w.tri(A, B, C, [u[0] * sd, 0, u[1] * sd], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
          w.tri(A, C, B, [-u[0] * sd, 0, -u[1] * sd], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
        }
      }
    }
    // 店の上の横長の看板（日よけのない建物の半分。1〜2 列にまたがる色の板と、白っぽい文字の帯）
    if (r(1) >= 0.4 && r(11) < 0.55) {
      const k0 = Math.floor(r(12) * bays.length), k1 = Math.min(bays.length - 1, k0 + (r(13) < 0.4 ? 1 : 0));
      const t0 = bays[k0] - FACADE_BAY * 0.38, t1 = bays[k1] + FACADE_BAY * 0.38, tm = (t0 + t1) / 2, hl = (t1 - t0) / 2;
      const color = col(SIGN[Math.floor(r(14) * SIGN.length)]);
      box(w, P(tm, 0.06, yb - 0.32), U(hl), Y(0.24), N(0.05), color);
      box(w, P(tm, 0.12, yb - 0.32), U(hl * 0.62), Y(0.07), N(0.01), r(15) < 0.5 ? col('#f4f1e8') : col('#2a2a2a'));
    }
    // 吊り看板（建物の 4 割。窓の列のあいだ、1 階の上）: 鉄の腕と、壁に直角な色の板（両面に白い文字の帯）
    if (r(5) < 0.4) {
      const t = Math.min(L - 0.6, Math.max(0.6, bays[Math.floor(r(6) * bays.length)] + FACADE_BAY / 2 * (r(7) < 0.5 ? -1 : 1)));
      const y = yb + 0.55, color = col(SIGN[Math.floor(r(8) * SIGN.length)]);
      box(mt, P(t, 0.45, y + 0.42), N(0.45), Y(0.025), U(0.025), IRON);
      box(mt, P(t, 0.04, y + 0.3), N(0.04), Y(0.18), U(0.06), IRON);
      const round = r(9) < 0.35;
      if (round) {
        // 丸い看板: 壁に直角な面の円（両面）
        const o = P(t, 0, 0), disc = [];
        for (let j = 0; j < 12; j++) disc.push([0.52 + Math.cos((j / 12) * Math.PI * 2) * 0.32, y + Math.sin((j / 12) * Math.PI * 2) * 0.32]);
        for (const sd of [1, -1]) vpoly(w, [o[0] + u[0] * 0.03 * sd, o[2] + u[1] * 0.03 * sd], n, sd > 0 ? disc : disc.slice().reverse(), [u[0] * sd, 0, u[1] * sd], color);
      } else box(w, P(t, 0.52, y), N(0.36), Y(0.3), U(0.035), color);
      if (!round) box(w, P(t, 0.52, y - 0.05), N(0.26), Y(0.08), U(0.04), col('#f2efe6'));
    }
    // 2 階の窓の鉄の手すり（2 階建て以上の建物の 6 割）: 石の床板、上下の横桟、縦の桟 7 本と両端の柱
    if (H > gh + fh * 1.5 && r(10) < 0.6) {
      const y0 = yb + fh * 0.13 - 0.05;
      for (const t of bays) {
        const hw = 0.72, d = 0.22;
        box(w, P(t, d / 2, y0 - 0.04), U(hw + 0.08), Y(0.04), N(d / 2 + 0.03), SILL);
        for (const y of [y0 + 0.05, y0 + 0.92]) box(mt, P(t, d, y), U(hw), Y(0.025), N(0.02), IRON);
        for (let j = 0; j <= 8; j++) {
          const tt = t - hw + (2 * hw * j) / 8, th = j === 0 || j === 8 ? 0.025 : 0.012;
          box(mt, P(tt, d, y0 + 0.48), U(th), Y(0.45), N(th), IRON);
        }
        for (const sd of [-1, 1]) box(mt, P(t + sd * hw, d / 2, y0 + 0.92), U(0.02), Y(0.02), N(d / 2), IRON);
      }
    }
  }
}

// ---- Place de la Trinité の噴水（寸法は写真と航空写真から: 水盤の外径約 5.9 m・縁の高さ 0.72 m、台座 1.4 m、
// セイレーン約 1.9 m、上の水盤の直径約 3.2 m、全体の高さ約 4.8 m）
function writeTrinite(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z), w = W.main, mt = W.metal;
  const STONE = col('#a29d95'), STONE_D = col('#8d8881'), MARBLE = col('#ebe6dc'), MARBLE_D = col('#d8d2c6');
  const BRONZE = col('#3a3a33'), BRONZE_L = col('#4a4a41'), WATER = col('#58706f'), SPRAY = col('#dce8ea');
  // 広場の石畳の淡い石の輪（航空写真: 噴水のまわりの直径約 14 m の輪と、水盤の足元の輪）
  for (const [r0, r1] of [[6.6, 7.0], [3.05, 3.4]]) {
    const n = 48;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const P = (a, r) => {
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        return [px, groundAt(px, pz) + 0.05, pz];
      };
      W.inlay.quad(P(a0, r0), P(a1, r0), P(a1, r1), P(a0, r1), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#cfc9bf'));
    }
  }
  // 下の水盤: 外の壁・張り出した丸い縁・内の壁・水面
  const RB = 2.8, yR = y0 + 0.72, yW = y0 + 0.52;
  cylinder(w, x, z, RB, RB, y0 - 0.2, y0 + 0.58, { seg: 40, color: STONE });
  cylinder(w, x, z, RB, RB + 0.15, y0 + 0.58, y0 + 0.66, { seg: 40, color: STONE });
  cylinder(w, x, z, RB + 0.15, RB + 0.15, y0 + 0.66, yR, { seg: 40, color: STONE });
  annulus(w, x, z, RB - 0.28, RB + 0.15, yR, 40, STONE_D);
  cylinder(w, x, z, RB - 0.28, RB - 0.28, yW - 0.1, yR, { seg: 40, color: STONE_D, inward: true });
  annulus(w, x, z, 0, RB - 0.28, yW, 40, WATER);
  // 台座: 3 つの面が内へ反った三角形（角は面取り）。足元の段・本体・軒
  const tri = (R, bow) => {
    const C = [0, 1, 2].map((k) => [Math.cos((k / 3) * Math.PI * 2 + Math.PI / 2) * R, Math.sin((k / 3) * Math.PI * 2 + Math.PI / 2) * R]);
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const ca = C[k], cb = C[(k + 1) % 3];
      // 角を面取りし（各辺の両端 8 %）、面は真ん中で bow m 内へ反らせる
      for (let j = 0; j <= 6; j++) {
        const t = 0.08 + (0.84 * j) / 6, mx = ca[0] + (cb[0] - ca[0]) * t, mz = ca[1] + (cb[1] - ca[1]) * t;
        const ml = Math.hypot(mx, mz), dent = bow * Math.sin((Math.PI * j) / 6);
        pts.push([x + mx - (mx / ml) * dent, z + mz - (mz / ml) * dent]);
      }
    }
    return pts;
  };
  const prism = (ring, ya, yb, color, top = true) => {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
      w.quad([p[0], ya, p[1]], [q[0], ya, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]], [dz / l, 0, -dx / l], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
    if (!top) return;
    const { points, indices } = triangulate(ring, []);
    for (let i = 0; i < indices.length; i += 3) w.tri(...[0, 1, 2].map((k) => [points[indices[i + k]][0], yb, points[indices[i + k]][1]]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  };
  const ringCW = (r) => (signedArea(r) > 0 ? r.slice().reverse() : r);
  const yP = y0 + 1.95;
  prism(ringCW(tri(1.25, 0.16)), yW - 0.1, y0 + 0.75, MARBLE_D);
  prism(ringCW(tri(1.12, 0.18)), y0 + 0.75, yP - 0.18, MARBLE);
  prism(ringCW(tri(1.22, 0.16)), yP - 0.18, yP, MARBLE_D);
  // 面ごとのライオンの顔（ブロンズ）と、水盤へ弧を描いて落ちる吐水
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2 + Math.PI / 3, c = Math.cos(a), s = Math.sin(a);
    const r = 1.12 * 0.5 - 0.18 + 0.02;
    blob(mt, [x + c * r, y0 + 1.25, z + s * r], [0.17, 0.2, 0.17], -a, 8, 5, () => BRONZE_L);
    let px = x + c * (r + 0.15), py = y0 + 1.18, pz = z + s * (r + 0.15);
    for (let j = 1; j <= 6; j++) {
      const d = r + 0.15 + j * 0.2, qy = y0 + 1.18 + 0.12 * j - 0.06 * j * j;
      const qx = x + c * d, qz = z + s * d;
      box(w, [(px + qx) / 2, (py + qy) / 2, (pz + qz) / 2], [(qx - px) / 2, (qy - py) / 2, (qz - pz) / 2], [-s * 0.025, 0, c * 0.025], [0, 0.025, 0], SPRAY);
      px = qx; py = qy; pz = qz;
      if (qy < yW) break;
    }
  }
  // 真ん中の手すり子（ブロンズ。ふくらみのある柱）
  for (const [ya, yb, ra, rb] of [[yP, yP + 0.25, 0.32, 0.26], [yP + 0.25, yP + 0.9, 0.26, 0.34], [yP + 0.9, yP + 1.7, 0.34, 0.2], [yP + 1.7, yP + 2.2, 0.2, 0.3]]) cylinder(mt, x, z, ra, rb, ya, yb, { seg: 12, color: BRONZE });
  // 3 体のセイレーン: 外を向き、うずまきの尾の上に立ち、両の翼を上へ広げて上の水盤を支える
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2 + Math.PI / 3, c = Math.cos(a), s = Math.sin(a);
    const at = (f, sd, y) => [x + c * f - s * sd, y, z + s * f + c * sd];
    // うずまきの尾（外へ巻く 2 つの渦と、台座の上の塊）
    blob(mt, at(0.5, 0, yP + 0.28), [0.38, 0.3, 0.3], -a, 10, 6, () => BRONZE);
    for (const sd of [-0.32, 0.32]) {
      for (let j = 0; j < 7; j++) {
        const t = j / 7, ang = t * Math.PI * 1.6, rr = 0.24 * (1 - t * 0.6);
        blob(mt, at(0.78 + Math.cos(ang) * rr * 0.6, sd * (1 + t * 0.3), yP + 0.3 + Math.sin(ang) * rr), [0.08, 0.08, 0.08], 0, 6, 4, () => BRONZE_L);
      }
    }
    // 衣をまとった体・胸・頭（髪を結った頭）
    blob(mt, at(0.52, 0, yP + 0.95), [0.2, 0.5, 0.18], -a, 10, 6, () => BRONZE);
    blob(mt, at(0.55, 0, yP + 1.45), [0.19, 0.25, 0.16], -a, 10, 6, () => BRONZE);
    blob(mt, at(0.56, 0, yP + 1.82), [0.11, 0.14, 0.11], 0, 8, 5, () => BRONZE);
    blob(mt, at(0.54, 0, yP + 1.95), [0.09, 0.06, 0.09], 0, 6, 4, () => BRONZE_L);
    for (const sd of [-0.17, 0.17]) blob(mt, at(0.56, sd, yP + 1.2), [0.06, 0.3, 0.06], -a, 6, 4, () => BRONZE); // 腕
    // 翼（肩から外へ上へ広げ、先は上の水盤の下に届く）。両面を描く
    for (const sg of [-1, 1]) {
      const o = at(0.5, 0, 0), sx = -s * sg, sz = c * sg;
      const shape = [[0.1, yP + 1.45], [0.62, yP + 1.62], [0.95, yP + 2.05], [1.02, yP + 2.32], [0.3, yP + 2.32], [0.12, yP + 1.8]];
      for (const flip of [1, -1]) vpoly(mt, [o[0], o[2]], [sx, sz], shape, [c * flip, 0, s * flip], BRONZE_L);
    }
  }
  // 上の水盤（白い大理石の浅い鉢）・水面・真ん中の噴き上げ
  const yC = yP + 2.25, RC = 1.6;
  for (const [ya, yb, ra, rb] of [[yC - 0.1, yC + 0.1, 0.3, 0.75], [yC + 0.1, yC + 0.35, 0.75, 1.35], [yC + 0.35, yC + 0.5, 1.35, RC], [yC + 0.5, yC + 0.6, RC, RC]]) cylinder(w, x, z, ra, rb, ya, yb, { seg: 32, color: MARBLE });
  annulus(w, x, z, RC - 0.08, RC, yC + 0.6, 32, MARBLE_D);
  cylinder(w, x, z, RC - 0.08, RC - 0.08, yC + 0.45, yC + 0.6, { seg: 32, color: MARBLE_D, inward: true });
  annulus(w, x, z, 0, RC - 0.08, yC + 0.52, 32, WATER);
  cylinder(w, x, z, 0.06, 0.03, yC + 0.52, yC + 1.5, { seg: 8, color: SPRAY });
  blob(w, [x, yC + 1.5, z], [0.12, 0.1, 0.12], 0, 6, 4, () => SPRAY);
  colliders.push([x, z, RB + 0.15]);
  keepOut.push([x, z, RB + 1.2]);
}

// ---- 広場の真ん中の庭（squares.js。Place Wilson の Jardin Pierre-Goudouli）
// 写真（利用者のストリートビュー 212146、Wikimedia Commons「Alexandre Falguière - Pèire Godolin -Toulouse」「Jardin Pierre Goudouli,
// Place Wilson」「Dans le centre de la Place Wilson」）: 庭の縁は低い花崗岩の縁石と低木の植え込み、外の車道の縁に黒い車止めの列。
// 砂の広場に緑の木のベンチと、黒い鋳鉄の 3 つの灯具の街灯。噴水は淡い石の低い縁の丸い水盤（直径約 11 m、淡い青緑の水）、
// 真ん中に円い石の台座と白っぽい岩の台、白い大理石の座った詩人（片膝を立てて腕を載せ、脇の岩に帽子）と岩に横たわる女性像、
// 台座の足元の輪に小さな噴き上げが並び、水盤の中の輪に高い噴き上げ（約 2.5 m）
// a → b の太さの変わる円柱（像の手足・胴。両端は小さな円錐でふさぐ）。ra・rb: a・b の半径
function limb(w, a, b, ra, color, rb = ra, seg = 8) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
  const u = [d[0] / L, d[1] / L, d[2] / L], ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cr = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const nz = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const p = nz(cr(u, ref)), q = cr(u, p);
  const ring = (o, r, k) => {
    const t = (k / seg) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    return [o[0] + (p[0] * c + q[0] * s) * r, o[1] + (p[1] * c + q[1] * s) * r, o[2] + (p[2] * c + q[2] * s) * r];
  };
  const ea = [a[0] - u[0] * ra * 0.7, a[1] - u[1] * ra * 0.7, a[2] - u[2] * ra * 0.7], eb = [b[0] + u[0] * rb * 0.7, b[1] + u[1] * rb * 0.7, b[2] + u[2] * rb * 0.7];
  for (let k = 0; k < seg; k++) {
    const t = ((k + 0.5) / seg) * Math.PI * 2, n = [p[0] * Math.cos(t) + q[0] * Math.sin(t), p[1] * Math.cos(t) + q[1] * Math.sin(t), p[2] * Math.cos(t) + q[2] * Math.sin(t)];
    const a0 = ring(a, ra, k), a1 = ring(a, ra, k + 1), b0 = ring(b, rb, k), b1 = ring(b, rb, k + 1);
    w.quad(a0, a1, b1, b0, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    w.tri(a1, a0, ea, nz([n[0] - u[0], n[1] - u[1], n[2] - u[2]]), PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    w.tri(b0, b1, eb, nz([n[0] + u[0], n[1] + u[1], n[2] + u[2]]), PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  }
}
// 緑の木の板のベンチ（黒い鋳鉄の脚）: 中心 (x, z)、座る人が向く向き a（ラジアン）
function gardenBench(w, x, z, y, a, colliders) {
  const f = [Math.cos(a), Math.sin(a)], s = [-f[1], f[0]];
  const IRON = col('#26292a'), SLAT = col('#3f5f3c');
  const B = (u, v, yy, hu, hv, hy, c) => box(w, [x + f[0] * u + s[0] * v, y + yy, z + f[1] * u + s[1] * v], [f[0] * hu, 0, f[1] * hu], [0, hy, 0], [s[0] * hv, 0, s[1] * hv], c);
  for (const v of [-0.8, 0.8]) {
    B(0.05, v, 0.22, 0.24, 0.035, 0.22, IRON); // 脚
    B(-0.2, v, 0.62, 0.035, 0.035, 0.22, IRON); // 背の支え
  }
  for (const u of [-0.16, 0.0, 0.16]) B(u, 0, 0.46, 0.06, 0.95, 0.02, SLAT); // 座面の板
  for (const yy of [0.62, 0.76]) B(-0.22, 0, yy, 0.02, 0.95, 0.05, SLAT); // 背の板
  colliders.push([x + s[0] * 0.5, z + s[1] * 0.5, 0.45], [x - s[0] * 0.5, z - s[1] * 0.5, 0.45]);
}
// 黒い鋳鉄の街灯（台・細い柱・3 本の腕のランタン）
function gardenLamp(w, x, z, y, colliders) {
  const IRON = col('#1f2324'), GLASS = col('#f3e3b5');
  cylinder(w, x, z, 0.2, 0.16, y, y + 0.6, { seg: 8, color: IRON });
  cylinder(w, x, z, 0.075, 0.06, y + 0.6, y + 3.5, { seg: 8, color: IRON });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3, lx = x + Math.cos(a) * 0.42, lz = z + Math.sin(a) * 0.42;
    box(w, [(x + lx) / 2, y + 3.45, (z + lz) / 2], [Math.cos(a) * 0.21, 0, Math.sin(a) * 0.21], [0, 0.025, 0], [-Math.sin(a) * 0.025, 0, Math.cos(a) * 0.025], IRON);
    cylinder(w, lx, lz, 0.1, 0.14, y + 3.5, y + 3.85, { seg: 6, color: GLASS });
    cylinder(w, lx, lz, 0.16, 0.02, y + 3.85, y + 4.05, { seg: 6, color: IRON });
  }
  cylinder(w, x, z, 0.1, 0.13, y + 3.55, y + 3.95, { seg: 6, color: GLASS });
  cylinder(w, x, z, 0.16, 0.02, y + 3.95, y + 4.25, { seg: 6, color: IRON });
  colliders.push([x, z, 0.22]);
}
function writeSquare(m, W, groundAt, colliders, onRoad, keepOut) {
  const { sq, gates, outline, paths = [] } = m, w = W.main, rnd = mulberry32(1580);
  const { cx, cz, fx, fz, basin: RB } = sq;
  const r = sq.r, Rk = (a) => (outline ? outline.rAt(a) : r); // 向き a の庭の縁の半径
  // 園路の上か（園路の縁から pad m 以内）
  const onPath = (x, z, pad) => paths.some(([ax, az, bx, bz, h]) => closestOnSegment(x, z, ax, az, bx, bz).d2 < (h + pad) ** 2);
  const KERB = col('#b8b2a8'), SHRUB = [col('#3f5c2e'), col('#486a33'), col('#35512a'), col('#55703a')], POST = col('#1e2122');
  const STONE = col('#ddd6c8'), STONE_D = col('#c6bead'), ROCK = col('#d3ccbf'), ROCK_D = col('#bfb7a8');
  const MARBLE = col('#ece8e0'), WATER = col('#86aca6'), SPRAY = col('#f1f6f6');
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const nearGate = (a, half) => gates.some((g) => angDiff(a, g) < half);
  // 縁石（高さ 12 cm・幅 26 cm、庭の縁に沿って 1.4 m ごと）。入口（地図の小道が縁を横切る所）で切る
  const nK = Math.round((2 * Math.PI * r) / 1.4);
  for (let k = 0; k < nK; k++) {
    const a0 = (k / nK) * Math.PI * 2, a1 = ((k + 1) / nK) * Math.PI * 2, a = (a0 + a1) / 2;
    if (nearGate(a, 2.6 / r)) continue;
    const p0 = [cx + Math.cos(a0) * Rk(a0), cz + Math.sin(a0) * Rk(a0)], p1 = [cx + Math.cos(a1) * Rk(a1), cz + Math.sin(a1) * Rk(a1)];
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, ux = (p1[0] - p0[0]) / L, uz = (p1[1] - p0[1]) / L;
    const px = (p0[0] + p1[0]) / 2, pz = (p0[1] + p1[1]) / 2, g = groundAt(px, pz);
    box(w, [px, g + 0.05, pz], [ux * (L / 2 + 0.02), 0, uz * (L / 2 + 0.02)], [0, 0.08, 0], [-uz * 0.13, 0, ux * 0.13], KERB);
  }
  // 縁石の外の黒い車止め（縁石と車道の縁のあいだ、2.2 m ごと。入口の前は空ける）
  const nP = Math.round((2 * Math.PI * (r + 0.2)) / 2.2);
  for (let k = 0; k < nP; k++) {
    const a = (k / nP) * Math.PI * 2;
    if (nearGate(a, 2.8 / r)) continue;
    const rr = Rk(a) + 0.22, px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr, g = groundAt(px, pz);
    cylinder(w, px, pz, 0.09, 0.09, g, g + 0.85, { seg: 7, color: POST });
    cylinder(w, px, pz, 0.1, 0.06, g + 0.85, g + 0.92, { seg: 7, color: POST });
    colliders.push([px, pz, 0.12]);
  }
  // 縁石の内側の低木の植え込み（2.3 m ごとの不揃いな塊。入口のそばは空ける）
  const nS = Math.round((2 * Math.PI * (r - 1.6)) / 2.3);
  for (let k = 0; k < nS; k++) {
    const a = (k / nS) * Math.PI * 2 + (rnd() - 0.5) * 0.02;
    if (nearGate(a, 4.2 / r)) continue;
    const rr = Rk(a) - 1.3 - rnd() * 0.9, px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
    const sz = 0.6 + rnd() * 0.5, h = 0.45 + rnd() * 0.55;
    blob(w, [px, groundAt(px, pz) + h * 0.75, pz], [sz * 1.2, h, sz], a, 8, 4, (f) => SHRUB[(k + f) % SHRUB.length]);
  }
  // 入口ごとに街灯 1 本（庭の中、入口の脇。園路の上には立てない）
  for (const g of gates) {
    for (const off of [4.2, -4.2]) {
      const a = g + off / r, rr = Rk(a) - 2.2, px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
      if (onPath(px, pz, 1.0)) continue;
      gardenLamp(w, px, pz, groundAt(px, pz), colliders);
      break;
    }
  }
  // ---- 噴水
  const y0 = groundAt(fx, fz), yW = y0 + 0.26;
  // 水盤: 外の壁（高さ約 40 cm）・笠石・内の壁・水面
  cylinder(w, fx, fz, RB, RB, y0 - 0.2, y0 + 0.36, { seg: 56, color: STONE_D });
  cylinder(w, fx, fz, RB + 0.06, RB + 0.06, y0 + 0.36, y0 + 0.44, { seg: 56, color: STONE });
  annulus(w, fx, fz, RB - 0.34, RB + 0.06, y0 + 0.44, 56, STONE);
  cylinder(w, fx, fz, RB - 0.34, RB - 0.34, yW - 0.05, y0 + 0.44, { seg: 56, color: STONE_D, inward: true });
  annulus(w, fx, fz, 0, RB - 0.34, yW, 56, WATER);
  // 円い台座（淡い石の太鼓）と足元の張り出し
  cylinder(w, fx, fz, 2.75, 2.75, yW - 0.05, yW + 0.12, { seg: 40, color: STONE_D });
  annulus(w, fx, fz, 2.45, 2.75, yW + 0.12, 40, STONE);
  cylinder(w, fx, fz, 2.45, 2.4, yW + 0.12, y0 + 1.05, { seg: 40, color: STONE });
  annulus(w, fx, fz, 0, 2.4, y0 + 1.05, 40, ROCK_D);
  // 岩の台（不揃いな塊を重ねる）。F: 像の正面の向き、S: 横
  const F = [Math.cos(m.angle), Math.sin(m.angle)], S = [-F[1], F[0]];
  const at = (f, sd, y) => [fx + F[0] * f + S[0] * sd, y, fz + F[1] * f + S[1] * sd];
  const yawS = Math.atan2(S[1], S[0]);
  for (const [f, sd, y, rx, ry, rz, c] of [
    [0, 0, 1.55, 1.9, 0.7, 1.25, ROCK], [0.15, -1.15, 1.45, 1.0, 0.65, 0.95, ROCK_D], [-0.25, 1.25, 1.5, 1.15, 0.62, 0.95, ROCK],
    [-0.55, 0.15, 1.95, 1.35, 0.68, 0.85, ROCK_D], [0.55, 0.85, 1.3, 0.95, 0.45, 0.8, ROCK], [0.7, -0.55, 1.25, 0.8, 0.4, 0.7, ROCK_D],
  ]) blob(w, at(f, sd, y0 + y), [rx, ry, rz], yawS, 10, 5, () => c);
  // 座った詩人（片膝を立てて右の腕を載せ、左の手は岩に突く）。腰の高さ yH。胴は前へ少し傾く
  const yH = y0 + 2.45, sd0 = -0.25;
  blob(w, at(0.0, sd0, yH + 0.12), [0.34, 0.2, 0.3], m.angle, 10, 5, () => MARBLE); // 腰
  limb(w, at(0.0, sd0, yH + 0.15), at(0.08, sd0, yH + 0.72), 0.29, MARBLE, 0.27, 10); // 胴（上着）
  blob(w, at(0.08, sd0, yH + 0.78), [0.2, 0.13, 0.36], m.angle, 10, 5, () => MARBLE); // 肩
  blob(w, at(0.12, sd0, yH + 0.9), [0.16, 0.06, 0.2], m.angle, 8, 3, () => MARBLE); // 襟
  limb(w, at(0.11, sd0, yH + 0.9), at(0.13, sd0, yH + 1.0), 0.07, MARBLE, 0.07, 6); // 首
  blob(w, at(0.15, sd0, yH + 1.14), [0.15, 0.17, 0.13], m.angle, 10, 6, () => MARBLE); // 頭
  blob(w, at(0.08, sd0, yH + 1.11), [0.15, 0.17, 0.19], m.angle, 10, 6, () => MARBLE); // 肩までの巻き毛
  // 立てた右の脚（膝が胸の高さ）と下ろした左の脚
  limb(w, at(0.08, sd0 + 0.16, yH + 0.05), at(0.55, sd0 + 0.18, yH + 0.42), 0.15, MARBLE, 0.12);
  limb(w, at(0.55, sd0 + 0.18, yH + 0.42), at(0.66, sd0 + 0.2, yH - 0.22), 0.11, MARBLE, 0.08);
  blob(w, at(0.74, sd0 + 0.2, yH - 0.28), [0.15, 0.06, 0.07], m.angle, 7, 3, () => MARBLE); // 靴
  limb(w, at(0.08, sd0 - 0.17, yH), at(0.58, sd0 - 0.24, yH - 0.06), 0.15, MARBLE, 0.12);
  limb(w, at(0.58, sd0 - 0.24, yH - 0.06), at(0.74, sd0 - 0.26, yH - 0.66), 0.11, MARBLE, 0.08);
  blob(w, at(0.82, sd0 - 0.26, yH - 0.72), [0.15, 0.06, 0.07], m.angle, 7, 3, () => MARBLE);
  // 膝に載せた右の腕と、岩に突いた左の腕
  limb(w, at(0.1, sd0 + 0.3, yH + 0.72), at(0.38, sd0 + 0.3, yH + 0.5), 0.08, MARBLE, 0.07);
  limb(w, at(0.38, sd0 + 0.3, yH + 0.5), at(0.6, sd0 + 0.22, yH + 0.5), 0.07, MARBLE, 0.06);
  limb(w, at(0.05, sd0 - 0.32, yH + 0.72), at(0.05, sd0 - 0.55, yH + 0.35), 0.08, MARBLE, 0.07);
  limb(w, at(0.05, sd0 - 0.55, yH + 0.35), at(0.1, sd0 - 0.62, yH + 0.02), 0.07, MARBLE, 0.06);
  // 脇の岩に置いた帽子
  blob(w, at(0.15, -1.3, yH - 0.05), [0.36, 0.05, 0.32], 0, 10, 3, () => MARBLE);
  blob(w, at(0.15, -1.3, yH + 0.06), [0.19, 0.12, 0.18], 0, 8, 4, () => MARBLE);
  // 岩に横たわる女性像（頭は詩人の脚の側、肘を突いて上体を起こす）と、正面の下の子ども
  limb(w, at(0.45, 0.45, yH - 0.25), at(0.7, 1.25, yH - 0.5), 0.2, MARBLE, 0.17, 10);
  limb(w, at(0.7, 1.25, yH - 0.5), at(0.95, 1.95, yH - 0.72), 0.14, MARBLE, 0.09);
  limb(w, at(0.72, 1.3, yH - 0.48), at(1.05, 1.85, yH - 0.62), 0.12, MARBLE, 0.08);
  blob(w, at(0.4, 0.3, yH - 0.03), [0.14, 0.16, 0.13], m.angle, 9, 5, () => MARBLE);
  limb(w, at(0.42, 0.55, yH - 0.2), at(0.3, 0.75, yH - 0.48), 0.07, MARBLE, 0.06);
  blob(w, at(1.05, -0.35, y0 + 1.62), [0.2, 0.28, 0.19], m.angle, 9, 5, () => MARBLE);
  blob(w, at(1.08, -0.35, y0 + 2.0), [0.12, 0.13, 0.12], m.angle, 8, 5, () => MARBLE);
  // 噴き上げ（白い水。少し透けて見えるよう細く）: 台座の足元の輪（小さな弧、40 本）と、水盤の中の輪（高さ約 2 m の細い
  // 柱が上でほどけて、まわりへ落ちる水の幕）
  const jet = (a, r0, r1, hTop, n = 5) => {
    const c = Math.cos(a), sn = Math.sin(a);
    let p = [fx + c * r0, yW, fz + sn * r0];
    for (let j = 1; j <= n; j++) {
      const t = j / n, rr = r0 + (r1 - r0) * t, yy = yW + 4 * hTop * t * (1 - t);
      const q = [fx + c * rr, yy, fz + sn * rr];
      box(w, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], [(q[0] - p[0]) / 2, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2], [-sn * 0.018, 0, c * 0.018], [0, 0.018, 0], SPRAY);
      p = q;
    }
  };
  for (let k = 0; k < 40; k++) jet((k / 40) * Math.PI * 2, 2.8, 3.25, 0.4, 4);
  for (let k = 0; k < 16; k++) {
    const a = ((k + 0.5) / 16) * Math.PI * 2, jx = fx + Math.cos(a) * 3.95, jz = fz + Math.sin(a) * 3.95, top = yW + 1.9;
    cylinder(w, jx, jz, 0.035, 0.05, yW, top, { seg: 6, color: SPRAY });
    cylinder(w, jx, jz, 0.06, 0.09, top, top + 0.15, { seg: 6, color: SPRAY });
    for (let j = 0; j < 4; j++) {
      const b = (j / 4) * Math.PI * 2 + a, c = Math.cos(b), sn = Math.sin(b);
      let p = [jx, top + 0.12, jz];
      for (let i = 1; i <= 4; i++) {
        const t = i / 4, q = [jx + c * 0.3 * t, top + 0.12 + 0.12 * t - 0.9 * t * t, jz + sn * 0.3 * t];
        box(w, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], [(q[0] - p[0]) / 2, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2], [-sn * 0.02, 0, c * 0.02], [0, 0.02, 0], SPRAY);
        p = q;
      }
    }
  }
  colliders.push([fx, fz, RB + 0.06]);
  keepOut.push([fx, fz, RB + 1.5]);
  // ---- 噴水のまわりの砂の広場のベンチ（噴水を向く）と街灯。園路（入口の向き）と回転木馬の側は空ける
  const toward = gates.map((g) => Math.atan2(cz + Math.sin(g) * r - fz, cx + Math.cos(g) * r - fx));
  const kAng = Math.atan2(sq.kz - fz, sq.kx - fx);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + 0.11;
    if (toward.some((t) => angDiff(a, t) < 0.42) || angDiff(a, kAng) < 0.5) continue;
    const bx = fx + Math.cos(a) * 8.4, bz = fz + Math.sin(a) * 8.4;
    if (onPath(bx, bz, 1.2)) continue; // 噴水のまわりを回る園路の上には置かない
    if (k % 3 === 2) gardenLamp(w, bx, bz, groundAt(bx, bz), colliders);
    else gardenBench(w, bx, bz, groundAt(bx, bz), a + Math.PI, colliders);
  }
}

// ---- 回転木馬（Place Wilson の manège de chevaux de bois。Wikimedia Commons「Jardin Pierre Goudouli, Place Wilson」と航空写真）:
// 木の円い台に真鍮の棒と木馬の 2 つの輪、真ん中の鏡の柱。上に波形の縁の飾りの帯（青い絵の板と金の縁）と、クリーム色と
// 赤の縞の浅い円錐の屋根、頂に金の飾り
function writeCarousel(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z, R } = m, w = W.main, mt = W.metal;
  const y0 = groundAt(x, z), yP = y0 + 0.4, yE = y0 + 3.6;
  const WOOD = col('#6e3326'), FLOOR = col('#8c6a48'), CREAM = col('#efe5cc'), GOLD = col('#c9a03c'), RED = col('#a8382b'), BRASS = col('#c9a85a');
  const PANEL = [col('#7fa4b8'), col('#8fb39a'), col('#7fa4b8'), col('#c9b07a')], HORSE = [col('#f2eee6'), col('#d7b085'), col('#7a4d34'), col('#efe9df'), col('#3c3a38')];
  // 台（木の円盤）と、縁の飾りの板
  cylinder(w, x, z, R, R, y0, yP, { seg: 36, color: WOOD });
  annulus(w, x, z, 0, R, yP, 36, FLOOR);
  // 真ん中の柱（クリーム色に金の帯）
  cylinder(w, x, z, 1.0, 1.0, yP, yE, { seg: 18, color: CREAM });
  for (const yy of [yP + 0.8, yE - 0.9]) cylinder(w, x, z, 1.05, 1.05, yy, yy + 0.35, { seg: 18, color: GOLD });
  // 真鍮の棒と木馬（外の輪 14 頭、内の輪 9 頭。上下にずらす）
  for (const [rr, n] of [[R - 0.85, 14], [R - 2.25, 9]]) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rr * 0.3, px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      cylinder(mt, px, pz, 0.035, 0.035, yP, yE, { seg: 6, color: BRASS });
      const t = [-Math.sin(a), Math.cos(a)], hy = yP + 0.95 + (k % 2) * 0.3, yaw = Math.atan2(t[1], t[0]), hc = HORSE[(k + n) % HORSE.length];
      blob(w, [px, hy, pz], [0.55, 0.22, 0.17], yaw, 8, 5, () => hc); // 胴
      limb(w, [px + t[0] * 0.42, hy + 0.1, pz + t[1] * 0.42], [px + t[0] * 0.62, hy + 0.5, pz + t[1] * 0.62], 0.11, hc); // 首
      blob(w, [px + t[0] * 0.78, hy + 0.55, pz + t[1] * 0.78], [0.2, 0.1, 0.09], yaw, 7, 4, () => hc); // 頭
      for (const sg of [-1, 1]) limb(w, [px + t[0] * 0.35 * sg, hy - 0.1, pz + t[1] * 0.35 * sg], [px + t[0] * 0.45 * sg, hy - 0.6, pz + t[1] * 0.45 * sg], 0.05, hc); // 脚
      blob(w, [px, hy + 0.24, pz], [0.2, 0.05, 0.14], yaw, 7, 3, () => RED); // 鞍
    }
  }
  // 縁の飾りの帯: 絵の板（16 枚）と金の縁、上端の波形の飾り
  const n = 16;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const P = (a, rr, y) => [x + Math.cos(a) * rr, y, z + Math.sin(a) * rr];
    const nn = [Math.cos(am), 0, Math.sin(am)], ro = R + 0.18;
    w.quad(P(a1, ro, yE), P(a0, ro, yE), P(a0, ro, yE + 0.75), P(a1, ro, yE + 0.75), nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, PANEL[k % PANEL.length]);
    for (const [ya, yb] of [[yE - 0.08, yE + 0.06], [yE + 0.7, yE + 0.8]]) w.quad(P(a1, ro + 0.02, ya), P(a0, ro + 0.02, ya), P(a0, ro + 0.02, yb), P(a1, ro + 0.02, yb), nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, GOLD);
    // 板の境の金の柱と、上の半円の飾り
    const pa = P(a0, ro + 0.03, 0);
    box(w, [pa[0], yE + 0.37, pa[2]], [-Math.sin(a0) * 0.06, 0, Math.cos(a0) * 0.06], [0, 0.43, 0], [Math.cos(a0) * 0.03, 0, Math.sin(a0) * 0.03], GOLD);
    const crest = [];
    for (let j = 0; j <= 6; j++) {
      const t = j / 6, aa = a0 + (a1 - a0) * t;
      crest.push(P(aa, ro, yE + 0.8 + Math.sin(Math.PI * t) * 0.32));
    }
    for (let j = 0; j + 1 < crest.length; j++) {
      const p = crest[j], q = crest[j + 1];
      w.quad([q[0], yE + 0.8, q[2]], [p[0], yE + 0.8, p[2]], p, q, nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, j % 2 ? CREAM : GOLD);
    }
    // 屋根の縞（クリーム色と赤を交互に）
    const yR = yE + 0.85, yA = yE + 2.0;
    const c0 = P(a0, R + 0.35, yR), c1 = P(a1, R + 0.35, yR), top = [x, yA, z];
    const nr = [Math.cos(am) * 0.7, 0.7, Math.sin(am) * 0.7];
    w.tri(c1, c0, top, nr, PLAIN_UV, PLAIN_UV, PLAIN_UV, k % 2 ? RED : CREAM);
    w.tri(c0, c1, [x, yR - 0.02, z], [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, CREAM);
  }
  // 頂の金の飾り（小さな柱と玉と旗竿）
  cylinder(w, x, z, 0.35, 0.2, yE + 1.95, yE + 2.35, { seg: 10, color: GOLD });
  blob(w, [x, yE + 2.5, z], [0.2, 0.2, 0.2], 0, 8, 5, () => GOLD);
  cylinder(w, x, z, 0.025, 0.025, yE + 2.6, yE + 3.4, { seg: 5, color: GOLD });
  colliders.push([x, z, R + 0.15]);
  keepOut.push([x, z, R + 1]);
}

// ---- Place Saint-Étienne の噴水（le Griffoul）
function writeGriffoul(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m, w = W.main, mt = W.metal, y0 = groundAt(x, z);
  const STONE = col('#c9c0ae'), STONE_D = col('#ada392'), OBEL = col('#b8a98e'), SETTS = col('#9d968b'), STEP = col('#cbc5ba'), RISER = col('#77716a');
  const BRONZE = col('#454b42'), BRONZE_L = col('#596052'), WATER = col('#6f8f8c'), SPRAY = col('#e6eff0');
  // 一段下がった八角形の石畳（階段の 2 段の帯と蹴上げの暗い線。地面に貼る）
  const oct = (r, y) => Array.from({ length: 8 }, (_, k) => {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    return [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
  });
  const ring = (r0, r1, color) => {
    const A = oct(r0, y0 + 0.04), B = oct(r1, y0 + 0.04);
    for (let k = 0; k < 8; k++) W.inlay.quad(A[k], A[(k + 1) % 8], B[(k + 1) % 8], B[k], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  };
  ring(0.01, 3.7, SETTS);
  ring(3.7, 3.78, RISER);
  ring(3.78, 4.2, STEP);
  ring(4.2, 4.28, RISER);
  ring(4.28, 4.75, STEP);
  // 八角形の水盤: 外の壁・笠石・内の壁・水面
  const yW = y0 + 0.62;
  cylinder(w, x, z, 2.6, 2.6, y0 - 0.2, y0 + 0.72, { seg: 8, color: STONE_D });
  cylinder(w, x, z, 2.7, 2.7, y0 + 0.72, y0 + 0.84, { seg: 8, color: STONE });
  annulus(w, x, z, 2.3, 2.7, y0 + 0.84, 8, STONE);
  cylinder(w, x, z, 2.3, 2.3, yW - 0.05, y0 + 0.84, { seg: 8, color: STONE_D, inward: true });
  annulus(w, x, z, 0, 2.3, yW, 8, WATER);
  // 短い 6 本の柱と、真ん中の八角形の柱
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    cylinder(w, x + Math.cos(a) * 1.0, z + Math.sin(a) * 1.0, 0.09, 0.09, yW, y0 + 1.3, { seg: 6, color: STONE });
  }
  cylinder(w, x, z, 0.5, 0.45, yW, y0 + 1.3, { seg: 8, color: STONE_D });
  // 丸い上の水盤（ライオンの顔 4 つ）
  cylinder(w, x, z, 0.7, 1.3, y0 + 1.25, y0 + 1.52, { seg: 24, color: STONE });
  cylinder(w, x, z, 1.32, 1.32, y0 + 1.52, y0 + 1.66, { seg: 24, color: STONE });
  annulus(w, x, z, 1.18, 1.32, y0 + 1.66, 24, STONE);
  annulus(w, x, z, 0, 1.18, y0 + 1.6, 24, WATER);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    blob(w, [x + Math.cos(a) * 1.32, y0 + 1.48, z + Math.sin(a) * 1.32], [0.16, 0.17, 0.16], -a, 8, 5, () => STONE_D);
  }
  // 八角形の台座（4 つのニッチにブロンズの子ども）と軒
  const yP = y0 + 1.62, yT = y0 + 3.05;
  cylinder(w, x, z, 0.58, 0.58, yP, yT, { seg: 8, color: STONE });
  cylinder(w, x, z, 0.7, 0.7, yT, yT + 0.16, { seg: 8, color: STONE_D });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    const at = (r, y) => [x + c * r, y, z + sn * r];
    box(w, at(0.5, yP + 0.72), [c * 0.05, 0, sn * 0.05], [0, 0.6, 0], [-sn * 0.26, 0, c * 0.26], col('#8f8676')); // ニッチの影
    blob(mt, at(0.6, yP + 0.55), [0.14, 0.24, 0.12], -a, 8, 5, () => BRONZE);
    blob(mt, at(0.62, yP + 0.9), [0.11, 0.12, 0.11], 0, 8, 5, () => BRONZE_L);
    limb(mt, at(0.62, yP + 0.65), at(0.78, yP + 0.55), 0.04, BRONZE);
    // 吐く水: 子どもの前から上の水盤へ弧を描いて落ちる
    let p = at(0.8, yP + 0.55);
    for (let j = 1; j <= 5; j++) {
      const t = j / 5, q = at(0.8 + 0.45 * t, yP + 0.55 + 0.15 * t - 0.6 * t * t);
      box(w, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], [(q[0] - p[0]) / 2, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2], [-sn * 0.015, 0, c * 0.015], [0, 0.015, 0], SPRAY);
      p = q;
    }
  }
  // オベリスク（四角い柱が上へ細くなる）・頂の小さな四角錐・風見
  cylinder(w, x, z, 0.5, 0.5, yT + 0.16, yT + 0.55, { seg: 4, color: STONE_D });
  cylinder(w, x, z, 0.42, 0.22, yT + 0.55, y0 + 9.6, { seg: 4, color: OBEL });
  cylinder(w, x, z, 0.24, 0.01, y0 + 9.6, y0 + 10.0, { seg: 4, color: OBEL });
  cylinder(mt, x, z, 0.025, 0.025, y0 + 10.0, y0 + 10.9, { seg: 5, color: BRONZE });
  box(mt, [x + 0.18, y0 + 10.6, z], [0.2, 0, 0], [0, 0.1, 0], [0, 0, 0.01], BRONZE);
  colliders.push([x, z, 2.75]);
  keepOut.push([x, z, 4.8]);
}

// ---- Place Dupuy のコロンヌ・デュピュイ
function writeColumn(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m, w = W.main, mt = W.metal, y0 = groundAt(x, z);
  const LIME = col('#e2dccf'), LIME_D = col('#c9c1b1'), SHAFT = col('#c8b98d'), SHAFT_D = col('#b3a57c');
  const BRONZE = col('#4a4f43'), GOLD = col('#d6aa3a'), WATER = col('#6f8f8c');
  // 丸い水盤（低い淡い石の縁）と水面
  const RB = 4.4, yW = y0 + 0.45;
  cylinder(w, x, z, RB, RB, y0 - 0.2, y0 + 0.55, { seg: 40, color: LIME_D });
  annulus(w, x, z, RB - 0.35, RB, y0 + 0.55, 40, LIME);
  cylinder(w, x, z, RB - 0.35, RB - 0.35, yW - 0.05, y0 + 0.55, { seg: 40, color: LIME_D, inward: true });
  annulus(w, x, z, 0, RB - 0.35, yW, 40, WATER);
  // 台座（四角。段・本体・軒）。四隅にブロンズのグリフォン
  const sq = (half, ya, yb, color) => box(w, [x, (ya + yb) / 2, z], [half, 0, 0], [0, (yb - ya) / 2, 0], [0, 0, half], color);
  sq(2.0, yW - 0.1, y0 + 1.0, LIME_D);
  sq(1.6, y0 + 1.0, y0 + 1.35, LIME);
  sq(1.3, y0 + 1.35, y0 + 4.6, LIME);
  sq(1.5, y0 + 4.6, y0 + 4.95, LIME_D);
  sq(1.1, y0 + 4.95, y0 + 5.5, LIME);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const gx = x + sx * 1.65, gz = z + sz * 1.65, a = Math.atan2(sz, sx);
    blob(mt, [gx, y0 + 1.75, gz], [0.55, 0.32, 0.28], -a, 8, 5, () => BRONZE);
    blob(mt, [gx + Math.cos(a) * 0.45, y0 + 2.15, gz + Math.sin(a) * 0.45], [0.2, 0.22, 0.18], 0, 8, 5, () => BRONZE);
    for (const sd of [-1, 1]) blob(mt, [gx - Math.sin(a) * 0.25 * sd, y0 + 2.2, gz + Math.cos(a) * 0.25 * sd], [0.32, 0.25, 0.06], -a, 6, 4, () => BRONZE); // 翼
  }
  // 円柱（礎盤・柱身・柱頭）と頂の台
  cylinder(w, x, z, 0.95, 0.85, y0 + 5.5, y0 + 6.0, { seg: 20, color: SHAFT_D });
  cylinder(w, x, z, 0.72, 0.6, y0 + 6.0, y0 + 20.6, { seg: 20, color: SHAFT });
  cylinder(w, x, z, 0.62, 0.85, y0 + 20.6, y0 + 21.1, { seg: 20, color: SHAFT_D });
  box(w, [x, y0 + 21.25, z], [0.95, 0, 0], [0, 0.15, 0], [0, 0, 0.95], SHAFT_D);
  cylinder(w, x, z, 0.45, 0.4, y0 + 21.4, y0 + 22.0, { seg: 12, color: SHAFT });
  // 金色の名声の女神（体・頭・掲げた腕とラッパ・翼）
  blob(mt, [x, y0 + 22.8, z], [0.32, 0.8, 0.3], 0, 10, 6, () => GOLD);
  blob(mt, [x, y0 + 23.75, z], [0.16, 0.19, 0.16], 0, 8, 5, () => GOLD);
  limb(mt, [x + 0.15, y0 + 23.4, z], [x + 0.35, y0 + 24.4, z + 0.1], 0.06, GOLD);
  limb(mt, [x + 0.35, y0 + 24.4, z + 0.1], [x + 0.75, y0 + 24.6, z + 0.15], 0.04, GOLD, 0.1);
  for (const sd of [-1, 1]) blob(mt, [x - 0.25, y0 + 23.4, z + sd * 0.35], [0.12, 0.55, 0.35], 0, 6, 4, () => GOLD);
  colliders.push([x, z, RB]);
  keepOut.push([x, z, RB + 1.2]);
}

// ---- 自転車置き場: 逆 U 字の輪（高さ 0.8 m・幅 0.7 m、線に直角）と、6 割ほどの輪に止めた自転車
const BIKE_COLORS = ['#2c2f33', '#7a1f22', '#1f4d7a', '#3d6b3a', '#d8d5cc', '#c98a1e', '#4a4f55', '#16a0a0'];
function writeBikeracks(m, W, groundAt, colliders) {
  const { a, b } = m;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], d = [-u[1], u[0]];
  const mt = W.metal, w = W.main, IRON = col('#3b4045'), TIRE = col('#1c1c1d'), SEAT = col('#141414');
  const n = Math.max(2, Math.floor(L / 1.0));
  const seed0 = (Math.imul(Math.round(a[0] * 10), 73856093) ^ Math.imul(Math.round(a[1] * 10), 19349663)) | 0;
  // 棒: p から q へ、太さ t
  const bar = (wr, p, q, t, c) => {
    const h = [(q[0] - p[0]) / 2, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2], l = Math.hypot(...h) || 1;
    const side = Math.abs(h[1]) / l > 0.95 ? [t, 0, 0] : [(-h[2] / Math.hypot(h[0], h[2])) * t, 0, (h[0] / Math.hypot(h[0], h[2])) * t];
    const up = [(h[1] * side[2] - h[2] * side[1]) / l, (h[2] * side[0] - h[0] * side[2]) / l, (h[0] * side[1] - h[1] * side[0]) / l];
    box(wr, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], h, up, side, c);
  };
  for (let k = 0; k < n; k++) {
    const t = ((k + 0.5) / n) * L, cx = a[0] + u[0] * t, cz = a[1] + u[1] * t, y0 = groundAt(cx, cz);
    const at = (f, s, y) => [cx + d[0] * f + u[0] * s, y0 + y, cz + d[1] * f + u[1] * s]; // f: 輪の向き、s: 並びの向き
    bar(mt, at(-0.35, 0, 0), at(-0.35, 0, 0.8), 0.022, IRON);
    bar(mt, at(0.35, 0, 0), at(0.35, 0, 0.8), 0.022, IRON);
    bar(mt, at(-0.35, 0, 0.8), at(0.35, 0, 0.8), 0.022, IRON);
    if (hash01(seed0, k * 7 + 1) > 0.62) continue;
    // 自転車: 輪の脇（並びの向きに 0.14 m）に、輪と同じ向きで。前後は自転車ごと
    const sgn = hash01(seed0, k * 7 + 2) < 0.5 ? 1 : -1, so = hash01(seed0, k * 7 + 3) < 0.5 ? 0.14 : -0.14;
    const c = col(BIKE_COLORS[Math.floor(hash01(seed0, k * 7 + 4) * BIKE_COLORS.length)]);
    const B = (f, y) => at(f * sgn, so, y);
    for (const hub of [-0.52, 0.52]) {
      for (let j = 0; j < 10; j++) {
        const t0 = (j / 10) * Math.PI * 2, t1 = ((j + 1) / 10) * Math.PI * 2;
        bar(w, B(hub + Math.cos(t0) * 0.33, 0.34 + Math.sin(t0) * 0.33), B(hub + Math.cos(t1) * 0.33, 0.34 + Math.sin(t1) * 0.33), 0.018, TIRE);
      }
    }
    const rear = B(-0.52, 0.34), front = B(0.52, 0.34), bb = B(-0.08, 0.3), seat = B(-0.2, 0.86), head = B(0.36, 0.84), bars = B(0.4, 0.98);
    bar(w, rear, bb, 0.016, c);
    bar(w, bb, seat, 0.016, c);
    bar(w, rear, B(-0.17, 0.74), 0.014, c);
    bar(w, seat, head, 0.016, c);
    bar(w, bb, head, 0.018, c);
    bar(w, head, front, 0.016, c);
    bar(w, head, bars, 0.014, IRON);
    bar(w, at(0.4 * sgn, so - 0.22, 0.98), at(0.4 * sgn, so + 0.22, 0.98), 0.014, IRON);
    box(w, B(-0.22, 0.9), [d[0] * 0.12, 0, d[1] * 0.12], [0, 0.025, 0], [u[0] * 0.06, 0, u[1] * 0.06], SEAT);
  }
  colliders.push([a[0], a[1], b[0], b[1]]);
}

const WRITERS = { halls: writeHalls, gothic: writeGothic, hall: writeHall, market: writeMarket, barracks: writeBarracks, memorial: writeMemorial, bikeracks: writeBikeracks, shopstreet: writeShopstreet, trinite: writeTrinite, bollards: writeBollards, hgate: writeHospitalGate, lift: writeLift, pavilion: writePavilion, lock: writeLock, equestrian: writeEquestrian, wallFountain: writeWallFountain, capitainerie: writeCapitainerie, moorings: writeMoorings, riverfront: writeRiverfront, arcades: writeArcades, choir: writeChoir, ramblas: writeRamblas, basilica: writeBasilica, island: writeIsland, roundabout: writeRoundabout, portico: writePortico, donjon: writeDonjon, statue: writeStatue, dome: writeDome, chateau: writeChateau, stadium: writeStadium, cabanis: writeCabanis, coq: writeCoq, cross: writeCross, fastfood: writeFastfood, jgarden: writeJgarden, parterre: writeParterre, square: writeSquare, carousel: writeCarousel, griffoul: writeGriffoul, column: writeColumn };

// 名所のモデルを作る。colliders: 足す当たり判定の円 [x, z, r] か線分 [ax, az, bx, bz]、
// keepOut: 街の小物を置かない円 [x, z, r]（像の台・シャトー・ドーの柵の内側。monumentSolid）
const MASK_MATS = {
  mask: new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  }),
  reset: new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragDepth = 1.0; }',
    colorWrite: false, depthWrite: true, depthFunc: THREE.AlwaysDepth,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
  }),
};

export function buildMonuments(list, materials, { groundAt = () => 0, onRoad = () => false, waterAt = (x, z) => groundAt(x, z) - 2 } = {}) {
  const group = new THREE.Group();
  group.name = 'monuments';
  const W = { main: new MeshWriter(), metal: new MeshWriter(), inlay: new MeshWriter(), mask: new MeshWriter() };
  const colliders = [], keepOut = [];
  for (const m of list) WRITERS[m.kind](m, W, groundAt, colliders, onRoad, keepOut, waterAt);
  const mats = { main: materials.monument, metal: materials.monumentMetal, inlay: materials.monumentInlay };
  for (const key of ['main', 'metal', 'inlay']) {
    if (W[key].empty || !mats[key]) continue;
    const mesh = new THREE.Mesh(W[key].toGeometry(), mats[key]);
    mesh.name = `monument-${key}`;
    mesh.matrixAutoUpdate = false;
    if (key === 'inlay') {
      // 広場の石畳（地面の覆い・広場）より後に描き、polygonOffset で手前に出す
      mesh.renderOrder = ORDER.marking + 0.6;
      mesh.receiveShadow = true;
    } else {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    group.add(mesh);
  }
  if (!W.mask.empty) {
    // 地面の切り抜き（閘室）: 地面のあとに深度テスト付きでステンシルに印を付け、その所の深度を一番奥に戻す（metro.js と同じ）
    const geo = W.mask.toGeometry();
    for (const [mat, order, name] of [[MASK_MATS.mask, TERRAIN_ORDER.mask, 'monument-mask'], [MASK_MATS.reset, TERRAIN_ORDER.maskReset, 'monument-mask-reset']]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = order;
      mesh.name = name;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return { group, colliders, keepOut };
}

// ---- テクスチャ（6 区画: レンガ・ルーバー・観客席・ピッチ・外壁のパネル・無地）
export function makeMonumentTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S * NCELL;
  c.height = S;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(2207);
  // レンガ（1 区画 = 1.5 m 四方、段の高さ 5.5 cm）
  {
    const x0 = CELL.brick * S;
    ctx.fillStyle = '#d6b39c';
    ctx.fillRect(x0, 0, S, S);
    const BR = ['#c47658', '#bb6c50', '#cd8263', '#b5664c', '#c97b5c', '#b97a62'];
    const rowH = S / 27, bw = (0.42 / 1.5) * S;
    for (let r = 0; r < 27; r++) {
      const y = r * rowH;
      for (let x = -(r % 2) * (bw / 2); x < S; x += bw) {
        ctx.fillStyle = BR[Math.floor(rnd() * BR.length)];
        ctx.fillRect(x0 + Math.max(0, x) + 1, y + 1, Math.min(bw - 2, S - Math.max(0, x) - 1), rowH - 2);
      }
    }
  }
  // ルーバー（1 区画 = 1 階 ≒ 4.2 m 四方）: 暗いガラスの前にテラコッタ色の水平のルーバー、下に白い階の帯
  {
    const x0 = CELL.louvre * S;
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#4b5a66');
    g.addColorStop(1, '#2f3a44');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let x = 0; x < S; x += 64) ctx.fillRect(x0 + x, 0, 3, S);
    // 羽根は幅広く明るいテラコッタ（すき間のガラスは細く）、上の縁に光、下に影の線
    for (let y = 6; y < S - 30; y += 11) {
      ctx.fillStyle = rnd() < 0.5 ? '#c0704a' : '#c97b52';
      ctx.fillRect(x0, y, S, 8);
      ctx.fillStyle = 'rgba(255,225,190,0.35)';
      ctx.fillRect(x0, y, S, 1);
      ctx.fillStyle = 'rgba(40,20,10,0.45)';
      ctx.fillRect(x0, y + 7, S, 2);
    }
    ctx.fillStyle = '#efece6';
    ctx.fillRect(x0, S - 28, S, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x0, S - 28, S, 2);
  }
  // 観客席（1 区画 = 5 m 四方、6 段）: 紫の座席と灰色の段
  {
    const x0 = CELL.seats * S;
    ctx.fillStyle = '#9a9890';
    ctx.fillRect(x0, 0, S, S);
    const rowH = S / 6;
    for (let r = 0; r < 6; r++) {
      const y = r * rowH;
      for (let x = 0; x < S; x += 25.6) {
        ctx.fillStyle = rnd() < 0.06 ? '#d8d6d0' : rnd() < 0.5 ? '#5a2b74' : '#663383';
        ctx.fillRect(x0 + x + 2, y + 6, 21, rowH * 0.55);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x0, y + rowH - 3, S, 3);
    }
  }
  // ピッチ（区画全体 = 105 × 68 m）: 縞の芝と白線
  {
    const x0 = CELL.pitch * S;
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = i % 2 ? '#4e8a3a' : '#5a9844';
      ctx.fillRect(x0 + (i * S) / 14, 0, S / 14 + 1, S);
    }
    const kx = S / 105, ky = S / 68;
    ctx.strokeStyle = 'rgba(245,245,240,0.9)';
    ctx.lineWidth = 2;
    const rect = (x, y, w, h) => ctx.strokeRect(x0 + x * kx, y * ky, w * kx, h * ky);
    rect(1, 1, 103, 66);
    ctx.beginPath();
    ctx.moveTo(x0 + S / 2, ky);
    ctx.lineTo(x0 + S / 2, S - ky);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x0 + S / 2, S / 2, 9.15 * kx, 9.15 * ky, 0, 0, Math.PI * 2);
    ctx.stroke();
    rect(1, 34 - 20.15, 16.5, 40.3);
    rect(104 - 16.5, 34 - 20.15, 16.5, 40.3);
    rect(1, 34 - 9.16, 5.5, 18.32);
    rect(104 - 5.5, 34 - 9.16, 5.5, 18.32);
  }
  // スタジアムの外壁（1 区画 = 幅 8 m × 壁の高さ）: 白いパネル、上に暗いすき間の帯、下に入口の暗い帯
  {
    const x0 = CELL.cladding * S;
    ctx.fillStyle = '#eeede8';
    ctx.fillRect(x0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < S; x += 64) ctx.fillRect(x0 + x, 0, 2, S);
    for (let y = 40; y < S; y += 48) ctx.fillRect(x0, y, S, 2);
    ctx.fillStyle = '#3b3f45';
    ctx.fillRect(x0, 10, S, 18);
    ctx.fillStyle = '#4a4e54';
    ctx.fillRect(x0 + 40, S - 44, 70, 44);
    ctx.fillStyle = '#c9c7c0';
    ctx.fillRect(x0, S - 6, S, 6);
  }
  // 無地（色は頂点の色）
  {
    const x0 = CELL.plain * S;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(x0, 0, S, S);
    for (let i = 0; i < 900; i++) {
      const v = 225 + Math.floor(rnd() * 30);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x0 + rnd() * S, rnd() * S, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// エリア設定と名所データ。
// 名所の座標は「だいたいの位置」。起動時に OSM データ内の同名の地物を探して、
// 見つかればその実際の位置に置き換える（src/game/landmarks.js）。

export const AREA_PRESETS = {
  centre: {
    label: '旧市街（標準）',
    description: 'キャピトル広場を中心に半径 1.2 km。ガロンヌ川・運河・主な名所を含む',
    lat: 43.6020,
    lon: 1.4430,
    radius: 1200,
  },
  large: {
    label: '広域（重い）',
    description: '半径 1.8 km。読み込みに時間がかかり、メモリも多く使います',
    lat: 43.6020,
    lon: 1.4430,
    radius: 1800,
  },
  light: {
    label: '軽量',
    description: 'キャピトル周辺の半径 0.7 km。古いPCやスマホ向け',
    lat: 43.6035,
    lon: 1.4425,
    radius: 700,
  },
};

export const DEFAULT_AREA = 'centre';

// 地図データ形式のバージョン（変えると同梱データ・キャッシュが無効になる）
export const DATA_VERSION = 1;

// 名所。match は OSM の name タグに対する正規表現。
export const LANDMARKS = [
  {
    id: 'capitole',
    name: 'Capitole de Toulouse',
    ja: 'キャピトル（市庁舎）',
    lat: 43.60436, lon: 1.44357,
    match: /^(Capitole de Toulouse|H[ôo]tel de [Vv]ille de Toulouse|Mairie de Toulouse)$/i,
    text: '市庁舎と劇場を兼ねる街の顔。18世紀のファサードには、かつての市参事会員（カピトゥール）を象徴する8本のピンク大理石の円柱が並ぶ。',
  },
  {
    id: 'place-capitole',
    name: 'Place du Capitole',
    ja: 'キャピトル広場',
    lat: 43.60445, lon: 1.44440,
    match: /^Place du Capitole$/i,
    text: '旧市街の中心にある大広場。石畳にはレイモン・モレッティによる巨大なオクシタン十字が埋め込まれている。',
  },
  {
    id: 'saint-sernin',
    name: 'Basilique Saint-Sernin',
    ja: 'サン・セルナン大聖堂',
    lat: 43.60830, lon: 1.44190,
    match: /^Basilique (Saint-Sernin|Saint-Saturnin)/i,
    text: 'ヨーロッパ最大級のロマネスク様式の教会。サンティアゴ・デ・コンポステーラの巡礼路の一部として世界遺産に登録されている。',
  },
  {
    id: 'jacobins',
    name: 'Couvent des Jacobins',
    ja: 'ジャコバン修道院',
    lat: 43.60370, lon: 1.44030,
    match: /^(Couvent|Église|Ensemble conventuel) des Jacobins$/i,
    text: 'ドミニコ会の修道院。ヤシの葉のように広がる天井のリブ「パルミエ（棕櫚の木）」が有名。トマス・アクィナスの聖遺物が納められている。',
  },
  {
    id: 'saint-pierre',
    name: 'Place Saint-Pierre',
    ja: 'サン・ピエール広場',
    lat: 43.60420, lon: 1.43770,
    match: /^Place Saint-Pierre$/i,
    text: 'ガロンヌ川沿いの広場。夕方になると学生たちがテラスに集まる、トゥールーズの夜の名所。',
  },
  {
    id: 'daurade',
    name: 'Basilique Notre-Dame de la Daurade',
    ja: 'ドラード聖母教会',
    lat: 43.60110, lon: 1.43900,
    match: /Notre-Dame de la Daurade|^Place de la Daurade$/i,
    text: 'ガロンヌ川の岸辺に建つ教会。「黒い聖母」で知られる。前の河岸は夕日の名所。',
  },
  {
    id: 'pont-neuf',
    name: 'Pont Neuf',
    ja: 'ポン・ヌフ',
    lat: 43.59915, lon: 1.43760,
    match: /^Pont Neuf$/i,
    text: 'ガロンヌ川に架かるトゥールーズ最古の橋。16世紀に着工し、17世紀に完成した。大小のアーチと「目」と呼ばれる開口部が特徴。',
  },
  {
    id: 'hotel-dieu',
    name: 'Hôtel-Dieu Saint-Jacques',
    ja: 'オテル・デュー・サン・ジャック',
    lat: 43.59860, lon: 1.43530,
    match: /^Hôtel-Dieu( Saint-Jacques)?$/i,
    text: '左岸の旧病院。巡礼者を受け入れてきた歴史から、巡礼路の一部として世界遺産に登録されている。',
  },
  {
    id: 'chateau-eau',
    name: "Galerie du Château d'Eau",
    ja: 'シャトー・ドー写真ギャラリー',
    lat: 43.59880, lon: 1.43620,
    match: /^(Galerie du |[Ll]e )?Ch[âa]teau d['’][Ee]au$/i,
    text: 'ポン・ヌフの左岸側のたもとに建つ、19世紀の給水塔を利用した写真ギャラリー。',
  },
  {
    id: 'prairie-filtres',
    name: 'Prairie des Filtres',
    ja: 'フィルトル草原公園',
    lat: 43.59590, lon: 1.43640,
    match: /^Prairie des Filtres$/i,
    text: 'ガロンヌ左岸の広い河川公園。夏はピクニックや音楽フェスでにぎわう。',
  },
  {
    id: 'augustins',
    name: 'Musée des Augustins',
    ja: 'オーギュスタン美術館',
    lat: 43.60040, lon: 1.44650,
    match: /^Musée des Augustins/i,
    text: '旧アウグスチノ会修道院を使った美術館。南仏ゴシックの回廊が美しい。',
  },
  {
    id: 'saint-etienne',
    name: 'Cathédrale Saint-Étienne',
    ja: 'サン・テティエンヌ大聖堂',
    lat: 43.60000, lon: 1.45130,
    match: /^Cathédrale Saint-(É|E)tienne/i,
    text: '11世紀から17世紀にかけて建てられたため、様式の異なる部分がちぐはぐにつながった独特の大聖堂。',
  },
  {
    id: 'wilson',
    name: 'Place Wilson',
    ja: 'ウィルソン広場',
    lat: 43.60490, lon: 1.44860,
    match: /^(Place (du Président Thomas (Woodrow )?)?Wilson|Jardin Pierre Goudouli)$/i,
    text: '楕円形の広場。中央の噴水にはオック語詩人ピエール・グドゥリの像が立つ。',
  },
  {
    id: 'grand-rond',
    name: 'Jardin du Grand-Rond',
    ja: 'グラン・ロン公園',
    lat: 43.59470, lon: 1.45190,
    match: /^(Jardin du )?Grand[- ]Rond$/i,
    text: '大通りが放射状に集まる円形の公園。ジャルダン・ロワイヤル、植物園へと緑がつながる。',
  },
  {
    id: 'jardin-plantes',
    name: 'Jardin des Plantes',
    ja: '植物園（ジャルダン・デ・プラント）',
    lat: 43.59290, lon: 1.45070,
    match: /^Jardin des Plantes$/i,
    text: 'トゥールーズ自然史博物館に隣接する19世紀の庭園。池や小橋があり市民の憩いの場。',
  },
  {
    id: 'halle-grains',
    name: 'Halle aux Grains',
    ja: 'アル・オー・グラン',
    lat: 43.59960, lon: 1.45620,
    match: /^(la )?Halle aux Grains$/i,
    text: 'かつての穀物市場を改装したコンサートホール。キャピトル国立管弦楽団の本拠地。',
  },
  {
    id: 'matabiau',
    name: 'Gare Matabiau',
    ja: 'マタビオ駅',
    lat: 43.61120, lon: 1.45410,
    match: /^(Gare( de)? )?(Toulouse[- ])?Matabiau$/i,
    text: 'ミディ運河沿いに建つトゥールーズの中央駅。駅前の運河沿いは並木道になっている。',
  },
  {
    id: 'canal-midi',
    name: 'Canal du Midi',
    ja: 'ミディ運河',
    lat: 43.60800, lon: 1.45330,
    match: /^Canal du Midi$/i,
    text: '17世紀にピエール＝ポール・リケが建設した、大西洋と地中海を結ぶ水路の一部。世界遺産。',
  },
];

// 名所めぐりタイムアタックのコース（LANDMARKS の id の順番）
export const TOUR_ROUTE = [
  'place-capitole',
  'saint-sernin',
  'jacobins',
  'pont-neuf',
  'daurade',
  'augustins',
  'saint-etienne',
  'place-capitole',
];

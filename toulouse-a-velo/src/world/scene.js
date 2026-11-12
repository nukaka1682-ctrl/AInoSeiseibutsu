// レンダラー・シーン・空・太陽・環境マップ・霧（自転車のゲームとメトロのゲームで共通）。
// three.js のシェーダーの部品（トーンマッピング・高さの霧）を書き換えるので、ページで 1 回だけ呼ぶ
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { TIME_OF_DAY, TONE_MAPPING_GLSL, displayColor, environmentIntensity, probeEnvironment, shadowLook, sunDirection } from './light.js';

export function setupScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  // Neutral（Khronos PBR Neutral）は材料の色をそのまま出す（日なたのレンガの壁が白っぽく飛ばない）。
  // ただし暗い所の黒の差し引きは使わない（日陰のレンガが写真より暗く赤くなる。light.js）
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment
    .replace('vec3 CustomToneMapping( vec3 color ) { return color; }', TONE_MAPPING_GLSL);
  renderer.toneMapping = THREE.CustomToneMapping;
  // 高さで変わる霧（解析的な指数の高さの霧）: 霧の濃さは、カメラの高さ + tl m（近くは +30 m、1.6 km より遠くは +4 m）までは一定、
  // それより上は 12 m ごとに 1/e。カメラから点までの線に沿った濃さの平均を距離に掛けて「霧の中を通った長さ」にし、いつもの
  // smoothstep(fogNear, fogFar) に入れる。線に沿って積分するので、霧は距離とともに増え（逆転しない）、丘のふもとから頂上まで
  // なめらかに薄くなる（遠くの丘の稜線が霧の上に見える）。近くの建物（カメラより 30 m 上まで）は今までと同じ霧。
  // 建物・木・タイルの地面・遠くの地面のすべてに同じ霧をかける（読み込んだタイルの境で霧の濃さが変わらない）
  THREE.ShaderChunk.fog_pars_vertex += '\n#ifdef USE_FOG\nvarying float vFogY;\n#endif';
  THREE.ShaderChunk.fog_vertex += '\n#ifdef USE_FOG\nvFogY = (transpose(mat3(viewMatrix)) * mvPosition.xyz).y + cameraPosition.y;\n#endif';
  THREE.ShaderChunk.fog_pars_fragment += `
  #ifdef USE_FOG
  varying float vFogY;
  float fogG( float y, float yT ) { return y <= yT ? y : yT + 12.0 * ( 1.0 - exp( -( y - yT ) / 12.0 ) ); }
  float fogPath( float d ) {
    float yT = max( cameraPosition.y, 0.0 ) + 4.0 + 26.0 * ( 1.0 - smoothstep( 700.0, 1600.0, d ) );
    float ya = cameraPosition.y, dy = vFogY - ya;
    float avg = abs( dy ) < 0.5 ? exp( -max( 0.0, 0.5 * ( ya + vFogY ) - yT ) / 12.0 ) : ( fogG( vFogY, yT ) - fogG( ya, yT ) ) / dy;
    return d * avg;
  }
  #endif`;
  THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('smoothstep( fogNear, fogFar, vFogDepth )', 'smoothstep( fogNear, fogFar, fogPath( vFogDepth ) )');
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 8000); // 遠くの丘（パーパンからペシュ・ダヴィッドまで 6.3 km）
  camera.position.set(0, 40, 80);

  // 太陽（夜は月）の向き。時間帯で書き換える（同じ Vector3 を fitSunShadow が読む）。既定は午後のトゥールーズ: 南西の空に太陽
  const SUN_ELEVATION = 38, SUN_AZIMUTH = 225;
  const sunDir = new THREE.Vector3(...sunDirection(SUN_ELEVATION, SUN_AZIMUTH));
  const sky = new Sky();
  sky.scale.setScalar(4000);
  sky.renderOrder = -1000; // 最初に描く（深度を書かないので、箱より遠くの丘も上に描かれる）
  scene.add(sky);

  // ---- 光の強さの割合（写真の日なたと日陰のレンガの色に合わせた） ----
  // 太陽（暖色、影を落とす）: 日なたのレンガは #bc7c55 前後。半球光: 日陰のレンガは #644337 前後で、道の片側は深い日陰になる
  // （太陽と半球光の比は 2 倍あまり）。写真の日陰は空の青さより、日の当たった向かいの壁や地面からの照り返し（暖色）が効いて
  // ほぼ無彩色なので、半球光の地面の色はばら色のレンガの照り返しにする。環境マップ（青い空）は弱く、空の光の一部と映り込み
  // （午後の値。ほかの時間帯の色・強さは light.js の TIME_OF_DAY）
  const LIGHT = { sun: 2.8, hemi: 1.3, envShare: 0.4, envFallback: 0.06 };
  const hemi = new THREE.HemisphereLight('#cfdcef', '#a48a76', LIGHT.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0d8', LIGHT.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -100, right: 100, top: 100, bottom: -100, near: 1, far: 1200 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.25;
  scene.add(sun, sun.target);

  // 地平線のもや: 空の地平線の近くを霧の色に寄せる（霧で溶けた遠くの街並みと、その向こうの空の色がそろう）。
  // 空のシェーダーの最後（sRGB にした後）で混ぜるので、霧と同じく画面の色で指定する。
  // 夜（uNight）: その前に、空を「天頂 #070c1f → 地平線 #27325a」のグラデーションと星・月に置き換える。星は向きを細かい格子
  // （1 目 0.23°）に切ったハッシュで点を打つ（向きだけで決まるので、カメラが動いてもちらつかない。地平線の近くには出さない）。
  // 月は月の向き（夜の sunPosition）に直径 1.2° の淡い黄白の円盤とかすかな暈
  sky.material.uniforms.hazeColor = { value: new THREE.Vector3() };
  sky.material.uniforms.uNight = { value: 0 };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform float showSunDisc;', 'uniform float showSunDisc;\nuniform vec3 hazeColor;\nuniform float uNight;')
    .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
        if (uNight > 0.0) {
          vec3 nightSky = mix(vec3(0.153, 0.196, 0.353), vec3(0.027, 0.047, 0.122), pow(smoothstep(0.0, 1.0, max(direction.y, 0.0)), 0.6));
          vec3 sp = direction * 250.0, cell = floor(sp), sf = fract(sp) - 0.5;
          float sh = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          float star = step(0.992, sh) * smoothstep(0.38, 0.1, length(sf)) * (0.3 + 0.7 * fract(sh * 91.7)) * smoothstep(0.06, 0.3, direction.y);
          nightSky += vec3(0.8, 0.86, 1.0) * star;
          float mc = dot(direction, vSunDirection);
          nightSky += vec3(0.07, 0.08, 0.1) * pow(max(mc, 0.0), 800.0);
          nightSky = mix(nightSky, vec3(0.95, 0.93, 0.84), smoothstep(0.999941, 0.999952, mc));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, nightSky, uNight);
        }
        float hazeK = 1.0 - smoothstep(0.0, 0.2, direction.y);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, hazeK * hazeK);`);
  sky.material.needsUpdate = true;

  // 環境マップ: 太陽の円盤を抜いた空と、地平線より下の地面（街の色）。太陽の円盤は平行光が受け持つ
  // （環境マップに入れると、影の中まで太陽の光が回り込んで影が消える）。
  // 夜は空のシェーダーの代わりに、同じグラデーションの球（頂点カラー）と、街灯に照らされた暖色の地面
  function bakeEnvironment(look) {
    const envScene = new THREE.Scene();
    const temp = [];
    if (look.night > 0) {
      const g = new THREE.SphereGeometry(100, 32, 16);
      const pos = g.getAttribute('position'), col = new Float32Array(pos.count * 3);
      const lo = new THREE.Color('#27325a'), hi = new THREE.Color('#070c1f'), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) c.lerpColors(lo, hi, Math.pow(Math.max(0, pos.getY(i) / 100), 0.6)).toArray(col, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      temp.push(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    } else {
      const skyClone = new Sky();
      skyClone.scale.setScalar(100);
      for (const k of Object.keys(skyClone.material.uniforms)) {
        const v = sky.material.uniforms[k].value;
        skyClone.material.uniforms[k].value = v?.clone ? v.clone() : v;
      }
      skyClone.material.uniforms.showSunDisc.value = 0;
      temp.push(skyClone);
    }
    envScene.add(...temp);
    // 地面: 日なたと日陰が混ざった街の平均の明るさ（反射率 0.22 前後）
    const lit = ((look.sun.intensity * Math.sin(THREE.MathUtils.degToRad(look.sun.elevation)) + look.hemi.intensity) * 0.85) / Math.PI;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(48, 32), new THREE.MeshBasicMaterial({ color: look.night > 0 ? '#8a6a4e' : '#8f7a6a' }));
    ground.material.color.multiplyScalar(lit);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.4;
    envScene.add(ground);
    const probe = measureEnvironment(envScene);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const tex = pmrem.fromScene(envScene, 0.02).texture;
    // 水面に映す環境: 低い角度には空でなく対岸の街並みと並木（暗い帯、仰角 0〜7°）が映る
    const skyline = new THREE.Mesh(
      new THREE.CylinderGeometry(46, 46, 46 * Math.tan(THREE.MathUtils.degToRad(7)) + 0.4, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: look.night > 0 ? '#7a5838' : '#6a5d50', side: THREE.BackSide }),
    );
    skyline.material.color.multiplyScalar(lit * 0.8);
    skyline.position.y = (46 * Math.tan(THREE.MathUtils.degToRad(7)) - 0.4) / 2;
    envScene.add(skyline);
    const water = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    for (const o of [...temp, ground, skyline]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    return { envMap: tex, waterEnv: water, probe };
  }

  // 時間帯を変える（light.js の TIME_OF_DAY の id）。太陽・空・半球光・露出・環境マップ・霧・空のもやを作り直す。
  // 戻り値: 水面用の環境マップ（使う側が水の材料に入れる）と夜の割合（0〜1）
  const timeOfDay = { id: null };
  const shadowFit = { half: 0, fwd: new THREE.Vector3(), c: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), dist: 600, normalBias: 1 };
  const env = { envMap: null, waterEnv: null };
  function applyTimeOfDay(id) {
    const look = TIME_OF_DAY[id] || TIME_OF_DAY.afternoon;
    timeOfDay.id = TIME_OF_DAY[id] ? id : 'afternoon';
    sunDir.set(...sunDirection(look.sun.elevation, look.sun.azimuth));
    const u = sky.material.uniforms;
    for (const [k, v] of Object.entries(look.sky)) u[k].value = v;
    u.sunPosition.value.copy(sunDir);
    u.showSunDisc.value = look.night > 0 ? 0 : 1; // 夜は太陽の円盤を消す（月は夜の空のシェーダーが描く）
    u.uNight.value = look.night;
    hemi.color.set(look.hemi.sky);
    hemi.groundColor.set(look.hemi.ground);
    hemi.intensity = look.hemi.intensity;
    sun.color.set(look.sun.color);
    sun.intensity = look.sun.intensity;
    renderer.toneMappingExposure = look.exposure;
    // 影の箱: 低い太陽は奥行きを長く、ずらしを大きく（fitSunShadow が読む。次のフレームで箱を作り直す）
    const sl = shadowLook(look.sun.elevation);
    shadowFit.dist = sl.dist;
    shadowFit.normalBias = sl.normalBias;
    shadowFit.half = 0;
    sun.shadow.camera.far = sl.dist * 2;
    sun.shadow.camera.updateProjectionMatrix();

    const old = [env.envMap, env.waterEnv];
    const { envMap, waterEnv, probe } = bakeEnvironment(look);
    for (const t of old) t?.dispose();
    Object.assign(env, { envMap, waterEnv });
    scene.environment = envMap;
    const k = probe && environmentIntensity(probe.up, hemi.color.toArray(), hemi.intensity, LIGHT.envShare);
    scene.environmentIntensity = k || LIGHT.envFallback;
    // 霧の色 = 画面に映る地平線の空の色（遠くの街並みが空に溶ける）。写真のように少し灰色がかったばら色に寄せる
    // （霧の near / far は使う側がエリアで決める）
    const fog = new THREE.Color('#c9d3da');
    if (probe) fog.setRGB(...displayColor(probe.horizon, renderer.toneMappingExposure), THREE.SRGBColorSpace);
    fog.lerp(new THREE.Color(look.fogTint), look.fogMix);
    if (scene.fog) scene.fog.color.copy(fog);
    else scene.fog = new THREE.Fog(fog, 280, 1500);
    const haze = scene.fog.color.clone().convertLinearToSRGB();
    u.hazeColor.value.set(haze.r, haze.g, haze.b);
    window.__tavLight = { probe, environmentIntensity: scene.environmentIntensity, fog: fog.getHexString(), timeOfDay: timeOfDay.id }; // デバッグ用
    return { waterEnv, night: look.night };
  }

  // 環境の明るさを測る: 小さな浮動小数点の画像に 6 方向を描いて読み戻す（読み戻せない環境では null）
  function measureEnvironment(envScene) {
    const S = 16;
    const rt = new THREE.WebGLRenderTarget(S, S, { type: THREE.HalfFloatType, depthBuffer: true });
    const cam = new THREE.PerspectiveCamera(90, 1, 0.05, 200);
    const buf = new Uint16Array(S * S * 4);
    const faces = [];
    const views = [[0, 1, 0, 0, 0, -1], [0, -1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0]];
    const prev = renderer.getRenderTarget();
    try {
      for (const [x, y, z, ux, uy, uz] of views) {
        cam.up.set(ux, uy, uz);
        cam.lookAt(x, y, z);
        cam.updateMatrixWorld();
        renderer.setRenderTarget(rt);
        renderer.render(envScene, cam);
        buf.fill(0);
        renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
        const e = cam.matrixWorld.elements;
        faces.push({
          data: Float32Array.from(buf, (h) => THREE.DataUtils.fromHalfFloat(h)), size: S,
          right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], forward: [-e[8], -e[9], -e[10]],
        });
      }
      const p = probeEnvironment(faces);
      return p.up.every((v) => Number.isFinite(v)) && p.up[1] > 1e-4 ? p : null;
    } catch (err) {
      console.warn('環境の明るさを測れませんでした', err);
      return null;
    } finally {
      renderer.setRenderTarget(prev);
      rt.dispose();
    }
  }

  // 太陽の影の箱をカメラに合わせる: 低い視点は手前 ±100 m、上空ほど広く（最大 ±320 m）、見ている方へずらす。
  // 箱の中心は影の地図の 1 画素単位にそろえ、動いても影の縁がちらつかないようにする。
  // 太陽までの距離（dist）と法線方向のずらしの倍率（normalBias）は時間帯で決まる（applyTimeOfDay）
  function fitSunShadow(groundAt = null) {
    const f = shadowFit;
    if (f.lock) return; // デバッグ用: 影の箱を固定する
    const gy = groundAt ? groundAt(camera.position.x, camera.position.z) : 0; // 地面の高さ
    const h = Math.max(1.5, camera.position.y - gy);
    const half = Math.min(320, Math.round((95 + h * 2.2) / 10) * 10);
    camera.getWorldDirection(f.fwd);
    const down = -f.fwd.y;
    f.fwd.y = 0;
    const fl = f.fwd.length();
    if (fl < 1e-4) f.fwd.set(0, 0, -1);
    else f.fwd.divideScalar(fl);
    const look = down > 0.02 ? (h / down) * fl : Infinity; // 見ている点までの水平距離
    const ahead = Math.min(Math.max(look, half * 0.45), half * 0.7);
    const c = f.c.set(camera.position.x, gy, camera.position.z).addScaledVector(f.fwd, ahead);
    f.x.crossVectors(sun.up, sunDir).normalize(); // 影のカメラの x・y 軸（lookAt と同じ向き）
    f.y.crossVectors(sunDir, f.x);
    const texel = (2 * half) / sun.shadow.mapSize.x;
    const px = c.dot(f.x), py = c.dot(f.y);
    c.addScaledVector(f.x, Math.round(px / texel) * texel - px).addScaledVector(f.y, Math.round(py / texel) * texel - py);
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(sunDir, f.dist);
    if (half !== f.half) {
      f.half = half;
      Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.normalBias = Math.max(0.12, texel * 2.2) * f.normalBias;
    }
  }

  // 既定は午後（メトロのゲームは時間帯を変えない）
  applyTimeOfDay('afternoon');
  const { envMap, waterEnv } = env;

  return { renderer, scene, camera, sky, sun, hemi, sunDir, envMap, waterEnv, LIGHT, shadowFit, fitSunShadow, SUN_ELEVATION, SUN_AZIMUTH, applyTimeOfDay, timeOfDay };
}

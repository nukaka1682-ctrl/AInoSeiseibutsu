// レンダラー・シーン・空・太陽・環境マップ・霧（自転車のゲームとメトロのゲームで共通）。
// three.js のシェーダーの部品（トーンマッピング・高さの霧）を書き換えるので、ページで 1 回だけ呼ぶ
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { TONE_MAPPING_GLSL, displayColor, environmentIntensity, probeEnvironment } from './light.js';

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

  // 午後のトゥールーズ: 南西の空に太陽
  const SUN_ELEVATION = 38, SUN_AZIMUTH = 225;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(180 - SUN_AZIMUTH),
  );
  const sky = new Sky();
  sky.scale.setScalar(4000);
  sky.renderOrder = -1000; // 最初に描く（深度を書かないので、箱より遠くの丘も上に描かれる）
  sky.material.uniforms.turbidity.value = 3.5;
  sky.material.uniforms.rayleigh.value = 1.4;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.82;
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // ---- 光の強さの割合（写真の日なたと日陰のレンガの色に合わせた） ----
  // 太陽（暖色、影を落とす）: 日なたのレンガは #bc7c55 前後。半球光: 日陰のレンガは #644337 前後で、道の片側は深い日陰になる
  // （太陽と半球光の比は 2 倍あまり）。写真の日陰は空の青さより、日の当たった向かいの壁や地面からの照り返し（暖色）が効いて
  // ほぼ無彩色なので、半球光の地面の色はばら色のレンガの照り返しにする。環境マップ（青い空）は弱く、空の光の一部と映り込み
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

  // 環境マップ: 太陽の円盤を抜いた空と、地平線より下の地面（街の色）。太陽の円盤は平行光が受け持つ
  // （環境マップに入れると、影の中まで太陽の光が回り込んで影が消える）
  const { envMap, waterEnv } = (() => {
    const envScene = new THREE.Scene();
    const skyClone = new Sky();
    skyClone.scale.setScalar(100);
    for (const k of Object.keys(sky.material.uniforms)) {
      const v = sky.material.uniforms[k].value;
      skyClone.material.uniforms[k].value = v?.clone ? v.clone() : v;
    }
    skyClone.material.uniforms.showSunDisc.value = 0;
    envScene.add(skyClone);
    // 地面: 日なたと日陰が混ざった街の平均の明るさ（反射率 0.22 前後）
    const lit = ((LIGHT.sun * Math.sin(THREE.MathUtils.degToRad(SUN_ELEVATION)) + LIGHT.hemi) * 0.85) / Math.PI;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(48, 32), new THREE.MeshBasicMaterial({ color: '#8f7a6a' }));
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
      new THREE.MeshBasicMaterial({ color: '#6a5d50', side: THREE.BackSide }),
    );
    skyline.material.color.multiplyScalar(lit * 0.8);
    skyline.position.y = (46 * Math.tan(THREE.MathUtils.degToRad(7)) - 0.4) / 2;
    envScene.add(skyline);
    const water = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    const k = probe && environmentIntensity(probe.up, hemi.color.toArray(), hemi.intensity, LIGHT.envShare);
    scene.environmentIntensity = k || LIGHT.envFallback;
    // 霧の色 = 画面に映る地平線の空の色（遠くの街並みが空に溶ける）。写真のように少し灰色がかったばら色に寄せる
    const fog = new THREE.Color('#c9d3da');
    if (probe) fog.setRGB(...displayColor(probe.horizon, renderer.toneMappingExposure), THREE.SRGBColorSpace);
    fog.lerp(new THREE.Color('#bdb5b2'), 0.35);
    scene.fog = new THREE.Fog(fog, 280, 1500);
    window.__tavLight = { probe, environmentIntensity: scene.environmentIntensity, fog: fog.getHexString() }; // デバッグ用
    return { envMap: tex, waterEnv: water };
  })();
  scene.environment = envMap;

  // 地平線のもや: 空の地平線の近くを霧の色に寄せる（霧で溶けた遠くの街並みと、その向こうの空の色がそろう）。
  // 空のシェーダーの最後（sRGB にした後）で混ぜるので、霧と同じく画面の色で指定する
  {
    const haze = scene.fog.color.clone().convertLinearToSRGB();
    sky.material.uniforms.hazeColor = { value: new THREE.Vector3(haze.r, haze.g, haze.b) };
    sky.material.fragmentShader = sky.material.fragmentShader
      .replace('uniform float showSunDisc;', 'uniform float showSunDisc;\nuniform vec3 hazeColor;')
      .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
        float hazeK = 1.0 - smoothstep(0.0, 0.2, direction.y);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, hazeK * hazeK);`);
    sky.material.needsUpdate = true;
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
  // 箱の中心は影の地図の 1 画素単位にそろえ、動いても影の縁がちらつかないようにする
  const shadowFit = { half: 0, fwd: new THREE.Vector3(), c: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3() };
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
    sun.position.copy(c).addScaledVector(sunDir, 600);
    if (half !== f.half) {
      f.half = half;
      Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.normalBias = Math.max(0.12, texel * 2.2);
    }
  }

  return { renderer, scene, camera, sky, sun, hemi, sunDir, envMap, waterEnv, LIGHT, shadowFit, fitSunShadow, SUN_ELEVATION, SUN_AZIMUTH };
}

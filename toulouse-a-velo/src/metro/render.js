// 写真のように見せる描画の後処理（メトロのゲーム。「フォトリアル」の設定）:
// 1. シーンを HDR（半精度の浮動小数）の画像に描く。深度とステンシルを持つ（地面の水・出入口の吹き抜けの穴はステンシル）
// 2. GTAO（地上・駅の隅や物の足もとが暗くなる、環境光の遮り）。法線は描いた深度から作る（シーンを 2 回描かない）。半分の解像度
// 3. ブルーム（蛍光灯・LED・日なたの白い面・太陽の光のにじみ。強い所だけ、弱く）
// 4. トーンマッピングと色の空間（renderer の設定のまま。OutputPass）
// 5. 写真の仕上げ: 周辺減光と、ごく弱い粒子（動画の撮像素子のノイズ）
// 6. SMAA（縁のぎざぎざを消す）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.22 }, uGrain: { value: 0.018 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // 周辺減光（レンズの端が少し暗い）
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      // 粒子（暗い所ほど目立つ）
      float n = hash(vUv * 1024.0 + fract(uTime) * 61.0) - 0.5;
      float g = uGrain * (1.0 - 0.6 * dot(c.rgb, vec3(0.333)));
      gl_FragColor = vec4(c.rgb * v + n * g, c.a);
    }`,
};

export function createPipeline(renderer, scene, camera) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const depth = new THREE.DepthTexture(size.x, size.y);
  depth.format = THREE.DepthStencilFormat;
  depth.type = THREE.UnsignedInt248Type;
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthTexture: depth, stencilBuffer: true, depthBuffer: true });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const gtao = new GTAOPass(scene, camera, Math.max(1, size.x >> 1), Math.max(1, size.y >> 1));
  gtao.setGBuffer(composer.readBuffer.depthTexture); // 描いた深度から（法線も深度から）
  gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.4, scale: 1.0, samples: 16, distanceFallOff: 1.0 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.85;
  const gtaoSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => gtaoSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); // AO は半分の解像度
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x >> 1, size.y >> 1), 0.22, 0.45, 1.05);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finish = new ShaderPass(FinishShader);
  composer.addPass(finish);
  const smaa = new SMAAPass();
  composer.addPass(smaa);

  const pipe = {
    enabled: true,
    composer, gtao, bloom, finish,
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    // under: 地下の割合（0 地上〜1 地下）。地下は AO を少し強く、蛍光灯（HDR で 6 倍）だけがにじむ閾値に
    render(dt, { under = 0 } = {}) {
      if (!pipe.enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      // 描く先は毎フレーム入れ替わるので、AO の読む深度もそれに合わせる
      const tex = composer.readBuffer.depthTexture;
      if (gtao.depthTexture !== tex) {
        gtao.depthTexture = tex;
        gtao.gtaoMaterial.uniforms.tDepth.value = tex;
        gtao.pdMaterial.uniforms.tDepth.value = tex;
      }
      const k = Math.max(0, Math.min(1, +under));
      gtao.blendIntensity = 0.8 + 0.15 * k;
      bloom.threshold = 2.2 + 1.0 * k;
      bloom.strength = 0.08 + 0.2 * k;
      finish.uniforms.uTime.value += dt;
      composer.render(dt);
    },
  };
  pipe.setSize(innerWidth, innerHeight);
  return pipe;
}

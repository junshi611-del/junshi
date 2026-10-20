import * as THREE from 'three';

/* ============================================================
   奶蛙快跑 · Naiwa Run
   纯静态 Three.js 3D 跑酷：程序化奶蛙建模 + 对象池 + WebAudio 合成音
   ============================================================ */

// ---------------- 工具 ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[(Math.random() * arr.length) | 0];

// ---------------- 配置 ----------------
const LANE_X = [-2.2, 0, 2.2];
const START_SPEED = 10, MAX_SPEED = 27, SPEED_GAIN = 0.16; // 每秒加速
const GRAVITY = -25, JUMP_V = 8.8, SLIDE_DUR = 0.68;
const PLAYER_HALF_W = 0.40, PLAYER_H = 1.22, PLAYER_H_SLIDE = 0.55;
const SPAWN_Z = -135, DESPAWN_Z = 14;
const BEST_KEY = 'naiwa-best', MUTE_KEY = 'naiwa-muted';

// ---------------- DOM ----------------
const $ = id => document.getElementById(id);
const canvas = $('game-canvas');
const hud = $('hud'), scoreVal = $('scoreVal'), distVal = $('distVal'), coinVal = $('coinVal');
const livesEl = $('lives');
const titleScreen = $('titleScreen'), pauseScreen = $('pauseScreen'), overScreen = $('overScreen');
const touchControls = $('touchControls'), glFallback = $('glFallback');
const HEART_SVG = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-10-9.2C.5 8.6 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.6h4C14.9 6.1 16.3 5 18.3 5c3.4 0 5.2 3.6 3.7 6.8C19.5 16.1 12 21 12 21z" transform="scale(0.92) translate(1,0.6)"/></svg>';

// ---------------- 游戏状态 ----------------
let state = 'title';        // title | playing | over
let paused = false;
let lives = 3, score = 0, coinCount = 0, distance = 0, worldSpeed = 0;
let best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
let invincibleT = 0, shakeT = 0;
let laneIdx = 1, playerX = 0, playerY = 0, vy = 0, grounded = true;
let sliding = false, slideT = 0, pendingSlide = false;
let spawnIn = 30;           // 距离计数器：下一次刷怪还差多少米

// ============================================================
//  音频：Web Audio 全程序化合成（音乐 + 4 种音效）
// ============================================================
const AudioSys = {
  ctx: null, master: null, musicGain: null, sfxGain: null,
  muted: localStorage.getItem(MUTE_KEY) === '1',
  musicTimer: null, step: 0, nextT: 0,

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.5; this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.9; this.sfxGain.connect(this.master);
  },
  setMuted(m) {
    this.muted = m;
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.02);
    updateMuteIcon();
  },
  // ---- 音效 ----
  tone({ freq = 440, freqEnd = null, type = 'sine', dur = 0.15, vol = 0.25, when = 0, curve = 'exp' }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t + dur);
    g.gain.setValueAtTime(vol, t);
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    else g.gain.linearRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise({ dur = 0.2, vol = 0.2, when = 0, filterFreq = 1200 }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.sfxGain);
    src.start(t);
  },
  jump()  { this.tone({ freq: 320, freqEnd: 720, type: 'square', dur: 0.18, vol: 0.16 }); },
  slide() { this.noise({ dur: 0.22, vol: 0.12, filterFreq: 900 }); },
  coin()  { this.tone({ freq: 1318, type: 'sine', dur: 0.08, vol: 0.22 }); this.tone({ freq: 1760, type: 'sine', dur: 0.12, vol: 0.22, when: 0.07 }); },
  hit()   { this.tone({ freq: 170, freqEnd: 55, type: 'sawtooth', dur: 0.32, vol: 0.3 }); this.noise({ dur: 0.25, vol: 0.22, filterFreq: 700 }); },
  click() { this.tone({ freq: 840, type: 'square', dur: 0.06, vol: 0.12 }); },
  // ---- 背景音乐：C 大调欢快琶音循环 ----
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    this.step = 0; this.nextT = this.ctx.currentTime + 0.06;
    this.musicTimer = setInterval(() => this.schedule(), 40);
  },
  stopMusic() { if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; } },
  schedule() {
    if (!this.ctx || this.muted) { this.nextT = Math.max(this.nextT, this.ctx.currentTime + 0.05); }
    const STEP = 60 / 138 / 2; // 138bpm 八分音符
    // 主旋律（midi），16 步一循环
    const LEAD = [72, 76, 79, 76, 81, 79, 76, 74, 72, 76, 79, 81, 83, 81, 79, 76];
    const BASS = [48, 0, 0, 0, 53, 0, 0, 0, 55, 0, 0, 0, 55, 0, 53, 0];
    while (this.nextT < this.ctx.currentTime + 0.14) {
      const s = this.step % 16;
      const mf = m => 440 * Math.pow(2, (m - 69) / 12);
      if (LEAD[s]) this.mnote(mf(LEAD[s]), this.nextT, STEP * 0.92, 'triangle', 0.085);
      if (BASS[s]) this.mnote(mf(BASS[s]), this.nextT, STEP * 1.8, 'sine', 0.075);
      this.nextT += STEP; this.step++;
    }
  },
  mnote(freq, t, dur, type, vol) {
    if (this.muted) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.musicGain);
    o.start(t); o.stop(t + dur + 0.03);
  }
};

function updateMuteIcon() {
  $('soundOnIcon').style.display = AudioSys.muted ? 'none' : '';
  $('soundOffIcon').style.display = AudioSys.muted ? '' : 'none';
}
updateMuteIcon();

// ============================================================
//  Three.js 场景
// ============================================================
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  glFallback.classList.remove('hidden');
  titleScreen.classList.add('hidden');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xD8F0FA, 42, 150);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
const camPos = new THREE.Vector3(0, 1.5, 4.8);      // 标题屏机位
const camPosTarget = camPos.clone();
const lookAt = new THREE.Vector3(0, 0.8, 0);
const lookAtTarget = lookAt.clone();

// 灯光
scene.add(new THREE.HemisphereLight(0xCDEFFF, 0x8BC34A, 0.85));
const sun = new THREE.DirectionalLight(0xFFF3D6, 1.25);
sun.position.set(7, 14, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -14; sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -30;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 45;
sun.shadow.bias = -0.002;
sun.target.position.set(0, 0, -8);
scene.add(sun, sun.target);

// 天空渐变穹顶
{
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x6FC3F2) },
      mid: { value: new THREE.Color(0xCDEEFb) },
      bot: { value: new THREE.Color(0xFFF4D6) }
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main(){ float h = normalize(vP).y;
        vec3 c = h > 0.10 ? mix(mid, top, smoothstep(0.10, 0.62, h)) : mix(bot, mid, smoothstep(-0.06, 0.10, h));
        gl_FragColor = vec4(c, 1.0); }`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(420, 24, 14), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);
}

// ---------------- canvas 纹理 ----------------
function canvasTex(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const trackTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#BFC6D2'; g.fillRect(0, 0, s, s);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 160; i++) g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
  g.fillStyle = '#FFF6DE'; g.fillRect(0, 0, 9, s); g.fillRect(s - 9, 0, 9, s); // 边缘线
  g.fillStyle = '#FFFFFF';
  for (const x of [s / 3 - 3, (2 * s) / 3 - 3]) g.fillRect(x, 14, 6, 90);       // 车道虚线
}, 1, 20);
const grassTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#7FC24F'; g.fillRect(0, 0, s, s);
  g.fillStyle = 'rgba(90,160,50,0.5)';
  for (let i = 0; i < 220; i++) g.fillRect(Math.random() * s, Math.random() * s, 4, 4);
  g.fillStyle = 'rgba(180,230,130,0.5)';
  for (let i = 0; i < 120; i++) g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
}, 4, 26);
const stripeTex = canvasTex(128, (g, s) => {
  g.fillStyle = '#FF9F2E'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#FFF6DE';
  for (let i = -s; i < s * 2; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 - s, s); g.lineTo(i - s, s); g.fill(); }
});

// ---------------- 地面 ----------------
const TRACK_LEN = 210;
{
  const trackMat = new THREE.MeshLambertMaterial({ map: trackTex });
  const track = new THREE.Mesh(new THREE.PlaneGeometry(8.6, TRACK_LEN), trackMat);
  track.rotation.x = -Math.PI / 2; track.position.set(0, 0, -88); track.receiveShadow = true;
  scene.add(track);
  const grassMat = new THREE.MeshLambertMaterial({ map: grassTex });
  for (const side of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(70, TRACK_LEN), grassMat);
    g.rotation.x = -Math.PI / 2; g.position.set(side * (4.3 + 35), -0.03, -88); g.receiveShadow = true;
    scene.add(g);
  }
}

// ---------------- 环境对象池：云 / 山丘 / 树 / 路灯 ----------------
const clouds = [];
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  for (let i = 0; i < 8; i++) {
    const grp = new THREE.Group();
    const n = randInt(3, 5);
    for (let j = 0; j < n; j++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(rand(1.2, 2.4), 7, 6), mat);
      m.position.set(j * rand(1.4, 2.0) - n, rand(-0.3, 0.3), rand(-0.6, 0.6));
      m.scale.y = 0.62; grp.add(m);
    }
    grp.position.set(rand(-55, 55), rand(15, 27), rand(-150, 15));
    scene.add(grp); clouds.push(grp);
  }
}
const hills = [];
{
  const mats = [0x8FD07A, 0x79BE63].map(c => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(rand(14, 26), rand(7, 13), 7), pick(mats));
    m.position.set((i % 2 ? 1 : -1) * rand(26, 60), 0, rand(-160, -40));
    m.position.y = m.geometry.parameters.height / 2 - 0.5;
    scene.add(m); hills.push(m);
  }
}
const decorPool = []; // {grp, active}
function makeTree() {
  const grp = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.15, 0.7, 7),
    new THREE.MeshLambertMaterial({ color: 0x8A6238 }));
  trunk.position.y = 0.35; trunk.castShadow = true; grp.add(trunk);
  const greens = [0x5FAE3E, 0x6FBF47, 0x52A038];
  const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.5, 8),
    new THREE.MeshLambertMaterial({ color: pick(greens), flatShading: true }));
  c1.position.y = 1.35; c1.castShadow = true; grp.add(c1);
  const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.0, 8), c1.material);
  c2.position.y = 2.05; c2.castShadow = true; grp.add(c2);
  return grp;
}
function makeLamp() {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8),
    new THREE.MeshLambertMaterial({ color: 0x5B6470 }));
  pole.position.y = 1.4; pole.castShadow = true; grp.add(pole);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xFFF3B0, emissive: 0xFFDD55, emissiveIntensity: 0.9 }));
  bulb.position.y = 2.85; grp.add(bulb);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.18, 8),
    new THREE.MeshLambertMaterial({ color: 0xF6C945 }));
  cap.position.y = 3.0; grp.add(cap);
  return grp;
}
for (let i = 0; i < 22; i++) {
  const grp = i % 3 === 2 ? makeLamp() : makeTree();
  grp.visible = false; scene.add(grp);
  decorPool.push({ grp, active: false });
}
let decorIn = 3;
function spawnDecor() {
  const d = decorPool.find(d => !d.active);
  if (!d) return;
  const side = Math.random() < 0.5 ? -1 : 1;
  d.grp.position.set(side * rand(5.6, 9.5), 0, SPAWN_Z - 10);
  d.grp.rotation.y = rand(0, Math.PI * 2);
  const s = rand(0.85, 1.3); d.grp.scale.set(s, s, s);
  d.grp.visible = true; d.active = true;
}

// ============================================================
//  奶蛙：纯几何体程序化建模（黄圆身、大眼、腮红、微笑、小短手腿）
// ============================================================
const MAT = {
  body: new THREE.MeshStandardMaterial({ color: 0xF6C945, roughness: 0.55 }),
  belly: new THREE.MeshStandardMaterial({ color: 0xFFF6E0, roughness: 0.8 }),
  white: new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.35 }),
  pupil: new THREE.MeshStandardMaterial({ color: 0x24211C, roughness: 0.25 }),
  cheek: new THREE.MeshStandardMaterial({ color: 0xFF9EBB, roughness: 0.9 }),
  mouth: new THREE.MeshStandardMaterial({ color: 0x7A4A21, roughness: 0.7 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x5FAE3E, roughness: 0.8, flatShading: true })
};

function buildFrog() {
  const root = new THREE.Group();        // 位置/朝向
  const squash = new THREE.Group();      // 挤压拉伸
  const bob = new THREE.Group();         // 弹跳/俯仰
  root.add(squash); squash.add(bob);

  const cast = m => { m.castShadow = true; return m; };

  // 圆滚滚身体
  const bodyM = cast(new THREE.Mesh(new THREE.SphereGeometry(0.55, 28, 22), MAT.body));
  bodyM.scale.set(1.06, 0.96, 0.92); bodyM.position.y = 0.60;
  bob.add(bodyM);
  // 奶白肚皮
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 16), MAT.belly);
  belly.scale.set(0.95, 1.08, 0.52); belly.position.set(0, 0.46, 0.31);
  bob.add(belly);

  // 眼睛（头顶两侧）：白球 + 瞳孔 + 高光
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.235, 1.06, 0.27);
    const white = cast(new THREE.Mesh(new THREE.SphereGeometry(0.165, 18, 14), MAT.white));
    eye.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.088, 14, 12), MAT.pupil);
    pupil.position.set(0, 0.015, 0.105); eye.add(pupil);
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), MAT.white);
    hl.position.set(0.032, 0.045, 0.168); eye.add(hl);
    bob.add(eye); eyes.push(eye);
  }
  // 粉腮红
  for (const s of [-1, 1]) {
    const ch = new THREE.Mesh(new THREE.SphereGeometry(0.092, 12, 10), MAT.cheek);
    ch.scale.set(1, 0.8, 0.35); ch.position.set(s * 0.415, 0.585, 0.355);
    ch.rotation.y = s * 0.45; bob.add(ch);
  }
  // 微笑嘴（半圆弧）
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.021, 8, 22, Math.PI), MAT.mouth);
  mouth.position.set(0, 0.655, 0.487); mouth.rotation.set(-0.28, 0, Math.PI);
  bob.add(mouth);

  // 小短手（肩部枢轴摆动）
  const arms = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * 0.54, 0.74, 0.04);
    const arm = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.088, 0.20, 4, 10), MAT.body));
    arm.position.y = -0.17; pivot.add(arm);
    pivot.rotation.z = s * 0.22;
    bob.add(pivot); arms.push(pivot);
  }
  // 小短腿（髋部枢轴蹬地）
  const legs = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * 0.26, 0.22, 0);
    const foot = cast(new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 10), MAT.body));
    foot.scale.set(1.05, 0.52, 1.55); foot.position.set(0, -0.13, -0.05);
    pivot.add(foot); bob.add(pivot); legs.push(pivot);
  }
  // 头顶小绿芽
  const sprout = new THREE.Group(); sprout.position.set(0.03, 1.13, 0);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.13, 6), MAT.leaf);
  stem.position.y = 0.05; stem.rotation.z = 0.15; sprout.add(stem);
  const leafGeo = new THREE.SphereGeometry(0.075, 8, 6);
  const l1 = new THREE.Mesh(leafGeo, MAT.leaf); l1.scale.set(1.5, 0.32, 0.75); l1.position.set(0.07, 0.115, 0); l1.rotation.z = 0.45; sprout.add(l1);
  const l2 = new THREE.Mesh(leafGeo, MAT.leaf); l2.scale.set(1.5, 0.32, 0.75); l2.position.set(-0.07, 0.115, 0); l2.rotation.z = -0.45; sprout.add(l2);
  bob.add(sprout);

  return { root, squash, bob, arms, legs, eyes, sprout };
}
const frog = buildFrog();
scene.add(frog.root);

// 奶蛙动画状态（目标值 + 阻尼平滑过渡）
const pose = {
  bobY: 0, pitch: 0, scaleY: 1, scaleXZ: 1,
  armL: 0, armR: 0, legL: 0, legR: 0, armSpread: 0.22
};
let runPhase = 0, blinkT = rand(1.6, 3.2), blinkPhase = -1;

function updateFrog(dt, mode) {
  // mode: 'idle' | 'run'
  const air = !grounded, runW = mode === 'run' && grounded && !sliding ? 1 : 0;
  if (mode === 'run') runPhase += dt * (7 + worldSpeed * 0.62);

  let t = { bobY: 0, pitch: 0, scaleY: 1, scaleXZ: 1, armL: 0, armR: 0, legL: 0, legR: 0, armSpread: 0.22 };
  if (mode === 'idle') {
    t.bobY = Math.sin(performance.now() * 0.0022) * 0.022 + 0.01;
    t.armL = t.armR = Math.sin(performance.now() * 0.0022) * 0.08;
  } else if (air) {
    t.bobY = 0.10; t.pitch = -0.13; t.scaleY = 1.07; t.scaleXZ = 0.96;
    t.armL = t.armR = -2.45; t.armSpread = 0.85;      // 双手高举
    t.legL = t.legR = 0.55;                            // 双腿收起
  } else if (sliding) {
    t.bobY = -0.15; t.pitch = 0.52; t.scaleY = 0.58; t.scaleXZ = 1.16;
    t.armL = t.armR = 0.85;                            // 手往前撑
    t.legL = t.legR = -1.05;                           // 腿往前伸
  } else {
    const s = Math.sin(runPhase);
    t.bobY = Math.abs(Math.cos(runPhase)) * 0.075;
    t.pitch = s * 0.045 + 0.03;
    t.armL = s * 0.9; t.armR = -s * 0.9;
    t.legL = -s * 0.85; t.legR = s * 0.85;
  }
  const k = mode === 'idle' ? 6 : 15;
  pose.bobY = damp(pose.bobY, t.bobY, k, dt);
  pose.pitch = damp(pose.pitch, t.pitch, k, dt);
  pose.scaleY = damp(pose.scaleY, t.scaleY, k, dt);
  pose.scaleXZ = damp(pose.scaleXZ, t.scaleXZ, k, dt);
  pose.armL = damp(pose.armL, t.armL, k, dt);
  pose.armR = damp(pose.armR, t.armR, k, dt);
  pose.legL = damp(pose.legL, t.legL, k, dt);
  pose.legR = damp(pose.legR, t.legR, k, dt);
  pose.armSpread = damp(pose.armSpread, t.armSpread, k, dt);

  frog.bob.position.y = pose.bobY;
  frog.bob.rotation.x = pose.pitch;
  frog.squash.scale.set(pose.scaleXZ, pose.scaleY, pose.scaleXZ);
  frog.arms[0].rotation.x = pose.armL; frog.arms[1].rotation.x = pose.armR;
  frog.arms[0].rotation.z = -pose.armSpread; frog.arms[1].rotation.z = pose.armSpread;
  frog.legs[0].rotation.x = pose.legL; frog.legs[1].rotation.x = pose.legR;
  frog.sprout.rotation.z = Math.sin(runPhase * 0.5) * 0.08;

  // 眨眼
  blinkT -= dt;
  if (blinkT <= 0) { blinkPhase = 0; blinkT = rand(1.8, 3.6); }
  if (blinkPhase >= 0) {
    blinkPhase += dt;
    const p = blinkPhase / 0.16;
    const s = p >= 1 ? 1 : Math.abs(Math.sin(p * Math.PI)) * 0.88 + 0.12;
    frog.eyes.forEach(e => e.scale.set(1, p >= 1 ? 1 : s, 1));
    if (p >= 1) blinkPhase = -1;
  }

  // 撞击无敌闪烁
  if (invincibleT > 0) frog.root.visible = (Math.floor(invincibleT * 12) % 2 === 0);
  else if (state === 'playing') frog.root.visible = true;
}

// ============================================================
//  障碍 + 金币（对象池复用）
// ============================================================
function makeBarrier() {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.72, 0.45), mat);
  box.position.y = 0.38; box.castShadow = true; grp.add(box);
  const footMat = new THREE.MeshLambertMaterial({ color: 0x5B6470 });
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.6), footMat);
    f.position.set(s * 0.7, 0.04, 0); grp.add(f);
  }
  return grp;
}
function makeBar() {
  const grp = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0x5B6470 });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.5, 8), postMat);
    p.position.set(s * 0.92, 0.75, 0); p.castShadow = true; grp.add(p);
  }
  const barMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 });
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.98, 12), barMat);
  bar.rotation.z = Math.PI / 2; bar.position.y = 1.18; bar.castShadow = true; grp.add(bar);
  return grp;
}
function makeTrain() {
  const grp = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xE4572E, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.05, 2.15, 14), bodyMat);
  body.position.y = 1.45; body.castShadow = true; grp.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.28, 13.6),
    new THREE.MeshStandardMaterial({ color: 0xFFF1D6, roughness: 0.6 }));
  roof.position.y = 2.66; grp.add(roof);
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 13.8),
    new THREE.MeshLambertMaterial({ color: 0x37404A }));
  skirt.position.y = 0.2; grp.add(skirt);
  // 车头窗 + 车灯（朝向玩家 +Z）
  const winMat = new THREE.MeshStandardMaterial({ color: 0xBDEBFF, roughness: 0.15, metalness: 0.3 });
  const win = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.85, 0.06), winMat);
  win.position.set(0, 1.95, 7.02); grp.add(win);
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xFFF3B0, emissive: 0xFFC93C, emissiveIntensity: 1.4 });
  for (const s of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), lightMat);
    l.position.set(s * 0.62, 0.95, 7.03); grp.add(l);
  }
  // 侧窗
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.7, 1.5), winMat);
    w.position.set(s * 1.04, 1.9, -5.2 + i * 2.6); grp.add(w);
  }
  return grp;
}
function makeCoinMesh() {
  const grp = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.09, 22),
    new THREE.MeshStandardMaterial({ color: 0xFFC93C, emissive: 0x9A7000, emissiveIntensity: 0.45, metalness: 0.55, roughness: 0.3 }));
  m.rotation.x = Math.PI / 2; grp.add(m);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 18),
    new THREE.MeshStandardMaterial({ color: 0xFFDF6B, metalness: 0.5, roughness: 0.35 }));
  inner.rotation.x = Math.PI / 2; grp.add(inner);
  return grp;
}

// 池：kind, grp, active, halfW, y0, y1, halfD, laneX
const obstaclePool = [];
function regObstacle(kind, maker, count, box) {
  for (let i = 0; i < count; i++) {
    const grp = maker(); grp.visible = false; scene.add(grp);
    obstaclePool.push({ kind, grp, active: false, ...box });
  }
}
regObstacle('barrier', makeBarrier, 10, { halfW: 0.88, y0: 0, y1: 0.74, halfD: 0.26 });
regObstacle('bar', makeBar, 9, { halfW: 0.98, y0: 0.92, y1: 1.42, halfD: 0.16 });
regObstacle('train', makeTrain, 4, { halfW: 1.03, y0: 0, y1: 2.8, halfD: 7.0 });

const coinPool = [];
for (let i = 0; i < 42; i++) {
  const grp = makeCoinMesh(); grp.visible = false; scene.add(grp);
  coinPool.push({ grp, active: false, phase: rand(0, Math.PI * 2) });
}

function getFrom(pool, kind) {
  return pool.find(o => !o.active && (kind === undefined || o.kind === kind));
}
function placeObstacle(kind, lane, z) {
  const o = getFrom(obstaclePool, kind);
  if (!o) return null;
  o.active = true; o.laneX = LANE_X[lane];
  o.grp.position.set(o.laneX, 0, z);
  o.grp.visible = true;
  return o;
}
function placeCoin(lane, z) {
  const c = getFrom(coinPool);
  if (!c) return;
  c.active = true;
  c.grp.position.set(LANE_X[lane], 0.58, z);
  c.grp.visible = true;
}

// ---------------- 生成器 ----------------
const lanesShuffled = () => {
  const a = [0, 1, 2];
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
function spawnPattern() {
  const z = SPAWN_Z;
  const roll = Math.random();
  const ls = lanesShuffled();
  if (roll < 0.26) {                        // 金币串
    const lane = pick(ls);
    const n = randInt(5, 8);
    for (let i = 0; i < n; i++) placeCoin(lane, z - i * 1.7);
    return rand(8, 14);
  }
  if (roll < 0.52) {                        // 矮路障 1~2 个
    const n = Math.random() < 0.45 ? 2 : 1;
    for (let i = 0; i < n; i++) placeObstacle('barrier', ls[i], z);
    if (Math.random() < 0.5) placeCoin(ls[2], z - 2); // 留空车道给奖励
    return rand(13, 20);
  }
  if (roll < 0.74) {                        // 高横杆：单道或全幅（全幅必滑）
    if (Math.random() < 0.4) { for (let l = 0; l < 3; l++) placeObstacle('bar', l, z); }
    else placeObstacle('bar', ls[0], z);
    return rand(13, 20);
  }
  // 长火车 1 辆（偶尔 2 辆并排，永远留一条道）
  placeObstacle('train', ls[0], z - 7);
  if (Math.random() < 0.3) placeObstacle('train', ls[1], z - 7);
  const coinLane = ls[2];
  for (let i = 0; i < 4; i++) placeCoin(coinLane, z - 2 - i * 2.2);
  return rand(24, 32);
}

// ---------------- 碰撞 ----------------
const playerBox = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
function refreshPlayerBox() {
  playerBox.minX = playerX - PLAYER_HALF_W;
  playerBox.maxX = playerX + PLAYER_HALF_W;
  playerBox.minY = playerY;
  playerBox.maxY = playerY + (sliding ? PLAYER_H_SLIDE : PLAYER_H);
}
function hits(o) {
  const z = o.grp.position.z;
  if (z + o.halfD < -0.42 || z - o.halfD > 0.42) return false;
  if (playerBox.maxX < o.laneX - o.halfW || playerBox.minX > o.laneX + o.halfW) return false;
  if (playerBox.maxY < o.y0 || playerBox.minY > o.y1) return false;
  return true;
}

// ============================================================
//  输入：键盘 / 触屏滑动 / 屏幕按钮
// ============================================================
function doLeft() { if (!canAct()) return; laneIdx = clamp(laneIdx - 1, 0, 2); }
function doRight() { if (!canAct()) return; laneIdx = clamp(laneIdx + 1, 0, 2); }
function doJump() {
  if (!canAct()) return;
  if (grounded) {
    vy = JUMP_V; grounded = false;
    if (sliding) { sliding = false; slideT = 0; }
    AudioSys.jump();
  }
}
function doSlide() {
  if (!canAct()) return;
  if (!grounded) { vy = Math.min(vy, -15); pendingSlide = true; return; }
  sliding = true; slideT = SLIDE_DUR; AudioSys.slide();
}
function canAct() { return state === 'playing' && !paused; }

window.addEventListener('keydown', e => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  if (state === 'title' && (e.key === 'Enter' || e.key === ' ')) { startGame(); return; }
  if (state === 'over' && e.key === 'Enter') { startGame(); return; }
  if (e.key === 'Escape') { if (canAct()) pauseGame(); else if (paused) resumeGame(); return; }
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': doLeft(); break;
    case 'ArrowRight': case 'd': case 'D': doRight(); break;
    case 'ArrowUp': case 'w': case 'W': case ' ': doJump(); break;
    case 'ArrowDown': case 's': case 'S': doSlide(); break;
  }
});

// 滑动
let touchStart = null;
canvas.addEventListener('touchstart', e => { touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if (Math.abs(dx) > Math.abs(dy)) dx > 0 ? doRight() : doLeft();
  else dy < 0 ? doJump() : doSlide();
}, { passive: true });
canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

// 屏幕按钮（pointerdown 更跟手）
function bindBtn(id, fn) {
  const el = $(id);
  el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); fn(); });
}
bindBtn('tLeft', doLeft); bindBtn('tRight', doRight); bindBtn('tUp', doJump); bindBtn('tDown', doSlide);

// 标题屏拖动旋转奶蛙
let dragging = false, lastPX = 0, rotY = 0, rotX = 0, rotYTarget = 0, rotXTarget = 0, camDist = 4.8, camDistTarget = 4.8;
canvas.addEventListener('pointerdown', e => {
  if (state === 'title') { dragging = true; lastPX = e.clientX; }
});
window.addEventListener('pointermove', e => {
  if (!dragging || state !== 'title') return;
  rotYTarget += (e.clientX - lastPX) * 0.012; lastPX = e.clientX;
});
window.addEventListener('pointerup', () => dragging = false);
canvas.addEventListener('wheel', e => {
  if (state !== 'title') return;
  e.preventDefault();
  camDistTarget = clamp(camDistTarget + e.deltaY * 0.003, 3.2, 7.5);
}, { passive: false });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing' && !paused) pauseGame();
});

// ============================================================
//  UI / 流程
// ============================================================
function renderLives() {
  livesEl.innerHTML = HEART_SVG + HEART_SVG + HEART_SVG;
  [...livesEl.children].forEach((h, i) => { if (i >= lives) h.classList.add('lost'); });
}
function updateHUD() {
  scoreVal.textContent = Math.floor(score);
  distVal.textContent = Math.floor(distance);
  coinVal.textContent = coinCount;
}
function showBest() {
  $('bestValTitle').textContent = best;
  $('bestValOver').textContent = best;
}

function resetWorld() {
  for (const o of obstaclePool) { o.active = false; o.grp.visible = false; }
  for (const c of coinPool) { c.active = false; c.grp.visible = false; }
  for (const d of decorPool) { d.active = false; d.grp.visible = false; }
  lives = 3; score = 0; coinCount = 0; distance = 0;
  worldSpeed = START_SPEED;
  invincibleT = 0; shakeT = 0;
  laneIdx = 1; playerX = 0; playerY = 0; vy = 0; grounded = true;
  sliding = false; slideT = 0; pendingSlide = false;
  spawnIn = 26; decorIn = 3;
  rotY = 0; rotYTarget = 0; rotX = 0; rotXTarget = 0;
  frog.root.rotation.set(0, 0, 0);
  frog.root.position.set(0, 0, 0);
  renderLives(); updateHUD(); showBest();
}

function startGame() {
  AudioSys.init(); AudioSys.click();
  resetWorld();
  state = 'playing'; paused = false;
  titleScreen.classList.add('hidden');
  overScreen.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  touchControls.classList.remove('hidden');
  AudioSys.startMusic();
}
function pauseGame() {
  if (state !== 'playing' || paused) return;
  paused = true;
  pauseScreen.classList.remove('hidden');
  AudioSys.stopMusic();
  AudioSys.click();
}
function resumeGame() {
  paused = false;
  pauseScreen.classList.add('hidden');
  AudioSys.click(); AudioSys.startMusic();
}
function quitToTitle() {
  state = 'title'; paused = false;
  resetWorld();
  hud.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  overScreen.classList.add('hidden');
  touchControls.classList.add('hidden');
  titleScreen.classList.remove('hidden');
  AudioSys.stopMusic();
  AudioSys.click();
}
function gameOver() {
  state = 'over';
  frog.root.visible = true;   // 防止卡在无敌闪烁的隐藏帧
  AudioSys.stopMusic();
  AudioSys.hit();
  const s = Math.floor(score);
  const isRecord = s > best;
  if (isRecord) { best = s; localStorage.setItem(BEST_KEY, String(best)); }
  $('finalScore').textContent = s;
  $('finalCoins').textContent = coinCount;
  $('finalDist').textContent = Math.floor(distance);
  $('newRecord').classList.toggle('hidden', !isRecord);
  showBest();
  setTimeout(() => {
    if (state !== 'over') return;
    hud.classList.add('hidden');
    touchControls.classList.add('hidden');
    overScreen.classList.remove('hidden');
  }, 650);
}

$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);
$('homeBtn').addEventListener('click', quitToTitle);
$('resumeBtn').addEventListener('click', resumeGame);
$('restartBtnPause').addEventListener('click', startGame);
$('pauseBtn').addEventListener('click', () => { canAct() ? pauseGame() : paused && resumeGame(); });
$('muteBtn').addEventListener('click', () => { AudioSys.init(); AudioSys.setMuted(!AudioSys.muted); });

renderLives(); showBest();
if (window.matchMedia('(pointer: coarse)').matches) touchControls.classList.remove('hidden');
else touchControls.classList.add('hidden');

// ============================================================
//  主循环
// ============================================================
const clock = new THREE.Clock();
let elapsed = 0;

function moveWorld(dt) {
  const dz = worldSpeed * dt;
  for (const o of obstaclePool) {
    if (!o.active) continue;
    o.grp.position.z += dz;
    if (o.grp.position.z - o.halfD > DESPAWN_Z) { o.active = false; o.grp.visible = false; }
  }
  for (const c of coinPool) {
    if (!c.active) continue;
    c.grp.position.z += dz;
    c.grp.rotation.y += dt * 4.5;
    c.grp.position.y = 0.58 + Math.sin(elapsed * 3 + c.phase) * 0.06;
    if (c.grp.position.z > DESPAWN_Z) { c.active = false; c.grp.visible = false; }
  }
  for (const d of decorPool) {
    if (!d.active) continue;
    d.grp.position.z += dz;
    if (d.grp.position.z > 20) { d.active = false; d.grp.visible = false; }
  }
  for (const cl of clouds) {
    cl.position.z += dz * 0.9;
    cl.position.x += dt * 0.4;
    if (cl.position.z > 24) { cl.position.z = -170; cl.position.x = rand(-55, 55); }
  }
  for (const h of hills) {
    h.position.z += dz * 0.9;
    if (h.position.z > 30) { h.position.z = -170; h.position.x = (h.position.x > 0 ? 1 : -1) * rand(26, 60); }
  }
  // 纹理滚动
  trackTex.offset.y -= dz / (TRACK_LEN / 20);
  grassTex.offset.y -= dz / (TRACK_LEN / 26);
}

function updatePlaying(dt) {
  elapsed += dt;
  // 加速（封顶）
  worldSpeed = Math.min(MAX_SPEED, worldSpeed + SPEED_GAIN * dt);

  // 玩家横向
  playerX = damp(playerX, LANE_X[laneIdx], 13, dt);
  // 跳跃物理
  if (!grounded) {
    playerY += vy * dt; vy += GRAVITY * dt;
    if (playerY <= 0) {
      playerY = 0; vy = 0; grounded = true;
      if (pendingSlide) { pendingSlide = false; sliding = true; slideT = SLIDE_DUR; AudioSys.slide(); }
    }
  }
  // 滑铲计时
  if (sliding) { slideT -= dt; if (slideT <= 0) sliding = false; }
  if (invincibleT > 0) invincibleT -= dt;

  // 生成
  spawnIn -= worldSpeed * dt;
  if (spawnIn <= 0) spawnIn = spawnPattern();
  decorIn -= worldSpeed * dt;
  if (decorIn <= 0) { spawnDecor(); decorIn = rand(4, 9); }

  moveWorld(dt);
  distance += worldSpeed * dt;
  score += worldSpeed * dt * 0.9;

  // 碰撞
  refreshPlayerBox();
  if (invincibleT <= 0) {
    for (const o of obstaclePool) {
      if (!o.active || !hits(o)) continue;
      lives--; renderLives();
      invincibleT = 1.5; shakeT = 0.35;
      o.active = false; o.grp.visible = false;
      AudioSys.hit();
      if (lives <= 0) { gameOver(); return; }
      break;
    }
  }
  // 吃金币
  for (const c of coinPool) {
    if (!c.active) continue;
    const p = c.grp.position;
    if (Math.abs(p.z) < 0.85 && Math.abs(p.x - playerX) < 0.8 && playerY < 1.5) {
      c.active = false; c.grp.visible = false;
      coinCount++; score += 10;
      AudioSys.coin();
    }
  }

  frog.root.position.set(playerX, playerY, 0);
  updateFrog(dt, 'run');
  updateHUD();

  // 相机跟随
  camPosTarget.set(playerX * 0.45, 3.7 + playerY * 0.22, 7.2);
  lookAtTarget.set(playerX * 0.7, 1.05 + playerY * 0.2, -7);
}

function updateTitle(dt) {
  // 奶蛙展示：缓慢自转 + 拖动旋转 + 滚轮缩放
  rotY = damp(rotY, rotYTarget, 8, dt);
  rotX = damp(rotX, rotXTarget, 8, dt);
  if (!dragging) rotYTarget += dt * 0.55;
  frog.root.rotation.set(rotX, rotY, 0);
  frog.root.position.set(0, 0, 0);
  camDist = damp(camDist, camDistTarget, 8, dt);
  camPosTarget.set(0, 1.55, camDist);
  lookAtTarget.set(0, 0.72, 0);
  updateFrog(dt, 'idle');
  for (const cl of clouds) { cl.position.x += dt * 0.4; if (cl.position.x > 60) cl.position.x = -60; }
}

function updateOver(dt) {
  worldSpeed = damp(worldSpeed, 0, 4, dt);
  moveWorld(dt);
  // 奶蛙翻倒
  frog.root.rotation.z = damp(frog.root.rotation.z, -Math.PI / 2.3, 5, dt);
  frog.root.rotation.y = damp(frog.root.rotation.y, 0.6, 5, dt);
  camPosTarget.set(0, 2.6, 5.6);
  lookAtTarget.set(0, 0.5, 0);
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state === 'playing' && !paused) updatePlaying(dt);
  else if (state === 'title') updateTitle(dt);
  else if (state === 'over') updateOver(dt);

  // 相机
  camPos.x = damp(camPos.x, camPosTarget.x, 5, dt);
  camPos.y = damp(camPos.y, camPosTarget.y, 5, dt);
  camPos.z = damp(camPos.z, camPosTarget.z, 5, dt);
  lookAt.x = damp(lookAt.x, lookAtTarget.x, 6, dt);
  lookAt.y = damp(lookAt.y, lookAtTarget.y, 6, dt);
  lookAt.z = damp(lookAt.z, lookAtTarget.z, 6, dt);
  let sx = 0, sy = 0;
  if (shakeT > 0) { shakeT -= dt; sx = rand(-1, 1) * 0.09 * shakeT * 3; sy = rand(-1, 1) * 0.07 * shakeT * 3; }
  camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
  camera.lookAt(lookAt);

  renderer.render(scene, camera);
}
tick();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

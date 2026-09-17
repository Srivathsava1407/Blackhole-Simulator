import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const holder = document.getElementById('sceneHolder');

// ---------- basic setup ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, holder.clientWidth/holder.clientHeight, 0.1, 4000);
camera.position.set(0, 55, 260);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.setSize(holder.clientWidth, holder.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
holder.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 60;
controls.maxDistance = 900;

// bloom for that glowing accretion-disk look
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(holder.clientWidth, holder.clientHeight), 0.65, 0.6, 0.55);
composer.addPass(bloom);

// ---------- gravitational lensing shader pass ----------
// Warps pixels toward the black hole's screen position, the way real light
// bends around mass. Strength falls off with distance so only the region
// close to the horizon curls noticeably, like the Einstein-ring look in
// real black hole imagery.
const LensingShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0.26 },
    uRadius: { value: 0.5 },
    uAspect: { value: holder.clientWidth / holder.clientHeight }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uCenter;
    uniform float uStrength;
    uniform float uRadius;
    uniform float uAspect;
    varying vec2 vUv;
    void main(){
      vec2 uv = vUv;
      vec2 diff = uv - uCenter;
      diff.x *= uAspect;
      float dist = length(diff);
      // falloff: strong right at the horizon edge, fades out with distance
      float bend = uStrength * uRadius / (dist*dist + uRadius*0.15);
      bend = clamp(bend, 0.0, 0.55);
      // fade distortion to zero right at the horizon so the warp can't fold
      // the image back on itself (that's what caused the duplicate-ring look)
      float innerMask = smoothstep(uRadius*0.22, uRadius*0.6, dist);
      bend *= innerMask;
      vec2 dir = dist > 0.0001 ? normalize(diff) : vec2(0.0);
      dir.x /= uAspect;
      vec2 warpedUv = uv - dir * bend * 0.08;
      gl_FragColor = texture2D(tDiffuse, warpedUv);
    }
  `
};
const lensingPass = new ShaderPass(LensingShader);
composer.addPass(lensingPass);

// ---------- cinematic color grade + vignette ----------
// Slight teal-leaning shadows / warm highlights (common in space footage
// grading) plus edge vignette so the frame reads as one cohesive shot.
const GradeShader = {
  uniforms: { tDiffuse: { value:null }, uAspect: { value: holder.clientWidth/holder.clientHeight } },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    varying vec2 vUv;
    void main(){
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 col = texel.rgb;

      // lift shadows toward teal, push highlights toward warm
      float lum = dot(col, vec3(0.299,0.587,0.114));
      vec3 shadowTint = vec3(-0.01, 0.005, 0.02);
      vec3 highlightTint = vec3(0.03, 0.015, -0.02);
      col += shadowTint * (1.0-lum) + highlightTint * lum;

      // mild contrast + saturation lift
      col = (col - 0.5) * 1.06 + 0.5;
      float g = dot(col, vec3(0.299,0.587,0.114));
      col = mix(vec3(g), col, 1.35);

      // vignette
      vec2 c = vUv - 0.5;
      c.x *= uAspect;
      float vig = smoothstep(0.9, 0.25, length(c));
      col *= mix(0.72, 1.0, vig);

      gl_FragColor = vec4(clamp(col,0.0,1.0), texel.a);
    }
  `
};
const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);

// screen-space position of the black hole, recomputed every frame
const lensCenterWorld = new THREE.Vector3(0,0,0);
function updateLensCenter(){
  const p = lensCenterWorld.clone().project(camera);
  lensingPass.uniforms.uCenter.value.set(p.x*0.5+0.5, p.y*0.5+0.5);
}

// ---------- starfield ----------
// Realistic star colors follow stellar temperature: hot blue-white stars are
// rare and bright, most stars are white/yellow, cooler red stars are common
// but dim. We weight toward dim+warm with occasional bright+hot outliers.
const starPalette = [
  { color: 0x9db4ff, weight: 0.06 }, // hot blue-white (rare, bright)
  { color: 0xffffff, weight: 0.22 }, // white
  { color: 0xfff4d6, weight: 0.32 }, // warm white/yellow
  { color: 0xffd28a, weight: 0.24 }, // orange
  { color: 0xff9d6b, weight: 0.16 }  // cool red (common, dim)
];
function pickStarColor(){
  const r = Math.random();
  let acc = 0;
  for(const s of starPalette){ acc += s.weight; if(r <= acc) return s.color; }
  return starPalette[starPalette.length-1].color;
}

function makeStars(count, radius){
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count*3);
  const colors = new Float32Array(count*3);
  const sizes = new Float32Array(count);
  const tmpColor = new THREE.Color();

  for(let i=0;i<count;i++){
    const r = radius*(0.6+Math.random()*0.4);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    positions[i*3]   = r*Math.sin(phi)*Math.cos(theta);
    positions[i*3+1] = r*Math.sin(phi)*Math.sin(theta);
    positions[i*3+2] = r*Math.cos(phi);

    tmpColor.set(pickStarColor());
    colors[i*3]=tmpColor.r; colors[i*3+1]=tmpColor.g; colors[i*3+2]=tmpColor.b;

    // most stars are dim, a few are bright (power curve biases toward small)
    sizes[i] = Math.pow(Math.random(), 3.2) * 3.2 + 0.5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  geo.setAttribute('starSize', new THREE.BufferAttribute(sizes,1));

  const mat = new THREE.ShaderMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float starSize;
      varying vec3 vColor;
      void main(){
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = starSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main(){
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if(d > 0.5) discard;
        float glow = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, glow*0.9);
      }
    `
  });
  return new THREE.Points(geo, mat);
}
scene.add(makeStars(16000, 1900));
scene.add(makeStars(4000, 1000)); // a nearer, sparser layer for parallax depth

// a small number of standout "hero" stars with a soft glow halo, the kind
// that read as constellation anchor points
function makeHeroStars(count, radius){
  const group = new THREE.Group();
  const haloTex = (()=>{
    const c = document.createElement('canvas'); c.width=128; c.height=128;
    const cx2 = c.getContext('2d');
    const g = cx2.createRadialGradient(64,64,0,64,64,64);
    g.addColorStop(0,'rgba(255,255,255,0.9)');
    g.addColorStop(0.25,'rgba(255,255,255,0.35)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    cx2.fillStyle = g; cx2.fillRect(0,0,128,128);
    return new THREE.CanvasTexture(c);
  })();
  for(let i=0;i<count;i++){
    const r = radius*(0.5+Math.random()*0.5);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    const col = new THREE.Color(pickStarColor());
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map:haloTex, color:col, transparent:true, depthWrite:false }));
    const scale = 8 + Math.random()*14;
    sprite.scale.set(scale, scale, 1);
    sprite.position.set(
      r*Math.sin(phi)*Math.cos(theta),
      r*Math.sin(phi)*Math.sin(theta),
      r*Math.cos(phi)
    );
    group.add(sprite);
  }
  return group;
}
scene.add(makeHeroStars(55, 1750));

// distant background galaxies: bright core with spiral-arm structure,
// far out and dim enough to read as genuinely far away rather than a prop
function makeGalaxyTexture(hue){
  const c = document.createElement('canvas'); c.width=512; c.height=512;
  const cx2 = c.getContext('2d');
  cx2.translate(256,256);

  // faint spiral arms first, drawn as smeared, rotated streaks
  const armCount = 2 + Math.floor(Math.random()*2);
  for(let a=0; a<armCount; a++){
    const armRot = (Math.PI*2/armCount)*a + Math.random()*0.4;
    for(let s=0; s<5; s++){
      cx2.save();
      cx2.rotate(armRot + s*0.35);
      const dist = 60 + s*30;
      const g = cx2.createRadialGradient(dist,0,0,dist,0,90);
      g.addColorStop(0, `hsla(${hue},55%,75%,${0.16 - s*0.02})`);
      g.addColorStop(1, `hsla(${hue},55%,60%,0)`);
      cx2.fillStyle = g;
      cx2.beginPath();
      cx2.ellipse(dist, 0, 110, 26, 0, 0, Math.PI*2);
      cx2.fill();
      cx2.restore();
    }
  }

  // bright core on top
  const core = cx2.createRadialGradient(0,0,0,0,0,90);
  core.addColorStop(0, `hsla(${hue},40%,92%,0.95)`);
  core.addColorStop(0.25, `hsla(${hue},55%,80%,0.55)`);
  core.addColorStop(0.6, `hsla(${hue},55%,65%,0.15)`);
  core.addColorStop(1, `hsla(${hue},55%,60%,0)`);
  cx2.fillStyle = core;
  cx2.beginPath(); cx2.arc(0,0,90,0,Math.PI*2); cx2.fill();

  return new THREE.CanvasTexture(c);
}
function makeGalaxies(count, radius){
  const group = new THREE.Group();
  const hues = [210, 260, 30, 45, 190, 320];
  for(let i=0;i<count;i++){
    const hue = hues[Math.floor(Math.random()*hues.length)];
    const tex = makeGalaxyTexture(hue);
    const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, opacity:0.45+Math.random()*0.3, blending:THREE.AdditiveBlending });
    const sprite = new THREE.Sprite(mat);
    const r = radius*(0.85+Math.random()*0.15);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    sprite.position.set(r*Math.sin(phi)*Math.cos(theta), r*Math.sin(phi)*Math.sin(theta), r*Math.cos(phi));
    const w = 150 + Math.random()*260;
    sprite.scale.set(w, w*(0.55+Math.random()*0.3), 1); // tilted disk silhouette
    sprite.material.rotation = Math.random()*Math.PI*2;
    group.add(sprite);
  }
  return group;
}
scene.add(makeGalaxies(16, 1780));

// nebula gas clouds: soft, multi-layered colored smudges like real
// astrophotography (H-alpha pink/red, OIII teal, dust-lane gold/brown)
function makeNebulaTexture(hue1, hue2){
  const c = document.createElement('canvas'); c.width=512; c.height=512;
  const cx2 = c.getContext('2d');
  cx2.translate(256,256);
  // layer several soft irregular blobs so it doesn't read as a perfect circle
  for(let i=0;i<6;i++){
    const ang = Math.random()*Math.PI*2;
    const dist = Math.random()*90;
    const ox = Math.cos(ang)*dist, oy = Math.sin(ang)*dist;
    const r = 120 + Math.random()*100;
    const hue = i%2===0 ? hue1 : hue2;
    const g = cx2.createRadialGradient(ox,oy,0,ox,oy,r);
    g.addColorStop(0, `hsla(${hue},65%,60%,0.14)`);
    g.addColorStop(0.5, `hsla(${hue},60%,50%,0.06)`);
    g.addColorStop(1, `hsla(${hue},60%,45%,0)`);
    cx2.fillStyle = g;
    cx2.beginPath(); cx2.arc(ox,oy,r,0,Math.PI*2); cx2.fill();
  }
  return new THREE.CanvasTexture(c);
}
function makeNebulae(count, radius){
  const group = new THREE.Group();
  const palettes = [ [330,280], [190,220], [25,350], [200,160] ]; // pink/purple, teal/blue, gold/red, cyan/blue
  for(let i=0;i<count;i++){
    const [h1,h2] = palettes[Math.floor(Math.random()*palettes.length)];
    const tex = makeNebulaTexture(h1,h2);
    const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, opacity:0.5+Math.random()*0.3, blending:THREE.AdditiveBlending });
    const sprite = new THREE.Sprite(mat);
    const r = radius*(0.75+Math.random()*0.2);
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    sprite.position.set(r*Math.sin(phi)*Math.cos(theta), r*Math.sin(phi)*Math.sin(theta), r*Math.cos(phi));
    const w = 500 + Math.random()*500;
    sprite.scale.set(w, w, 1);
    group.add(sprite);
  }
  return group;
}
scene.add(makeNebulae(8, 1600));

// milky-way band: a dense diagonal sweep of extra stars + soft glow,
// the kind of texture that sells "this is a real sky" at a glance
function makeMilkyWay(){
  const group = new THREE.Group();
  const bandNormal = new THREE.Vector3(0.3, 1, 0.15).normalize(); // tilt of the band plane

  // soft glow sheet along the band
  const glowTex = (()=>{
    const c = document.createElement('canvas'); c.width=1024; c.height=256;
    const cx2 = c.getContext('2d');
    const g = cx2.createLinearGradient(0,0,0,256);
    g.addColorStop(0,'rgba(180,190,255,0)');
    g.addColorStop(0.5,'rgba(210,215,255,0.10)');
    g.addColorStop(1,'rgba(180,190,255,0)');
    cx2.fillStyle=g; cx2.fillRect(0,0,1024,256);
    // dust lane darkening down the middle
    const g2 = cx2.createLinearGradient(0,100,0,156);
    g2.addColorStop(0,'rgba(0,0,0,0)');
    g2.addColorStop(0.5,'rgba(10,8,15,0.25)');
    g2.addColorStop(1,'rgba(0,0,0,0)');
    cx2.fillStyle=g2; cx2.fillRect(0,0,1024,256);
    return new THREE.CanvasTexture(c);
  })();
  const glowGeo = new THREE.PlaneGeometry(3400, 700);
  const glowMat = new THREE.MeshBasicMaterial({ map:glowTex, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide });
  const glowPlane = new THREE.Mesh(glowGeo, glowMat);
  glowPlane.lookAt(bandNormal);
  group.add(glowPlane);

  // dense star scatter confined to the band
  const count = 9000;
  const positions = new Float32Array(count*3);
  const colors = new Float32Array(count*3);
  const sizes = new Float32Array(count);
  const tmp = new THREE.Color();
  // build an orthonormal basis for the band plane
  const up = Math.abs(bandNormal.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  const tangentA = new THREE.Vector3().crossVectors(up, bandNormal).normalize();
  const tangentB = new THREE.Vector3().crossVectors(bandNormal, tangentA).normalize();
  for(let i=0;i<count;i++){
    const along = (Math.random()-0.5)*3200;
    const across = (Math.random()-0.5)*Math.random()*320; // denser near center
    const p = new THREE.Vector3()
      .addScaledVector(tangentA, along)
      .addScaledVector(tangentB, across)
      .addScaledVector(bandNormal, (Math.random()-0.5)*40);
    positions[i*3]=p.x; positions[i*3+1]=p.y; positions[i*3+2]=p.z;
    tmp.set(pickStarColor());
    colors[i*3]=tmp.r; colors[i*3+1]=tmp.g; colors[i*3+2]=tmp.b;
    sizes[i] = Math.pow(Math.random(),4)*2.2 + 0.4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  geo.setAttribute('starSize', new THREE.BufferAttribute(sizes,1));
  const mat = new THREE.ShaderMaterial({
    vertexColors:true, transparent:true, depthWrite:false,
    vertexShader:`
      attribute float starSize;
      varying vec3 vColor;
      void main(){
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = starSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader:`
      varying vec3 vColor;
      void main(){
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if(d > 0.5) discard;
        gl_FragColor = vec4(vColor, smoothstep(0.5,0.0,d)*0.85);
      }
    `
  });
  group.add(new THREE.Points(geo, mat));
  return group;
}
scene.add(makeMilkyWay());

// ---------- black hole (event horizon) ----------
let massMult = 1;
const horizonBaseR = 16;
// Kepler's third law: orbital period T scales as r^1.5, so angular speed
// (which is what we integrate each frame) scales as r^-1.5 — not r^-0.5.
// This is what makes inner particles whip around dramatically faster than
// outer ones, rather than just modestly faster.
function keplerAngularSpeed(radius, baseConst){
  return baseConst / Math.pow(radius/horizonBaseR, 1.5);
}
const horizonGeo = new THREE.SphereGeometry(horizonBaseR, 64, 64);
const horizonMat = new THREE.MeshBasicMaterial({ color:0x000000 });
const horizon = new THREE.Mesh(horizonGeo, horizonMat);
scene.add(horizon);

// ---------- lensing halo (the Gargantua signature look) ----------
// Real strong gravitational lensing bends light from the far side of the
// disk up and over the poles, so a bright ring appears to wrap all the way
// around the silhouette no matter what angle you view it from — not just
// in the disk plane. A flat ring/torus can't do this; it needs a fresnel
// rim shader on a sphere that glows brightest exactly at the silhouette
// edge, from every direction, all the time.
const haloGeo = new THREE.SphereGeometry(horizonBaseR*1.22, 96, 96);
const haloMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.FrontSide,
  vertexShader: `
    varying vec3 vNormalView;
    varying vec3 vViewDir;
    void main(){
      vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
      vNormalView = normalize(normalMatrix * normal);
      vViewDir = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vNormalView;
    varying vec3 vViewDir;
    void main(){
      float edge = 1.0 - abs(dot(normalize(vNormalView), normalize(vViewDir)));
      float rim = pow(edge, 3.2);
      // white-hot right at the very edge, cooling to orange further in
      vec3 hot = vec3(1.0, 0.98, 0.92);
      vec3 warm = vec3(1.0, 0.55, 0.22);
      vec3 col = mix(warm, hot, pow(edge, 6.0));
      gl_FragColor = vec4(col, rim * 0.85);
    }
  `
});
const lensingHalo = new THREE.Mesh(haloGeo, haloMat);
scene.add(lensingHalo);

// soft outer glow sprite
const glowTexture = (()=>{
  const c = document.createElement('canvas'); c.width=256; c.height=256;
  const ctx2 = c.getContext('2d');
  const g = ctx2.createRadialGradient(128,128,0,128,128,128);
  g.addColorStop(0,'rgba(255,138,61,0.32)');
  g.addColorStop(0.4,'rgba(255,138,61,0.1)');
  g.addColorStop(1,'rgba(255,138,61,0)');
  ctx2.fillStyle = g; ctx2.fillRect(0,0,256,256);
  return new THREE.CanvasTexture(c);
})();
const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTexture, transparent:true, depthWrite:false }));
glowSprite.scale.set(horizonBaseR*5.5, horizonBaseR*5.5, 1);
scene.add(glowSprite);

// ---------- accretion disk (particle ring) ----------
const DISK_COUNT = 45000;
const diskGeo = new THREE.BufferGeometry();
const diskPos = new Float32Array(DISK_COUNT*3);
const diskColor = new Float32Array(DISK_COUNT*3);
const diskRadiusFactor = new Float32Array(DISK_COUNT); // 0 = at horizon, 1 = outer edge
const diskData = []; // {radius, angle, speed, height, turbulence phase/freq}

const colorHot = new THREE.Color(0xffffff);   // white-hot, innermost
const colorMid = new THREE.Color(0xffd27a);   // yellow-white
const colorWarm = new THREE.Color(0xff8a3d);  // orange
const colorCool = new THREE.Color(0xa33018);  // deep red, outermost

for(let i=0;i<DISK_COUNT;i++){
  const radius = horizonBaseR*1.3 + Math.pow(Math.random(),1.5)*horizonBaseR*7;
  const angle = Math.random()*Math.PI*2;
  const speed = keplerAngularSpeed(radius, 0.9); // faster closer in — Kepler's third law
  const heightRand = (Math.random()+Math.random()+Math.random()-1.5)/1.5; // center-weighted
  const heightBase = heightRand * 1.1 * (radius/(horizonBaseR*8));
  // turbulence: each particle gets its own oscillation so the disk churns
  // and billows instead of tracing perfect flat circles
  const turbPhaseH = Math.random()*Math.PI*2;
  const turbFreqH = 0.6 + Math.random()*1.8;
  const turbAmpH = (0.4 + Math.random()*1.4) * (radius/(horizonBaseR*8));
  const turbPhaseR = Math.random()*Math.PI*2;
  const turbFreqR = 0.3 + Math.random()*1.0;
  const turbAmpR = radius * (0.015 + Math.random()*0.035);
  diskData.push({ radius, angle, speed, heightBase, turbPhaseH, turbFreqH, turbAmpH, turbPhaseR, turbFreqR, turbAmpR });

  const x = Math.cos(angle)*radius;
  const z = Math.sin(angle)*radius;
  diskPos[i*3] = x; diskPos[i*3+1] = heightBase; diskPos[i*3+2] = z;

  const tNorm = (radius - horizonBaseR*1.3) / (horizonBaseR*7);
  let col;
  if(tNorm < 0.25) col = colorHot.clone().lerp(colorMid, tNorm/0.25);
  else if(tNorm < 0.6) col = colorMid.clone().lerp(colorWarm, (tNorm-0.25)/0.35);
  else col = colorWarm.clone().lerp(colorCool, (tNorm-0.6)/0.4);
  // slight per-particle color jitter so the disk isn't perfectly smooth-banded
  const jitter = 0.06;
  col.r = THREE.MathUtils.clamp(col.r + (Math.random()-0.5)*jitter, 0, 1);
  col.g = THREE.MathUtils.clamp(col.g + (Math.random()-0.5)*jitter, 0, 1);
  col.b = THREE.MathUtils.clamp(col.b + (Math.random()-0.5)*jitter, 0, 1);
  diskColor[i*3]=col.r; diskColor[i*3+1]=col.g; diskColor[i*3+2]=col.b;
  diskRadiusFactor[i] = THREE.MathUtils.clamp(tNorm, 0, 1);
}
diskGeo.setAttribute('position', new THREE.BufferAttribute(diskPos,3));
diskGeo.setAttribute('color', new THREE.BufferAttribute(diskColor,3));
diskGeo.setAttribute('radiusFactor', new THREE.BufferAttribute(diskRadiusFactor,1));

// custom shader material: adds Doppler beaming (approaching side of the
// disk glows brighter than the receding side, a real relativistic effect)
// and gravitational redshift (particles dim/redden as they near the horizon)
const diskMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 2.1 } },
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute float radiusFactor;
    uniform float uSize;
    varying vec3 vColor;
    varying float vBrightness;
    void main(){
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vec3 viewDir = normalize(cameraPosition - worldPos.xyz);

      // tangential direction of orbital motion at this point (perpendicular
      // to the radius vector, in the local XZ plane before tilt)
      vec3 tangentLocal = normalize(vec3(-position.z, 0.0, position.x));
      vec3 tangentWorld = normalize(mat3(modelMatrix) * tangentLocal);

      float doppler = dot(viewDir, tangentWorld); // +1 approaching, -1 receding
      float beaming = 1.0 + doppler * 0.5;

      // gravitational redshift: dim and redden near the horizon
      float redshift = mix(0.35, 1.0, radiusFactor);

      vBrightness = clamp(beaming * redshift, 0.08, 1.3);
      vColor = color;

      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vBrightness;
    void main(){
      vec2 c = gl_PointCoord - vec2(0.5);
      float d = length(c);
      if(d > 0.5) discard;
      float edge = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vColor * vBrightness, edge);
    }
  `
});
const diskPoints = new THREE.Points(diskGeo, diskMat);
scene.add(diskPoints);

// disk tilt for a nicer 3D read
diskPoints.rotation.x = 0.16;
// (disk tilt handled below via DISK_TILT)
const DISK_TILT = 0.16;

// ---------- bright photon particle layer ----------
// A sparse layer of much hotter, brighter, faster-moving points riding just
// above/below the main disk — reads as flickering high-energy photons near
// the innermost stable orbit, the way real accretion-disk renders look.
const PHOTON_COUNT = 2200;
const photonGeo = new THREE.BufferGeometry();
const photonPos = new Float32Array(PHOTON_COUNT*3);
const photonData = [];
for(let i=0;i<PHOTON_COUNT;i++){
  const radius = horizonBaseR*1.15 + Math.pow(Math.random(),2.5)*horizonBaseR*3;
  const angle = Math.random()*Math.PI*2;
  const speed = keplerAngularSpeed(radius, 1.3);
  const height = (Math.random()-0.5)*0.6;
  photonData.push({ radius, angle, speed, height, flicker: Math.random()*Math.PI*2, flickerFreq: 4+Math.random()*8 });
  photonPos[i*3]=Math.cos(angle)*radius; photonPos[i*3+1]=height; photonPos[i*3+2]=Math.sin(angle)*radius;
}
photonGeo.setAttribute('position', new THREE.BufferAttribute(photonPos,3));
const photonMat = new THREE.PointsMaterial({ color:0xfff2d8, size:0.5, transparent:true, opacity:0.35, blending:THREE.AdditiveBlending, depthWrite:false, sizeAttenuation:true });
const photonPoints = new THREE.Points(photonGeo, photonMat);
photonPoints.rotation.x = DISK_TILT;
scene.add(photonPoints);

// ---------- gas cloud puffs riding the disk ----------
// Soft billowing sprites layered over the particle disk, textured like real
// turbulent plasma clumps rather than a smooth ring.
function makeGasPuffTexture(hue){
  const c = document.createElement('canvas'); c.width=128; c.height=128;
  const cx2 = c.getContext('2d');
  const g = cx2.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0, `hsla(${hue},90%,75%,0.28)`);
  g.addColorStop(0.4, `hsla(${hue},85%,58%,0.13)`);
  g.addColorStop(1, `hsla(${hue},80%,50%,0)`);
  cx2.fillStyle = g; cx2.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(c);
}
const gasHues = [25, 35, 45, 15];
const gasTextures = gasHues.map(makeGasPuffTexture);
const GAS_COUNT = 140;
const gasPuffs = [];
const gasGroup = new THREE.Group();
for(let i=0;i<GAS_COUNT;i++){
  const radius = horizonBaseR*1.6 + Math.pow(Math.random(),1.3)*horizonBaseR*6.5;
  const angle = Math.random()*Math.PI*2;
  const speed = keplerAngularSpeed(radius, 0.9);
  const height = (Math.random()-0.5)*1.5*(radius/(horizonBaseR*8));
  const tex = gasTextures[Math.floor(Math.random()*gasTextures.length)];
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, opacity:0.25+Math.random()*0.2 });
  const sprite = new THREE.Sprite(mat);
  const scale = horizonBaseR*(0.5+Math.random()*1.0);
  sprite.scale.set(scale, scale, 1);
  gasGroup.add(sprite);
  gasPuffs.push({ sprite, radius, angle, speed, height, baseScale:scale, phase:Math.random()*Math.PI*2 });
}
gasGroup.rotation.x = DISK_TILT;
scene.add(gasGroup);

// ---------- relativistic plasma jets ----------
// Real accretion disks around a spinning black hole often launch narrow,
// fast-moving jets of plasma along the rotation axis — perpendicular to the
// disk plane, not in it. Particles are recycled: spawned near the horizon,
// accelerated outward, then respawned once they travel far enough, giving
// a continuous streaming jet rather than a one-shot burst.
const JET_COUNT = 9000; // total across both north/south jets
const jetGeo = new THREE.BufferGeometry();
const jetPos = new Float32Array(JET_COUNT*3);
const jetColor = new Float32Array(JET_COUNT*3);
const jetData = [];

const jetCoreColor = new THREE.Color(0xdfefff); // white-blue, synchrotron-radiation color
const jetOuterColor = new THREE.Color(0x5f8fff); // cooler blue further out
const JET_MAX_LEN = horizonBaseR * 55;

function spawnJetParticle(i, forceReset){
  const side = i%2===0 ? 1 : -1; // alternate north/south
  const travel = forceReset ? Math.random()*JET_MAX_LEN*0.06 : Math.random()*JET_MAX_LEN;
  const spiralAngle = Math.random()*Math.PI*2;
  const spiralSpeed = 0.6 + Math.random()*1.2;
  // cone widens gradually with distance from the black hole
  const coneFactor = 0.04 + Math.random()*0.05;
  const baseSpeed = horizonBaseR * (1.1 + Math.random()*0.7); // units per second, accelerating stream
  const data = jetData[i] || {};
  data.side = side; data.travel = travel; data.spiralAngle = spiralAngle;
  data.spiralSpeed = spiralSpeed; data.coneFactor = coneFactor; data.baseSpeed = baseSpeed;
  jetData[i] = data;
}
for(let i=0;i<JET_COUNT;i++){ spawnJetParticle(i, false); }

function jetParticlePosition(d){
  const radialSpread = d.travel * d.coneFactor;
  const px = Math.cos(d.spiralAngle) * radialSpread;
  const pz = Math.sin(d.spiralAngle) * radialSpread;
  const py = d.side * (horizonBaseR*1.1 + d.travel);
  return [px, py, pz];
}
for(let i=0;i<JET_COUNT;i++){
  const [x,y,z] = jetParticlePosition(jetData[i]);
  jetPos[i*3]=x; jetPos[i*3+1]=y; jetPos[i*3+2]=z;
  const tNorm = THREE.MathUtils.clamp(jetData[i].travel/JET_MAX_LEN, 0, 1);
  const col = jetCoreColor.clone().lerp(jetOuterColor, tNorm);
  jetColor[i*3]=col.r; jetColor[i*3+1]=col.g; jetColor[i*3+2]=col.b;
}
jetGeo.setAttribute('position', new THREE.BufferAttribute(jetPos,3));
jetGeo.setAttribute('color', new THREE.BufferAttribute(jetColor,3));
const jetMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 2.2 } },
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uSize;
    varying vec3 vColor;
    void main(){
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main(){
      vec2 c = gl_PointCoord - vec2(0.5);
      float d = length(c);
      if(d > 0.5) discard;
      float edge = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vColor, edge * 0.85);
    }
  `
});
const jetPoints = new THREE.Points(jetGeo, jetMat);
// jets fire along the disk's normal axis — same tilt as the disk itself,
// rotated 90° so "up the jet" lines up with "perpendicular to the disk"
jetPoints.rotation.x = DISK_TILT;
scene.add(jetPoints);

// soft glow cones around each jet for a hazier, more energetic look
function makeJetGlow(){
  const geo = new THREE.CylinderGeometry(horizonBaseR*0.35, horizonBaseR*2.2, JET_MAX_LEN, 24, 1, true);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0x6fa8ff) } },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main(){
        float fade = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
        gl_FragColor = vec4(uColor, fade*0.10);
      }
    `
  });
  const north = new THREE.Mesh(geo, mat);
  north.position.y = horizonBaseR*1.1 + JET_MAX_LEN/2;
  const south = new THREE.Mesh(geo, mat);
  south.rotation.z = Math.PI;
  south.position.y = -(horizonBaseR*1.1 + JET_MAX_LEN/2);
  const group = new THREE.Group();
  group.add(north, south);
  group.rotation.x = DISK_TILT;
  return group;
}
const jetGlow = makeJetGlow();
scene.add(jetGlow);


document.getElementById('mass').addEventListener('input', e=>{
  massMult = parseFloat(e.target.value);
  document.getElementById('mVal').textContent = massMult.toFixed(2)+'×';
  const s = 0.7 + massMult*0.5;
  horizon.scale.setScalar(s);
  lensingHalo.scale.setScalar(s);
  glowSprite.scale.set(horizonBaseR*5.5*s, horizonBaseR*5.5*s, 1);
  lensingPass.uniforms.uStrength.value = 0.26 * massMult;
  lensingPass.uniforms.uRadius.value = 0.5 * s;
});
let speedMult = 1;
document.getElementById('speed').addEventListener('input', e=>{
  speedMult = parseFloat(e.target.value);
  document.getElementById('sVal').textContent = speedMult.toFixed(2)+'×';
});
document.getElementById('resetBtn').addEventListener('click', ()=>{
  camera.position.set(0,55,260);
  controls.target.set(0,0,0);
});

// settings panel: closed by default, slides in from the right on toggle
const panelEl = document.getElementById('panel');
const settingsBtn = document.getElementById('settingsBtn');
settingsBtn.addEventListener('click', ()=>{
  panelEl.classList.toggle('open');
  settingsBtn.classList.toggle('open');
});

// ---------- resize ----------
window.addEventListener('resize', ()=>{
  camera.aspect = holder.clientWidth/holder.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(holder.clientWidth, holder.clientHeight);
  composer.setSize(holder.clientWidth, holder.clientHeight);
  lensingPass.uniforms.uAspect.value = holder.clientWidth / holder.clientHeight;
  gradePass.uniforms.uAspect.value = holder.clientWidth / holder.clientHeight;
});

// ---------- animate ----------
let tGlobal = 0;
function animate(){
  requestAnimationFrame(animate);
  tGlobal += 0.016*speedMult;

  // rotate disk particles around Y with keplerian-ish speed per radius,
  // plus per-particle turbulence so the gas churns instead of tracing
  // perfect flat circles
  const posAttr = diskGeo.attributes.position;
  for(let i=0;i<DISK_COUNT;i++){
    const d = diskData[i];
    d.angle += d.speed*0.02*speedMult;
    const rTurb = d.radius + Math.sin(tGlobal*d.turbFreqR + d.turbPhaseR) * d.turbAmpR;
    const hTurb = d.heightBase + Math.sin(tGlobal*d.turbFreqH + d.turbPhaseH) * d.turbAmpH * 0.4;
    const x = Math.cos(d.angle)*rTurb;
    const z = Math.sin(d.angle)*rTurb;
    posAttr.setXYZ(i, x, hTurb, z);
  }
  posAttr.needsUpdate = true;
  lensingHalo.rotation.y += 0.0015*speedMult;

  // plasma jets: particles stream outward and spiral slightly; once a
  // particle travels past the jet's max length it's recycled back near
  // the base, keeping the stream continuous
  const jetPosAttr = jetGeo.attributes.position;
  for(let i=0;i<JET_COUNT;i++){
    const d = jetData[i];
    d.travel += d.baseSpeed*0.02*speedMult*(1.0 + d.travel/JET_MAX_LEN*1.5); // accelerates outward
    d.spiralAngle += d.spiralSpeed*0.02*speedMult;
    if(d.travel > JET_MAX_LEN){ spawnJetParticle(i, true); }
    const [x,y,z] = jetParticlePosition(d);
    jetPosAttr.setXYZ(i, x, y, z);
  }
  jetPosAttr.needsUpdate = true;

  // photon layer: fast orbit + flicker via size pulsing isn't per-point
  // cheap in PointsMaterial, so we drive it via subtle opacity pulse instead
  const pPosAttr = photonGeo.attributes.position;
  for(let i=0;i<PHOTON_COUNT;i++){
    const p = photonData[i];
    p.angle += p.speed*0.025*speedMult;
    pPosAttr.setXYZ(i, Math.cos(p.angle)*p.radius, p.height, Math.sin(p.angle)*p.radius);
  }
  pPosAttr.needsUpdate = true;
  photonMat.opacity = 0.4 + Math.sin(tGlobal*6.0)*0.12;

  // gas puffs drift with the disk rotation and gently pulse in scale
  for(const g of gasPuffs){
    g.angle += g.speed*0.02*speedMult;
    const rTurb = g.radius + Math.sin(tGlobal*0.4 + g.angle)*g.radius*0.03;
    g.sprite.position.set(Math.cos(g.angle)*rTurb, g.height, Math.sin(g.angle)*rTurb);
    const pulse = 1.0 + Math.sin(tGlobal*0.7 + g.phase)*0.12;
    g.sprite.scale.set(g.baseScale*pulse, g.baseScale*pulse, 1);
    g.sprite.material.rotation += 0.001*speedMult;
  }

  updateLensCenter();
  controls.update();
  composer.render();
}

document.getElementById('loading').style.display = 'none';
animate();
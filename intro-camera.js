/* Opening animation: the R6 Mark II + EF 50 f/1.2L come apart as the visitor scrolls (or swipes); scrolling back puts it
   together, scrolling on past fully apart fades into the site. Nothing moves on its own.
   Loaded by index.html (runIntro) only when the opening plays. Calls window.gspIntroDone() when finished. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ---------- renderer / scene ---------- */
const stage = document.getElementById('introCam');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const key = new THREE.DirectionalLight(0xffffff, .85); key.position.set(-8, 6, 10); scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(8, 4, -10); scene.add(rim);
scene.add(new THREE.AmbientLight(0xffffff, 0.08));

const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 200);

/* ---------- materials ---------- */
const M = {
  body:   new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: .55, metalness: .3, envMapIntensity: .22 }),
  satin:  new THREE.MeshStandardMaterial({ color: 0x262627, roughness: .34, metalness: .7, envMapIntensity: .38 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0f0f0f, roughness: .9,  metalness: 0, envMapIntensity: .3 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: .14, metalness: 1, envMapIntensity: 1.4 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x030303, roughness: .06, metalness: .4, envMapIntensity: 1.6 }),
  pcb:    new THREE.MeshStandardMaterial({ color: 0x3a3a3b, roughness: .6,  metalness: .2 }),
  sensor: new THREE.MeshPhysicalMaterial({ color: 0x3b3d42, roughness: .08, metalness: .95, clearcoat: 1, envMapIntensity: 2 }),
  white:  new THREE.MeshBasicMaterial({ color: 0xe8e8e8 }),
  glass:  new THREE.MeshPhysicalMaterial({ color: 0x6c7178, roughness: 0, metalness: .1, transparent: true, opacity: .24, clearcoat: 1, envMapIntensity: 2, depthWrite: false, side: THREE.DoubleSide }),
};
M.body.side = M.satin.side = M.rubber.side = M.chrome.side = THREE.DoubleSide;

/* ---------- geometry helpers ---------- */
const TAU = Math.PI * 2;
const rbox = (w, h, d, r = .1) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - .001, h / 2 - .001, d / 2 - .001));
const zcyl = (r1, r2, h, s = 64) => new THREE.CylinderGeometry(r1, r2, h, s).rotateX(Math.PI / 2); // axis on z, r1 faces +z
const ycyl = (r1, r2, h, s = 64) => new THREE.CylinderGeometry(r1, r2, h, s);
function lathe(pts, seg = 96) { // [r, z] profile around the z axis
  const p = pts.map(([r, z]) => new THREE.Vector2(r, z));
  if (!p[0].equals(p[p.length - 1])) p.push(p[0].clone());
  return new THREE.LatheGeometry(p, seg).rotateX(Math.PI / 2);
}
function ring(rIn, rOut, z0, z1) { return lathe([[rIn, z0], [rOut, z0], [rOut, z1], [rIn, z1]]); }
function lens(R, t, s1, s2, n = 20) { // s1 front sag (+ convex), s2 back sag (+ convex)
  const pts = [];
  for (let i = 0; i <= n; i++) { const r = R * i / n; pts.push([r, -t / 2 - s2 * (1 - (r / R) ** 2)]); }
  for (let i = n; i >= 0; i--) { const r = R * i / n; pts.push([r, t / 2 + s1 * (1 - (r / R) ** 2)]); }
  return new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), 96).rotateX(Math.PI / 2);
}
function extrudeShape(shape, depth, bevel = 0) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 48 });
  return g.translate(0, 0, -depth / 2);
}
function rectShape(w, h, cx = 0, cy = 0) {
  const s = new THREE.Shape();
  s.moveTo(cx - w / 2, cy - h / 2); s.lineTo(cx + w / 2, cy - h / 2); s.lineTo(cx + w / 2, cy + h / 2); s.lineTo(cx - w / 2, cy + h / 2); s.closePath();
  return s;
}

/* ---------- parts ---------- */
const root = new THREE.Group(); scene.add(root);
const parts = [];
function part(opts) {
  const g = new THREE.Group();
  g.position.fromArray(opts.at || [0, 0, 0]);
  root.add(g);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .12, depthWrite: false });
  const p = Object.assign({ off: [0, 0, 0], rot: [0, 0, 0], anchor: [0, 0, 0], g, lineMat, bom: true }, opts);
  p.base = g.position.clone();
  p.off = new THREE.Vector3().fromArray(p.off);
  p.anchorV = new THREE.Vector3().fromArray(p.anchor);
  p.add = (geo, mat, pos = [0, 0, 0], rot = [0, 0, 0], edges = true) => {
    const m = new THREE.Mesh(geo, mat); m.position.fromArray(pos); m.rotation.fromArray(rot); g.add(m);
    if (edges) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), lineMat));
    return m;
  };
  parts.push(p);
  return p;
}

// optical axis of the mount
const AX = 0.8, AY = -0.3;
const FRONT = 2.15;          // body front face
const RFZ = 2.38;            // RF mount face
const ADZ = RFZ + 0.35;      // adapter rear
const LZ = ADZ + 2.4;        // EF flange (lens rear)
const LENS_OFF = 4.4;        // how far the whole lens travels forward

/* 01 chassis */
{
  const p = part({ n: 1, name: 'Chassis', spec: 'Magnesium alloy, weather sealed', anchor: [-6.9, -2.4, .4] });
  p.add(rbox(13.6, 7.9, 4.3, .55), M.body, [0, -.05, 0]);
  p.add(rbox(3.3, 7.7, 3.7, 1.1), M.rubber, [-5.15, -.1, 2.55]);               // grip
  p.add(zcyl(3.35, 3.45, .26), M.body, [AX, AY, FRONT + .1]);                   // mount boss
  p.add(zcyl(2.72, 2.72, .02), M.screen, [AX, AY, FRONT + .24], [0, 0, 0], false); // mirrorless throat
  p.add(zcyl(.32, .32, .2, 32), M.satin, [AX + 3.65, AY - 1.4, FRONT + .1]);     // lens release
  p.add(zcyl(.22, .22, .16, 32), M.satin, [-3.3, -2.4, FRONT + .05]);            // DOF button
  p.add(rbox(.35, .9, .6, .12), M.satin, [6.85, 2.7, -.6]);                      // strap lugs
  p.add(rbox(.35, .9, .6, .12), M.satin, [-6.85, 2.7, -.6]);
  p.add(rbox(.12, 2.6, 2.2, .05), M.rubber, [6.83, -.6, -.2]);                   // port doors
  p.add(rbox(.12, 3.2, 2.6, .05), M.rubber, [-6.85, .4, 2.6]);                   // card door
  p.add(ycyl(.42, .42, .08, 32), M.satin, [AX, -4.04, 0]);                       // tripod thread
}

/* 02 top plate + dials */
{
  const p = part({ n: 2, name: 'Top plate & viewfinder', spec: 'Dials, shutter release, 3.69M-dot OLED EVF', off: [0, 5.4, 0], anchor: [-3, .7, -.4] });
  p.add(rbox(13.2, .5, 4.1, .2), M.body, [0, 4.12, 0]);
  p.add(ycyl(1.05, 1.05, .55, 72), M.satin, [-3.1, 4.64, -.45]);   // mode dial
  p.add(ycyl(.8, .85, .12, 48), M.body, [-3.1, 4.97, -.45]);
  p.add(rbox(.08, .02, .35, .01), M.white, [-3.1, 5.04, .1], [0, 0, 0], false);
  p.add(ycyl(.8, .8, .32, 72), M.satin, [-4.85, 4.34, 1.7]);       // main dial
  p.add(ycyl(.42, .46, .26, 48), M.satin, [-5.15, 4.0, 3.25], [-.22, 0, 0]); // shutter button
  p.add(ycyl(.62, .62, .08, 48), M.body, [-5.15, 3.88, 3.25], [-.22, 0, 0]);
  p.add(ycyl(.7, .7, .3, 72), M.satin, [-1.35, 4.5, -1.2]);        // rear dial
  p.add(rbox(1.0, .22, .5, .1), M.satin, [4.7, 4.48, .4]);         // power lever
  p.add(ycyl(.55, .55, .22, 48), M.satin, [4.7, 4.48, -.7]);       // stills / video
  p.add(ycyl(.2, .2, .12, 24), M.satin, [-4.2, 4.42, .5]);
  p.add(ycyl(.2, .2, .12, 24), M.satin, [-4.8, 4.42, .1]);
}

/* 03 EVF */
{
  const p = part({ n: 2, bom: false, name: '', spec: '', at: [AX, 4.35, -.15], off: [0, 5.4, 0], anchor: [1.8, 1.0, 1.4] });
  const s = new THREE.Shape(); s.moveTo(-2.75, 0); s.lineTo(2.75, 0); s.lineTo(1.45, 1.5); s.lineTo(-1.45, 1.5); s.closePath();
  p.add(extrudeShape(s, 3.7, .1), M.body, [0, 0, 0]);
  p.add(rbox(2.0, .16, 1.9, .03), M.satin, [0, 1.68, .3]);           // hot shoe
  p.add(rbox(1.6, .08, 1.5, .02), M.chrome, [0, 1.77, .3]);
  p.add(rbox(4.1, 2.8, .95, .5), M.rubber, [0, .85, -2.35]);         // eyecup
  p.add(rbox(2.5, 1.7, .05, .2), M.screen, [0, .85, -2.84], [0, 0, 0], false);
  p.add(rbox(.5, .5, .2, .1), M.satin, [1.75, 1.25, -1.9]);          // dioptre
}

/* 04 rear LCD (vari-angle, hinge on the left edge) */
{
  const p = part({ n: 3, name: 'Vari-angle LCD', spec: '3.0" 1.62M-dot touchscreen', at: [4.95, -.55, -2.82], off: [2.2, 0, -12.6], rot: [0, .95, 0], anchor: [-3.7, 2.4, 0] });
  p.add(rbox(7.4, 5.2, .48, .3), M.body, [-3.7, 0, 0]);
  p.add(rbox(6.7, 4.5, .04, .08), M.screen, [-3.75, 0, -.25], [0, 0, 0], false);
  p.add(ycyl(.18, .18, 4.4, 24), M.satin, [.05, 0, 0]);
}

/* 05 rear control plate */
{
  const p = part({ n: 4, name: 'Rear control plate', spec: 'Multi-controller, quick control dial', at: [0, -.05, -2.37], off: [0, 0, -8.6], anchor: [-4.8, -1.1, -.3] });
  p.add(rbox(13.0, 7.6, .36, .3), M.body, [0, 0, 0]);
  p.add(zcyl(1.05, 1.05, .28, 72), M.satin, [-4.8, -1.1, -.3]);   // quick control dial
  p.add(zcyl(.45, .45, .32, 48), M.body, [-4.8, -1.1, -.3]);
  p.add(zcyl(.34, .3, .38, 32), M.satin, [-3.6, 1.2, -.3]);       // multi-controller
  p.add(zcyl(.45, .45, .25, 48), M.satin, [-4.5, 2.75, -.25]);    // AF-ON
  p.add(zcyl(.32, .32, .22, 32), M.satin, [-5.7, 2.75, -.25]);    // AE lock
  for (let i = 0; i < 4; i++) p.add(zcyl(.26, .26, .2, 32), M.satin, [5.85, 2.2 - i * 1.15, -.22]);
  p.add(rbox(2.3, 3.0, .2, .4), M.rubber, [-5.3, .9, -.24]);      // thumb rest
}

/* 06 shutter */
{
  const p = part({ n: 5, bom: false, name: '', spec: '', at: [AX, AY, .95], off: [0, 0, -6.6], anchor: [2.7, 2.0, 0] });
  const s = rectShape(5.5, 4.4); s.holes.push(rectShape(3.9, 2.7));
  p.add(extrudeShape(s, .42), M.satin);
  for (let i = 0; i < 4; i++) p.add(rbox(3.95, .58, .02, .01), M.body, [0, -1.05 + i * .32, .1 - i * .03]);
  p.add(rbox(.9, 1.2, .5, .1), M.pcb, [2.6, 1.3, -.15]);          // shutter motor
}

/* 07 sensor + IBIS */
{
  const p = part({ n: 5, name: 'Sensor & shutter', spec: '24.2 MP full-frame CMOS, 5-axis IBIS', at: [AX, AY, .42], off: [0, 0, -6.6], anchor: [1.8, 1.25, .1] });
  p.add(rbox(6.6, 5.6, .32, .3), M.satin, [0, 0, -.38]);           // stabiliser carrier
  for (const [x, y] of [[-2.6, 2.1], [2.6, 2.1], [-2.6, -2.1], [2.6, -2.1]]) p.add(rbox(1.15, .8, .32, .08), M.pcb, [x, y, -.72]); // voice coils
  p.add(rbox(4.6, 3.6, .2, .1), M.pcb, [0, 0, -.12]);              // ceramic package
  p.add(rbox(3.6, 2.4, .05, .02), M.sensor, [0, 0, 0], [0, 0, 0], false);
  p.add(rbox(5.2, 4.0, .12, .05), M.pcb, [0, 0, -1.0]);            // board
}

/* 08 battery */
{
  const p = part({ n: 6, name: 'Battery LP-E6NH', spec: '7.2 V, 2130 mAh', at: [-5.15, -1.0, 2.1], off: [0, -8.6, .4], anchor: [-1.05, -1.6, 0] });
  p.add(rbox(2.05, 5.5, 3.8, .22), M.body);
  p.add(rbox(2.07, 1.2, 3.82, .05), M.satin, [0, 1.2, 0]);
  p.add(rbox(.03, .2, 2.4, .01), M.white, [-1.04, -1.4, 0], [0, 0, 0], false);
  for (let i = 0; i < 3; i++) p.add(rbox(.3, .05, .3, .02), M.chrome, [0, 2.76, -1 + i * .7], [0, 0, 0], false);
}

/* 09 cards (two, spread apart) */
{
  const mk = (bom, z, offX) => {
    const p = part({ n: 7, bom, name: 'Dual card slots', spec: '2 × SD UHS-II', at: [-5.6, .5, z], off: [offX, 1.6, 0], rot: [0, 0, 0], anchor: [-1.6, 1.2, 0] });
    p.add(rbox(3.2, 2.4, .21, .08), M.body);
    p.add(rbox(.6, 2.42, .23, .02), M.satin, [-1.3, 0, 0]);
    p.add(rbox(.02, 1.4, .24, .01), M.white, [-.3, .2, 0], [0, 0, 0], false);
  };
  mk(true, 2.35, -7.0); mk(false, 2.85, -7.0);
}

/* 10 RF mount */
{
  const p = part({ n: 8, name: 'RF mount', spec: '54 mm throat, 20 mm flange, 12 pins', at: [AX, AY, RFZ], off: [0, 0, 1.5], anchor: [2.7, 1.55, .2] });
  p.add(lathe([[2.72, 0], [3.12, 0], [3.12, .2], [2.96, .22], [2.96, .35], [2.72, .35]]), M.chrome);
  for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; p.add(zcyl(.08, .08, .04, 16), M.body, [Math.cos(a) * 2.98, Math.sin(a) * 2.98, .37], [0, 0, 0], false); }
  for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + .6 + i * TAU / 3; p.add(rbox(1.1, .26, .1, .03), M.chrome, [Math.cos(a) * 2.6, Math.sin(a) * 2.6, .3], [0, 0, a - Math.PI / 2]); }
  for (let i = 0; i < 12; i++) { const a = Math.PI / 2 + (i - 5.5) * .07; p.add(rbox(.07, .14, .06, .01), M.chrome, [Math.cos(a) * 2.45, Math.sin(a) * 2.45, .05], [0, 0, a - Math.PI / 2], false); }
}

/* 11 adapter */
{
  const p = part({ n: 9, name: 'Mount adapter EF-EOS R', spec: '24 mm spacer, EF to RF', at: [AX, AY, ADZ], off: [0, 0, 3.0], anchor: [2.45, 2.45, 1.2] });
  p.add(lathe([[2.7, 0], [3.02, 0], [3.02, .16], [3.45, .26], [3.45, 2.1], [3.3, 2.22], [3.3, 2.4], [2.7, 2.4]]), M.body);
  p.add(ring(2.72, 3.28, 2.25, 2.4), M.chrome);
  p.add(ycyl(.1, .1, .04, 24), M.white, [0, 3.46, 1.85], [0, 0, 0], false); // index dot
  p.add(zcyl(.3, .3, .2, 32).rotateY(Math.PI / 2), M.satin, [3.5, -.8, 1.4]); // release
  for (let i = 0; i < 8; i++) { const a = -Math.PI / 2 + (i - 3.5) * .09; p.add(rbox(.1, .1, .05, .01), M.chrome, [Math.cos(a) * 2.5, Math.sin(a) * 2.5, 2.37], [0, 0, 0], false); }
}

/* 12-16 the lens: EF 50mm f/1.2L USM (85.4 mm wide, 65.5 mm long) */
{
  const at = [AX, AY, LZ];
  // 12 EF mount
  const m = part({ n: 10, bom: false, name: '', spec: '', at, off: [0, 7.2, LENS_OFF + 2.2], anchor: [2.0, -2.0, .15] });
  m.add(ring(2.42, 2.92, 0, .28), M.chrome);
  m.add(ring(1.95, 2.42, .05, .3), M.rubber);
  for (let i = 0; i < 3; i++) { const a = -.3 + i * TAU / 3; m.add(rbox(1.2, .28, .12, .03), M.chrome, [Math.cos(a) * 2.95, Math.sin(a) * 2.95, .14], [0, 0, a - Math.PI / 2]); }

  // 13 barrel (rear section, focus ring, front section) - shells lift off the optics
  const b = part({ n: 10, name: 'Lens barrel', spec: 'EF mount, ring-type USM, focus ring', at, off: [0, 7.2, LENS_OFF + 2.2], anchor: [0, 4.2, 1.4] });
  b.add(lathe([[3.25, .28], [3.7, .28], [3.72, .55], [4.15, .9], [4.15, 2.4], [3.95, 2.4], [3.95, .55], [3.25, .55]]), M.body);
  b.add(rbox(1.7, .45, .14, .06), M.screen, [0, 4.1, 1.55], [-Math.PI / 2, 0, 0], false);   // distance window
  b.add(rbox(.18, .95, .5, .06), M.satin, [-4.2, .2, 1.6]);                                  // AF/MF switch
  const f = part({ n: 10, bom: false, name: '', spec: '', at, off: [0, 7.2, LENS_OFF + 2.2], anchor: [0, 4.3, 3.7] });
  const fr = [[4.0, 2.45]];
  for (let z = 2.45, k = 0; z < 4.95; z += .125, k++) fr.push([k % 2 ? 4.18 : 4.28, z], [k % 2 ? 4.18 : 4.28, z + .125]);
  fr.push([4.0, 4.95]);
  f.add(lathe(fr, 128), M.rubber);
  const fb = part({ n: 10, bom: false, name: '', spec: '', at, off: [0, 7.2, LENS_OFF + 2.2], anchor: [0, 4.2, 5.8] });
  fb.add(lathe([[3.6, 5.0], [4.2, 5.0], [4.2, 6.3], [4.05, 6.55], [3.6, 6.55]]), M.body);
  fb.add(ring(4.2, 4.215, 5.35, 5.42), M.white);                                              // lens ring
  fb.add(ring(3.3, 3.6, 6.3, 6.5), M.body);                                                   // filter thread

  // 14 aperture
  const ap = part({ n: 11, bom: false, name: '', spec: '', at, off: [0, 0, LENS_OFF + 4.8], anchor: [1.9, 1.9, 2.7] });
  {
    const R = 2.75, r = 1.6, s = new THREE.Shape(); s.absarc(0, 0, R, 0, TAU, false);
    const h = new THREE.Path(), v = [];
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + Math.PI / 8; v.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r)); }
    v.forEach((q, i) => i ? h.lineTo(q.x, q.y) : h.moveTo(q.x, q.y)); h.closePath(); s.holes.push(h);
    ap.add(extrudeShape(s, .05), M.satin, [0, 0, 2.7]);
    const seg = [];
    v.forEach((q, i) => { // blade edges: continue each side of the octagon out to the rim
      const d = v[(i + 1) % 8].clone().sub(q).normalize().negate();
      const bq = q.dot(d), t = -bq + Math.sqrt(bq * bq - (q.lengthSq() - R * R));
      seg.push(q.x, q.y, 2.73, q.x + d.x * t, q.y + d.y * t, 2.73);
    });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    ap.g.add(new THREE.LineSegments(lg, ap.lineMat));
    ap.add(ring(2.75, 3.0, 2.62, 2.8), M.body);
  }

  // 15 optics: 8 elements in 6 groups, spread out along the axis
  const S = 1.7; // axial spread
  const groups = [ // [z, R, t, s1, s2]
    [[.8, 1.95, .34, .12, .1]],                                   // G6
    [[1.35, 2.0, .34, .18, .22]],                                 // G5 aspherical
    [[1.85, 2.15, .22, -.08, .18], [2.12, 2.15, .3, .22, .08]],   // G4 cemented
    [[3.2, 2.6, .26, .05, -.22], [3.55, 2.6, .44, .26, -.05]],    // G3 cemented
    [[4.6, 3.0, .26, .38, -.3]],                                  // G2 meniscus
  ];
  const opt = part({ n: 11, name: 'Optics', spec: '8 elements in 6 groups, 8-blade aperture', at, off: [0, 0, LENS_OFF], anchor: [2.2, 2.2, 10.6] });
  opt.subs = [];
  groups.forEach(gr => gr.forEach(([z, R, t, s1, s2]) => {
    const mesh = opt.add(lens(R, t, s1, s2), M.glass, [0, 0, z]);
    mesh.renderOrder = 2;
    opt.subs.push({ mesh, z, dz: z * (S - 1) });
  }));
  const fe = part({ n: 11, bom: false, name: '', spec: '', at, off: [0, 0, LENS_OFF + 5.75 * (S - 1) + 1.4], anchor: [2.4, 2.4, 5.8] });
  fe.add(lens(3.35, .5, .6, .06), M.glass, [0, 0, 5.75]).renderOrder = 2;
}

const BOM = parts.filter(p => p.bom).sort((a, b) => a.n - b.n);
const N = BOM.length;

/* ---------- overlays ---------- */
const tagsEl = document.getElementById('introTags');
const SHORT = { 'Top plate & viewfinder': 'Top plate', 'Vari-angle LCD': 'Screen', 'Rear control plate': 'Rear plate', 'Sensor & shutter': 'Sensor',
  'Battery LP-E6NH': 'Battery', 'Dual card slots': 'SD cards', 'Mount adapter EF-EOS R': 'Adapter', 'Lens barrel': 'Barrel' }; // phone labels
const svg = document.getElementById('introLeaders');
const SVGNS = 'http://www.w3.org/2000/svg';
BOM.forEach(p => {
  const t = document.createElement('div'); t.className = 'tag';
  p.short = SHORT[p.name] || p.name;
  t.textContent = p.name;   // names only, no part numbers (dave, 2026-11-02)
  tagsEl.appendChild(t); p.tag = t;
  p.line = document.createElementNS(SVGNS, 'line'); p.dot = document.createElementNS(SVGNS, 'circle'); p.dot.setAttribute('r', 1.6);
  svg.append(p.line, p.dot);
});
const nowEl = document.getElementById('introNow');
const bar = document.getElementById('introBar');

/* ---------- timeline ---------- */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const lerp = (a, b, t) => a + (b - a) * t;
parts.forEach(p => { const k = BOM.findIndex(q => q.n === p.n); p.t0 = k / N * .62; p.t1 = p.t0 + .38; });
// scroll position: 0 assembled, APART fully exploded, 1 = enter the site
const APART = .8;
const explodeAt = p => clamp(p / APART);
let target = 0, prog = 0, finished = false;
function nudge(d) { if (!finished) target = clamp(target + d); }
const intro = document.getElementById('intro');
addEventListener('wheel', e => {
  if (!document.body.contains(stage)) return;
  e.preventDefault();
  const px = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
  nudge(px / (innerHeight * 1.82));   // shortened twice at dave's request: -30% (2026-11-01), then -35% (2026-11-02)
}, { passive: false });
let touchY = null;
intro.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
intro.addEventListener('touchmove', e => {
  if (touchY === null) return;
  e.preventDefault();
  const y = e.touches[0].clientY;
  nudge((touchY - y) / innerHeight); touchY = y;
}, { passive: false });
intro.addEventListener('touchend', () => { touchY = null; });
addEventListener('keydown', e => {
  if (!document.body.contains(stage)) return;
  const k = e.key;
  if (k === 'ArrowDown' || k === 'PageDown' || k === ' ') { e.preventDefault(); nudge(.177); }
  else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); nudge(-.177); }
});

/* ---------- framing ---------- */
const box = new THREE.Box3(), tmpBox = new THREE.Box3();
const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const view = { cx: 0, cy: 0, half: 10, init: false };
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
let W = innerWidth, H = innerHeight;
function resize() { W = innerWidth; H = innerHeight; renderer.setSize(W, H, false); }
addEventListener('resize', resize); resize();

function frame(e, spin) {
  // orbit: front three-quarter when assembled, settles to a 30deg isometric as it opens
  const az = lerp(-.62, -1.2, e) + spin;
  const el = lerp(.22, .42, e);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  cam.position.copy(dir).multiplyScalar(60);
  cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();

  box.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse(o => { if (o.isMesh) { o.geometry.boundingBox || o.geometry.computeBoundingBox(); tmpBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); box.union(tmpBox); } });
  const inv = cam.matrixWorldInverse;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  [box.min, box.max].forEach((a, i) => [box.min, box.max].forEach((b, j) => [box.min, box.max].forEach((c, k) => {
    tv.set(a.x, b.y, c.z).applyMatrix4(inv); x0 = Math.min(x0, tv.x); x1 = Math.max(x1, tv.x); y0 = Math.min(y0, tv.y); y1 = Math.max(y1, tv.y);
  })));
  const wide = W > 860;
  const usableW = wide ? W - 260 : W - 40;
  const usableH = wide ? H - 240 : H - 300;
  const aspect = usableW / usableH;
  let half = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect) * 1.12;
  const scale = half * 2 / usableH;                 // world units per px
  const offX = 0;
  const offY = wide ? 10 * scale : 30 * scale;
  const cx = (x0 + x1) / 2 - offX, cy = (y0 + y1) / 2 - offY;
  const nowT = performance.now(); // ease the framing by time, not frames, so slow phones keep up
  const k = view.init ? 1 - Math.pow(.88, Math.min(30, (nowT - view.t) / 16.7)) : 1; view.init = true; view.t = nowT;
  view.cx = lerp(view.cx, cx, k); view.cy = lerp(view.cy, cy, k); view.half = lerp(view.half, half * usableH / usableH, k);
  const hh = view.half * H / usableH, hw = hh * W / H;
  cam.left = view.cx - hw; cam.right = view.cx + hw; cam.top = view.cy + hh; cam.bottom = view.cy - hh;
  cam.updateProjectionMatrix();
  return dir;
}

function toScreen(v) { tv2.copy(v).project(cam); return [(tv2.x + 1) / 2 * W, (1 - tv2.y) / 2 * H]; }

/* ---------- loop ---------- */
stage.classList.add('ready');
const t0 = performance.now();
let lastT = t0;
function stop() {
  renderer.dispose(); pmrem.dispose();
  scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
}
function tick(now) {
  if (!document.body.contains(stage)) { stop(); return; }   // the intro was removed
  const dt = (now - lastT) / 1000; lastT = now;
  prog = lerp(prog, target, 1 - Math.pow(.0005, Math.min(dt, .1)));   // smooth the scroll, by time not frames
  if (target >= 1 && prog > .985 && !finished) { finished = true; if (window.gspIntroDone) window.gspIntroDone(); }
  const e = explodeAt(prog);
  const idle = Math.sin((now - t0) / 4000) * .05 * (1 - e * .6);

  parts.forEach(p => {
    const t = ease(clamp((e - p.t0) / (p.t1 - p.t0)));
    p.local = t;
    p.g.position.copy(p.base).addScaledVector(p.off, t);
    p.g.rotation.set(p.rot[0] * t, p.rot[1] * t, p.rot[2] * t);
    if (p.subs) p.subs.forEach(s => s.mesh.position.z = s.z + s.dz * t);
    p.lineMat.opacity = lerp(.1, .3, e);
  });

  frame(e, idle);
  renderer.render(scene, cam);

  // tags + leaders
  const center = toScreen(new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2));
  const wide = W > 860, reach = wide ? 46 : 30, gap = wide ? 22 : 28;
  const sides = [[], []];
  BOM.forEach(p => {
    p.show = p.local > .75 && e > .05 && prog < .93;
    [p.ax, p.ay] = toScreen(tv.copy(p.anchorV).applyMatrix4(p.g.matrixWorld));
    let dx = p.ax - center[0], dy = p.ay - center[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    p.left = dx < 0; p.tx = p.ax + dx * reach; p.ty = p.ay + dy * reach;
    if (p.show) sides[p.left ? 0 : 1].push(p);
  });
  sides.forEach(side => { // keep tags on each side from stacking on top of each other
    side.sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < side.length; i++) if (side[i].ty - side[i - 1].ty < gap) side[i].ty = side[i - 1].ty + gap;
  });
  BOM.forEach(p => {
    const { ax, ay, ty, left, show } = p; let { tx } = p;
    const label = wide ? p.name : p.short;
    if (p.tag.textContent !== label) { p.tag.textContent = label; p.tw = 0; }
    if (show && !p.tw) p.tw = p.tag.offsetWidth;
    if (p.tw) tx = left ? Math.max(tx, p.tw + 14) : Math.min(tx, W - 14 - p.tw);   // keep labels on screen
    p.tag.style.transform = `translate(${tx}px, ${ty}px) translate(${left ? 'calc(-100% - 6px)' : '6px'}, -50%)`;
    p.tag.style.opacity = show ? 1 : 0;
    p.line.setAttribute('x1', ax); p.line.setAttribute('y1', ay);
    p.line.setAttribute('x2', tx); p.line.setAttribute('y2', ty);
    p.line.style.opacity = p.dot.style.opacity = show ? 1 : 0;
    p.dot.setAttribute('cx', ax); p.dot.setAttribute('cy', ay);
  });
  nowEl.style.opacity = prog < .03 ? 1 : 0;
  bar.style.width = (prog * 100) + '%';
  stage.style.opacity = prog > .9 ? String(1 - (prog - .9) / .1 * .6) : '';

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

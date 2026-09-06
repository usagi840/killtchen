// Three.js is loaded lazily (see loadEngine below) so a CDN hiccup can never
// block the menu/lobby buttons, which only need plain DOM + socket.io.
let THREE = null;
let GLTFLoader = null;
async function loadEngine() {
  if (THREE) return;
  const [threeMod, loaderMod] = await Promise.all([
    import("https://unpkg.com/three@0.160.0/build/three.module.js"),
    import("https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js"),
  ]);
  THREE = threeMod;
  GLTFLoader = loaderMod.GLTFLoader;
}

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
const screens = {
  menu: document.getElementById("screen-menu"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game"),
  end: document.getElementById("screen-end"),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
const socket = io();
let selfId = null;
let currentRoomId = null;
let isHost = false;
let myRole = null; // 'killer' | 'white'
let iAmAlive = true;

const nameInput = document.getElementById("input-name");
const codeInput = document.getElementById("input-code");
const menuError = document.getElementById("menu-error");

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/\s/g, "");
});

socket.on("connect_error", () => {
  menuError.textContent = "Impossible de se connecter au serveur. Vérifie ta connexion et réessaie.";
});
socket.on("disconnect", () => {
  menuError.textContent = "Connexion au serveur perdue.";
});

document.getElementById("btn-create").addEventListener("click", () => {
  if (!nameInput.value.trim()) return (menuError.textContent = "Entre un nom d'abord.");
  menuError.textContent = "Connexion…";
  socket.emit("create-room", { name: nameInput.value.trim() });
  waitForResponse();
});
document.getElementById("btn-join").addEventListener("click", () => {
  if (!nameInput.value.trim()) return (menuError.textContent = "Entre un nom d'abord.");
  if (!codeInput.value.trim()) return (menuError.textContent = "Entre le code de la partie.");
  menuError.textContent = "Connexion…";
  socket.emit("join-room", { roomId: codeInput.value.trim(), name: nameInput.value.trim() });
  waitForResponse();
});
document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("start-game");
});
document.getElementById("btn-replay").addEventListener("click", () => window.location.reload());

let responseTimeout = null;
function waitForResponse() {
  clearTimeout(responseTimeout);
  responseTimeout = setTimeout(() => {
    if (screens.menu.classList.contains("active")) {
      menuError.textContent = "Le serveur ne répond pas. Vérifie le lien/l'état du serveur puis réessaie.";
    }
  }, 6000);
}
function clearResponseWait() {
  clearTimeout(responseTimeout);
}

socket.on("error-msg", (msg) => {
  clearResponseWait();
  menuError.textContent = msg;
});

socket.on("room-joined", ({ roomId, selfId: id }) => {
  clearResponseWait();
  currentRoomId = roomId;
  selfId = id;
  document.getElementById("room-code-display").textContent = roomId;
  showScreen("lobby");
});

socket.on("room-update", ({ players, hostId }) => {
  isHost = hostId === selfId;
  const list = document.getElementById("player-list");
  list.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="tag">${p.isHost ? "Hôte" : ""}</span>`;
    list.appendChild(li);
  });

  const btn = document.getElementById("btn-start");
  const hint = document.getElementById("lobby-hint");
  const n = players.length;
  if (!isHost) {
    btn.disabled = true;
    btn.textContent = "En attente de l'hôte…";
    hint.textContent = "";
  } else if (n < 3) {
    btn.disabled = true;
    btn.textContent = `Encore ${3 - n} joueur(s) minimum`;
    hint.textContent = "Il faut entre 3 et 8 joueurs.";
  } else {
    btn.disabled = false;
    btn.textContent = "Lancer la partie";
    hint.textContent = `${n} joueur(s) dans la partie (max 8).`;
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Game start / roles
// ---------------------------------------------------------------------------
let hideEndsAtClient = 0;
let gameEndsAtClient = 0;

socket.on("game-start", ({ role, hideMs, gameMs, self }) => {
  myRole = role;
  iAmAlive = true;
  hideEndsAtClient = Date.now() + hideMs;
  gameEndsAtClient = hideEndsAtClient + gameMs;

  const banner = document.getElementById("role-banner");
  if (role === "killer") {
    banner.textContent = "Tu es le KILLER";
    banner.className = "role-banner killer";
  } else {
    banner.textContent = "Tu es WHITE — reste caché";
    banner.className = "role-banner white";
  }
  showScreen("game");
  initGameWorld(self.x, self.z);
});

socket.on("player-tagged", ({ id }) => {
  if (remotePlayers[id]) remotePlayers[id].taggedFlag = true;
  if (id === selfId) {
    iAmAlive = false;
    document.getElementById("ghost-banner").classList.remove("hidden");
  }
});

let latestState = null;
socket.on("state-update", (state) => {
  latestState = state;
  hideEndsAtClient = state.hideEndsAt || hideEndsAtClient;
  gameEndsAtClient = state.gameEndsAt || gameEndsAtClient;
});

socket.on("game-over", ({ winner, roles }) => {
  showScreen("end");
  const title = document.getElementById("end-title");
  const sub = document.getElementById("end-sub");
  if (winner === "killer") {
    title.textContent = "Le killer a gagné";
    title.style.color = "var(--blood-bright)";
    sub.textContent = "Tous les White ont été éliminés.";
  } else {
    title.textContent = "Les White ont gagné";
    title.style.color = "var(--ghost)";
    sub.textContent = "Ils ont survécu jusqu'à la fin du chrono.";
  }
  const list = document.getElementById("end-roles");
  list.innerHTML = "";
  const namesById = {};
  if (latestState) latestState.players.forEach((p) => (namesById[p.id] = p.name));
  Object.entries(roles).forEach(([id, role]) => {
    const li = document.createElement("li");
    const name = namesById[id] || id.slice(0, 5);
    li.innerHTML = `<span>${escapeHtml(name)}</span><span class="tag ${role === "killer" ? "role-killer" : "role-white"}">${role === "killer" ? "Killer" : "White"}</span>`;
    list.appendChild(li);
  });
});

// ---------------------------------------------------------------------------
// Three.js world
// ---------------------------------------------------------------------------
let renderer, scene, camera;
let selfMesh, selfObj;
const remotePlayers = {}; // id -> { mesh, targetX, targetZ, targetRotY, taggedFlag }
let obstacles = []; // {minX,maxX,minZ,maxZ}
let raycastTargets = []; // meshes used to find ground height under the player (gravity)
const ARENA_HALF_DEFAULT = 26;
let ARENA_HALF = ARENA_HALF_DEFAULT;
const MAP_MODEL_SCALE = 10; // scale applied to the user-provided map.glb
const modelCache = {};
let usingCustomMap = false;

let loader = null;
let groundRaycaster = null;
let wallRaycaster = null;
const GRAVITY = 22;
const JUMP_SPEED = 46.5; // ~30x the previous jump height (height scales with v^2)
const PLAYER_VISUAL_SCALE = 0.2; // players rendered 5x smaller
const COLLIDE_RADIUS = 0.6 * PLAYER_VISUAL_SCALE;
const keys = { forward: false, back: false, left: false, right: false, jump: false };
window.addEventListener("keydown", (e) => setKey(e.code, true));
window.addEventListener("keyup", (e) => setKey(e.code, false));
function setKey(code, val) {
  if (code === "KeyZ" || code === "KeyW" || code === "ArrowUp") keys.forward = val;
  if (code === "KeyS" || code === "ArrowDown") keys.back = val;
  if (code === "KeyQ" || code === "KeyA" || code === "ArrowLeft") keys.left = val;
  if (code === "KeyD" || code === "ArrowRight") keys.right = val;
  if (code === "Space") keys.jump = val;
}

function groundHeightAt(x, z) {
  if (!groundRaycaster || raycastTargets.length === 0) return 0;
  groundRaycaster.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
  groundRaycaster.far = 1000;
  const hits = groundRaycaster.intersectObjects(raycastTargets, false);
  return hits.length ? hits[0].point.y : 0;
}

function loadModel(name) {
  if (modelCache[name]) return modelCache[name];
  const p = new Promise((resolve) => {
    loader.load(
      `models/${name}.glb`,
      (gltf) => resolve(gltf.scene),
      undefined,
      () => resolve(null) // fallback signal
    );
  });
  modelCache[name] = p;
  return p;
}

function fallbackCapsule(color, opacity = 1) {
  const group = new THREE.Group();
  const geo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 8);
  const mat = new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.6 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.9;
  mesh.castShadow = true;
  group.add(mesh);
  // facing indicator
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 8), mat);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.9, 0.45);
  group.add(nose);
  return group;
}

async function buildPlayerMesh(kind) {
  // kind: 'white' | 'red' | 'phantom'
  const modelNameMap = { white: "white", red: "red", phantom: "phantom" };
  const colorMap = { white: 0xe9e7e2, red: 0xb3273f, phantom: 0x8f88a3 };
  const gltfScene = await loadModel(modelNameMap[kind]);
  let obj;
  if (gltfScene) {
    const clone = gltfScene.clone(true);
    if (kind === "phantom") {
      clone.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.45;
        }
      });
    }
    obj = clone;
  } else {
    obj = fallbackCapsule(colorMap[kind], kind === "phantom" ? 0.45 : 1);
  }
  obj.scale.setScalar(PLAYER_VISUAL_SCALE);
  return obj;
}

async function buildMap() {
  const gltfScene = await loadModel("map");
  if (gltfScene) {
    usingCustomMap = true;
    gltfScene.scale.setScalar(MAP_MODEL_SCALE);
    gltfScene.updateMatrixWorld(true);

    // Recenter the model on X/Z and rest it on the ground (y=0), since the
    // model's own pivot/origin may not line up with where players spawn.
    let box = new THREE.Box3().setFromObject(gltfScene);
    const center = new THREE.Vector3();
    box.getCenter(center);
    gltfScene.position.x -= center.x;
    gltfScene.position.z -= center.z;
    gltfScene.position.y -= box.min.y;
    gltfScene.updateMatrixWorld(true);

    // Recompute the box after moving it, then size the play boundary and
    // gravity raycast targets from it.
    box = new THREE.Box3().setFromObject(gltfScene);
    const size = new THREE.Vector3();
    box.getSize(size);
    ARENA_HALF = Math.max(size.x, size.z) / 2 || ARENA_HALF_DEFAULT;

    gltfScene.traverse((o) => {
      if (o.isMesh) raycastTargets.push(o);
    });
    return gltfScene;
  }
  usingCustomMap = false;
  ARENA_HALF = ARENA_HALF_DEFAULT;
  const group = new THREE.Group();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);
  raycastTargets.push(ground);

  const boxMat = new THREE.MeshStandardMaterial({ color: 0x232330, roughness: 0.9 });
  const layout = [
    [-14, -10, 4, 4], [10, -14, 5, 3], [-6, 6, 6, 3], [14, 8, 3, 6],
    [0, 0, 3, 3], [-18, 12, 4, 4], [18, -4, 3, 5], [4, -18, 5, 3],
    [-10, -18, 3, 3], [-4, 18, 6, 3],
  ];
  layout.forEach(([x, z, w, d]) => {
    const h = 2.2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), boxMat);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    obstacles.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    raycastTargets.push(mesh);
  });

  // boundary walls
  const wallH = 3;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c1c24, roughness: 1 });
  const half = ARENA_HALF;
  const wallDefs = [
    [0, -half, half * 2, 0.6], [0, half, half * 2, 0.6],
    [-half, 0, 0.6, half * 2], [half, 0, 0.6, half * 2],
  ];
  wallDefs.forEach(([x, z, w, d]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    mesh.position.set(x, wallH / 2, z);
    group.add(mesh);
    obstacles.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  });

  return group;
}

let worldInitialized = false;
async function initGameWorld(spawnX, spawnZ) {
  if (worldInitialized) return;
  worldInitialized = true;

  await loadEngine();
  loader = new GLTFLoader();

  const canvas = document.getElementById("game-canvas");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xaed4f0);

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 3000);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a9aa8, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.8);
  dir.position.set(30, 60, 20);
  dir.castShadow = true;
  scene.add(dir);
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const moon = new THREE.PointLight(0x8899ff, 0.5, 200);
  moon.position.set(0, 30, 0);
  scene.add(moon);

  const mapObj = await buildMap();
  scene.add(mapObj);

  // Fog and camera reach must match the real map size (only known after buildMap runs).
  scene.fog = new THREE.Fog(0xaed4f0, ARENA_HALF * 0.7, ARENA_HALF * 2.6);
  camera.far = Math.max(600, ARENA_HALF * 4);
  camera.updateProjectionMatrix();
  dir.position.set(ARENA_HALF * 0.4, ARENA_HALF * 0.8, ARENA_HALF * 0.3);

  const selfKind = myRole === "killer" ? "red" : "white";
  selfObj = await buildPlayerMesh(selfKind);
  selfObj.position.set(spawnX, 0, spawnZ);
  scene.add(selfObj);
  selfMesh = { obj: selfObj, x: spawnX, z: spawnZ, y: 0, vy: 0, grounded: true, rotY: 0 };
  groundRaycaster = new THREE.Raycaster();
  wallRaycaster = new THREE.Raycaster();

  window.addEventListener("resize", onResize);
  onResize();
  lastFrameTime = performance.now();
  requestAnimationFrame(animate);
}

function onResize() {
  if (!renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

function circleBoxCollision(x, z, radius) {
  for (const b of obstacles) {
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

function blockedByMapWalls(x, y, z, dirX, dirZ, dist) {
  if (raycastTargets.length === 0) return false;
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return false;
  wallRaycaster.set(new THREE.Vector3(x, y + 0.5 * PLAYER_VISUAL_SCALE, z), new THREE.Vector3(dirX / len, 0, dirZ / len));
  wallRaycaster.far = dist;
  return wallRaycaster.intersectObjects(raycastTargets, false).length > 0;
}

let lastFrameTime = 0;
let lastNetSend = 0;
const BASE_SPEED = 4.2;
const KILLER_MULT = 1.3;
const PHANTOM_MULT = 1.6;

function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min((t - lastFrameTime) / 1000, 0.1);
  lastFrameTime = t;

  updateSelf(dt);
  updateRemotes(dt);
  updateHud();
  updateCamera();

  renderer.render(scene, camera);
}

function currentSpeed() {
  if (!iAmAlive) return BASE_SPEED * PHANTOM_MULT;
  if (myRole === "killer") return BASE_SPEED * KILLER_MULT;
  return BASE_SPEED;
}

function iCanMove() {
  // killer frozen during hide phase
  if (myRole === "killer" && Date.now() < hideEndsAtClient) return false;
  return true;
}

function updateSelf(dt) {
  if (!selfMesh) return;
  const rotSpeed = 2.4;
  if (keys.left) selfMesh.rotY += rotSpeed * dt;
  if (keys.right) selfMesh.rotY -= rotSpeed * dt;

  if (iCanMove()) {
    const dir = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    if (dir !== 0) {
      const speed = currentSpeed();
      const moveX = -Math.sin(selfMesh.rotY) * dir;
      const moveZ = -Math.cos(selfMesh.rotY) * dir;
      const stepDist = speed * dt;
      const nx = selfMesh.x + moveX * stepDist;
      const nz = selfMesh.z + moveZ * stepDist;
      const noclip = !iAmAlive;
      const bounded = Math.abs(nx) < ARENA_HALF - 0.5 && Math.abs(nz) < ARENA_HALF - 0.5;
      if (noclip) {
        if (Math.abs(nx) < ARENA_HALF + 6 && Math.abs(nz) < ARENA_HALF + 6) {
          selfMesh.x = nx;
          selfMesh.z = nz;
        }
      } else {
        const hitsWall = usingCustomMap && blockedByMapWalls(selfMesh.x, selfMesh.y, selfMesh.z, moveX, moveZ, stepDist + COLLIDE_RADIUS);
        const hitsBox = !usingCustomMap && circleBoxCollision(nx, nz, 0.45);
        if (bounded && !hitsWall && !hitsBox) {
          selfMesh.x = nx;
          selfMesh.z = nz;
        }
      }
    }

    // Gravity + jump (phantoms float freely, no gravity for them)
    if (iAmAlive) {
      const groundY = groundHeightAt(selfMesh.x, selfMesh.z);
      if (keys.jump && selfMesh.grounded) {
        selfMesh.vy = JUMP_SPEED;
        selfMesh.grounded = false;
      }
      selfMesh.vy -= GRAVITY * dt;
      selfMesh.y += selfMesh.vy * dt;
      if (selfMesh.y <= groundY) {
        selfMesh.y = groundY;
        selfMesh.vy = 0;
        selfMesh.grounded = true;
      }
    } else {
      selfMesh.y = 0;
    }
  }

  selfObj.position.set(selfMesh.x, selfMesh.y, selfMesh.z);
  selfObj.rotation.y = selfMesh.rotY;

  const now = performance.now();
  if (now - lastNetSend > 90) {
    lastNetSend = now;
    socket.emit("move", { x: selfMesh.x, y: selfMesh.y, z: selfMesh.z, rotY: selfMesh.rotY });
  }
}

async function ensureRemote(id, initialKind) {
  if (remotePlayers[id] || id === selfId) return;
  const placeholder = { obj: null, x: 0, y: 0, z: 0, rotY: 0, kind: null };
  remotePlayers[id] = placeholder;
  const obj = await buildPlayerMesh(initialKind);
  if (remotePlayers[id] === placeholder) {
    placeholder.obj = obj;
    placeholder.kind = initialKind;
    scene.add(obj);
  }
}

async function setRemoteKind(id, kind) {
  const rp = remotePlayers[id];
  if (!rp || rp.kind === kind) return;
  rp.kind = kind;
  const newObj = await buildPlayerMesh(kind);
  if (rp.obj) {
    scene.remove(rp.obj);
  }
  newObj.position.set(rp.x, 0, rp.z);
  newObj.rotation.y = rp.rotY;
  scene.add(newObj);
  rp.obj = newObj;
}

let killerName = null;

function updateRemotes(dt) {
  if (!latestState) return;
  const seen = new Set();
  latestState.players.forEach((p) => {
    if (p.id === selfId) return;
    seen.add(p.id);
    const wantKind = !p.alive ? "phantom" : p.role === "killer" ? "red" : "white";
    if (p.role === "killer") killerName = p.name;
    ensureRemote(p.id, wantKind);
    const rp = remotePlayers[p.id];
    if (!rp) return;
    rp.x = p.x;
    rp.y = p.y || 0;
    rp.z = p.z;
    rp.rotY = p.rotY;
    if (rp.kind !== wantKind) setRemoteKind(p.id, wantKind);
    if (rp.obj) {
      rp.obj.position.lerp(new THREE.Vector3(p.x, rp.y, p.z), Math.min(1, dt * 10));
      rp.obj.rotation.y = p.rotY;
    }
  });
  Object.keys(remotePlayers).forEach((id) => {
    if (!seen.has(id)) {
      const rp = remotePlayers[id];
      if (rp && rp.obj) scene.remove(rp.obj);
      delete remotePlayers[id];
    }
  });
}

function updateCamera() {
  if (!selfObj) return;
  const dist = 6.5, height = 3.4;
  const camX = selfMesh.x + Math.sin(selfMesh.rotY) * dist;
  const camZ = selfMesh.z + Math.cos(selfMesh.rotY) * dist;
  camera.position.lerp(new THREE.Vector3(camX, selfMesh.y + height, camZ), 0.15);
  const lookAt = new THREE.Vector3(selfMesh.x, selfMesh.y + 1.2, selfMesh.z);
  camera.lookAt(lookAt);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function updateHud() {
  const now = Date.now();
  const hideOverlay = document.getElementById("hide-overlay");
  const timerEl = document.getElementById("phase-timer");
  const banner = document.getElementById("role-banner");

  if (myRole === "white" && killerName) {
    banner.textContent = `Tu es WHITE — le killer, c'est ${killerName}`;
  }

  if (myRole === "killer" && now < hideEndsAtClient) {
    hideOverlay.classList.remove("hidden");
    document.getElementById("hide-countdown").textContent = Math.ceil((hideEndsAtClient - now) / 1000);
  } else {
    hideOverlay.classList.add("hidden");
  }

  if (now < hideEndsAtClient) {
    timerEl.textContent = "Préparation";
  } else {
    timerEl.textContent = fmtClock(gameEndsAtClient - now);
  }
}

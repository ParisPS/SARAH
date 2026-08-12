// Visualização holográfica central (Fase 4 parte 3, refeita na parte
// 3.5 pra seguir a referência visual enviada pelo usuário: esfera
// geodésica de NÓS conectados por linhas finas, com um núcleo
// brilhante no centro — não um wireframe sólido genérico). Three.js
// importado direto do build ESM instalado (sem bundler, ver
// `renderer.js`).
import * as THREE from "../node_modules/three/build/three.module.js";

const COLOR_NODE = 0x5fa8f5; // azul médio — os pontos da malha
const COLOR_NODE_THINKING = 0x8fc6ff; // azul mais vivo, só no estado "pensando"
const COLOR_EDGE = 0x2f5a94; // azul escuro/acinzentado — as linhas, mais discretas que os nós
const COLOR_CORE = 0xeaf4ff; // quase branco — o ponto de luz central

/**
 * Textura de um ponto circular suave (gradiente radial, branco →
 * transparente) gerada em canvas, reusada pros nós E pro núcleo
 * central (cores diferentes via `material.color`, blending aditivo)
 * — é isso que dá o efeito "brilho", não geometria 3D de verdade
 * (mais barato, mesma leitura visual da referência).
 */
function createDotTexture(size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ setState: (state: "idle" | "thinking") => void, setAudioLevel: (level: number) => void, dispose: () => void }}
 */
export function createHologram(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 4.4);

  const group = new THREE.Group();
  scene.add(group);

  const dotTexture = createDotTexture();

  // Esfera geodésica: detail=2 dá ~162 vértices — próximo da
  // densidade da referência, ainda trivial pra GPU (bem abaixo de mil
  // vértices). A MESMA geometria alimenta os nós (pontos) e as
  // arestas (linhas) — um único objeto de dados, duas representações.
  const sphereGeometry = new THREE.IcosahedronGeometry(1.3, 2);

  // Arestas: `EdgesGeometry` evita desenhar as diagonais internas dos
  // triângulos (que `WireframeGeometry` incluiria), ficando mais
  // parecido com uma malha geodésica limpa como a referência.
  const edgesGeometry = new THREE.EdgesGeometry(sphereGeometry);
  const edgesMaterial = new THREE.LineBasicMaterial({ color: COLOR_EDGE, transparent: true, opacity: 0.55 });
  const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
  group.add(edges);

  // Nós: um `Points` por vértice da mesma geometria — usa a textura
  // de ponto suave, com leve variação de tamanho por vértice (dá
  // profundidade/organicidade, evita o visual "grade perfeita").
  const nodePositions = sphereGeometry.getAttribute("position");
  const nodeSizes = new Float32Array(nodePositions.count);
  for (let i = 0; i < nodePositions.count; i++) {
    nodeSizes[i] = 0.06 + Math.random() * 0.03;
  }
  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute("position", nodePositions.clone());
  const nodeMaterial = new THREE.PointsMaterial({
    color: COLOR_NODE,
    map: dotTexture,
    size: 0.09,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const nodes = new THREE.Points(nodeGeometry, nodeMaterial);
  group.add(nodes);

  // Núcleo: um sprite brilhante no centro, SEM teste de profundidade
  // (fica sempre visível por cima da malha, como na referência) —
  // não é luz de verdade, é um ponto aditivo simples.
  const coreMaterial = new THREE.SpriteMaterial({
    map: dotTexture,
    color: COLOR_CORE,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  const core = new THREE.Sprite(coreMaterial);
  core.scale.setScalar(0.55);
  core.renderOrder = 10;
  scene.add(core);

  // --- estado da animação ---------------------------------------
  let targetEnergy = 0;
  let energy = 0;
  let audioLevel = 0;
  const timer = new THREE.Timer(); // THREE.Clock está deprecated nesta versão
  let disposed = false;

  // Checagem de performance (Fase 4 parte 3) — reporta o FPS medido
  // de verdade UMA VEZ, ~3s depois de começar a animar, via
  // console.log (encaminhado pro terminal do processo principal em
  // main-process.ts, ver `webContents.on("console-message", ...)`) —
  // sem isso não haveria como validar performance nesta máquina
  // (sem permissão de Gravação de Tela). Não repete depois do
  // primeiro report, pra não poluir o console.
  let frameCount = 0;
  let fpsReported = false;
  const perfStart = performance.now();

  function resize() {
    const { clientWidth, clientHeight } = canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  function animate() {
    if (disposed) return;
    requestAnimationFrame(animate);

    timer.update();
    const dt = timer.getDelta();
    const t = timer.getElapsed();

    // Suaviza a transição idle <-> thinking (metade do caminho a cada
    // ~0.3s, independente do frame rate).
    energy += (targetEnergy - energy) * Math.min(1, dt / 0.3);
    const boost = energy + audioLevel * 0.6;

    // Rotação: sempre gira, mais rápido quanto mais "energia".
    group.rotation.y += dt * (0.12 + boost * 0.7);
    group.rotation.x = Math.sin(t * 0.25) * 0.12 + boost * Math.sin(t * 2) * 0.06;

    // Pulso de escala ("respiração") — mais pronunciado pensando.
    const pulse = 1 + Math.sin(t * (1 + boost * 2.5)) * (0.025 + boost * 0.05);
    group.scale.setScalar(pulse);

    // Cor dos nós desliza pro tom mais vivo quando "pensando".
    nodeMaterial.color.lerpColors(new THREE.Color(COLOR_NODE), new THREE.Color(COLOR_NODE_THINKING), boost);

    // Núcleo: pulsa mais forte e cresce um pouco com energia/áudio —
    // é o parâmetro mais natural pra reagir a nível de áudio no
    // futuro (um "flash" a cada pico de volume do TTS).
    const coreScale = 0.5 + Math.sin(t * (2 + boost * 4)) * (0.05 + boost * 0.12) + boost * 0.15;
    core.scale.setScalar(coreScale);

    renderer.render(scene, camera);

    frameCount++;
    if (!fpsReported && performance.now() - perfStart > 3000) {
      fpsReported = true;
      const fps = (frameCount / (performance.now() - perfStart)) * 1000;
      console.log(`[hologram] fps média nos primeiros ~3s: ${fps.toFixed(1)}`);
    }
  }
  requestAnimationFrame(animate);

  return {
    setState(state) {
      targetEnergy = state === "thinking" ? 1 : 0;
    },
    setAudioLevel(level) {
      // Gancho pro futuro (voz/TTS) — clamp defensivo, nunca deixa um
      // valor fora de [0,1] explodir a animação.
      audioLevel = Math.max(0, Math.min(1, level));
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      sphereGeometry.dispose();
      edgesGeometry.dispose();
      edgesMaterial.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      coreMaterial.dispose();
      dotTexture.dispose();
      renderer.dispose();
    },
  };
}

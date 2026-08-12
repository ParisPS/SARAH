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
 * @param {{ onTaskStart?: (category: string) => void, onTaskEnd?: (category: string) => void }} [callbacks]
 *   Chamados quando a fila de animações de tarefa (ver `playTask`)
 *   troca de item — `renderer.js` usa isso pra sincronizar o overlay
 *   2D (`#core-task`) com a reação do núcleo 3D feita aqui dentro.
 *   Categorias sem overlay (ex.: `"memory"`) simplesmente não têm
 *   glifo associado do lado do renderer — o núcleo reage sozinho.
 * @returns {{ setState: (state: "idle" | "thinking") => void, setAudioLevel: (level: number) => void, playTask: (category: string) => void, dispose: () => void }}
 */
export function createHologram(canvas, callbacks = {}) {
  const { onTaskStart, onTaskEnd } = callbacks;
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
  const nodeCount = nodePositions.count;
  const nodeSizes = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
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

  // Halo do núcleo (Fase 4 parte 4): fica INVISÍVEL em repouso
  // (`opacity: 0`) — só aparece enquanto uma animação de tarefa está
  // tocando (ver `playTask()`/fila abaixo), como um brilho extra que
  // cresce ao redor do núcleo já existente. Reusa a mesma textura de
  // ponto, atrás do núcleo (`renderOrder` menor) pra não tapar o
  // ponto de luz central.
  const coreGlowMaterial = new THREE.SpriteMaterial({
    map: dotTexture,
    color: COLOR_CORE,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  const coreGlow = new THREE.Sprite(coreGlowMaterial);
  coreGlow.scale.setScalar(0.55);
  coreGlow.renderOrder = 9;
  scene.add(coreGlow);

  // --- estado da animação ---------------------------------------
  let targetEnergy = 0;
  let energy = 0;
  let audioLevel = 0;
  const timer = new THREE.Timer(); // THREE.Clock está deprecated nesta versão
  let disposed = false;

  // Fila de animações de TAREFA (Fase 4 parte 4, corrigido de novo por
  // pedido do usuário: a versão anterior só cobria `memory.remember`,
  // piscando o núcleo; agora TODA categoria — envio de e-mail,
  // criação de nota/lembrete, criação de evento, memória — passa por
  // esta mesma fila e reage no núcleo). `currentTask` guarda
  // `{ category, start }` (start em segundos decorridos do `timer`)
  // ou `null` se nada está tocando. `playTask()` só empurra pra
  // `taskQueue`; `dequeueNextTask()` (chamado no topo de cada frame)
  // é o único lugar que promove o próximo item — garante que duas
  // tarefas NUNCA tocam sobrepostas, mesmo se `playTask()` for
  // chamado várias vezes em sequência rápida (ex.: duas tools na
  // mesma resposta). `onTaskStart`/`onTaskEnd` avisam `renderer.js`
  // pra sincronizar o overlay 2D com a janela exata em que o núcleo
  // está "reagindo" a essa tarefa.
  const taskQueue = [];
  let currentTask = null;
  const TASK_DURATION = 3; // segundos — pedido explícito do usuário
  let currentElapsed = 0;

  function dequeueNextTask() {
    if (currentTask === null && taskQueue.length > 0) {
      const category = taskQueue.shift();
      currentTask = { category, start: currentElapsed };
      onTaskStart?.(category);
    }
  }

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
    currentElapsed = t;

    dequeueNextTask();

    // Fator da tarefa atual (0 = repouso, 1 = pico logo no início,
    // decaindo linearmente até 0 em `TASK_DURATION`) — vale pra
    // QUALQUER categoria enfileirada via `playTask()`, não só
    // `memory.remember`. Quando termina, avisa `renderer.js`
    // (`onTaskEnd`) e libera a vaga; a próxima da fila só entra no
    // frame seguinte (`dequeueNextTask()` no topo do próximo
    // `animate()`), gap de ~16ms, imperceptível.
    let taskFactor = 0;
    if (currentTask !== null) {
      const age = t - currentTask.start;
      if (age < TASK_DURATION) {
        taskFactor = 1 - age / TASK_DURATION;
      } else {
        const finished = currentTask.category;
        currentTask = null;
        onTaskEnd?.(finished);
      }
    }

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
    // futuro (um "flash" a cada pico de volume do TTS). Uma tarefa
    // ativa soma um crescimento extra por cima disso — é isso que faz
    // o núcleo genuinamente "se transformar" reagindo a QUALQUER
    // categoria de tarefa, não só ganhar um ícone flutuando na frente
    // dele (o glifo 2D de `renderer.js`/`index.html`, quando existe
    // pra essa categoria, fica sincronizado com esta mesma janela via
    // `onTaskStart`/`onTaskEnd`).
    const coreScale = 0.5 + Math.sin(t * (2 + boost * 4)) * (0.05 + boost * 0.12) + boost * 0.15 + taskFactor * 0.35;
    core.scale.setScalar(coreScale);

    // Halo do núcleo: invisível em repouso, aparece e cresce durante
    // qualquer tarefa ativa — é o que lê visualmente como "aumento de
    // brilho" (blending aditivo: uma área maior de luz sobre o fundo
    // escuro), sem competir com o pulso idle/thinking do núcleo em si.
    coreGlowMaterial.opacity = taskFactor * 0.85;
    coreGlow.scale.setScalar(coreScale + taskFactor * 1.6);

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
    /**
     * Enfileira uma animação de tarefa pro núcleo central — toca por
     * `TASK_DURATION` (~3s) assim que chegar a vez dela na fila
     * (`dequeueNextTask()`), e SÓ ENTÃO a próxima começa (nunca
     * sobrepostas, mesmo chamando `playTask()` várias vezes seguidas).
     * `category` é uma string livre; `renderer.js` decide, via
     * `onTaskStart`, se existe um glifo 2D pra ela (`"memory"`, por
     * exemplo, não tem — só a reação do núcleo em si já é a resposta
     * visual).
     */
    playTask(category) {
      taskQueue.push(category);
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
      coreGlowMaterial.dispose();
      dotTexture.dispose();
      renderer.dispose();
    },
  };
}

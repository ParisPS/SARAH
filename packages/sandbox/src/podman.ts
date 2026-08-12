import { spawn } from "node:child_process";

/**
 * Wrapper fino em volta do binário `podman` via `child_process` — mesmo
 * espírito de "chamar um binário do sistema e tratar stdout/stderr" já
 * usado nos bridges JXA (Apple Calendar/Reminders/Notes) e no Keychain
 * (Gmail). Nenhuma lib de cliente Docker/Podman — o CLI já cobre tudo
 * que a Fase 5 precisa, e evita mais uma dependência nativa (lembrar da
 * dor do better-sqlite3 na Fase 4).
 *
 * Runtime decidido na Fase 5 parte 1 (ver docs/architecture.md): Docker
 * não existe nesta máquina; `podman` estava instalado mas sem VM
 * inicializada — usuário escolheu inicializar a VM do podman em vez de
 * instalar Docker Desktop/OrbStack/Colima. Tudo aqui assume o binário
 * `podman` no PATH com uma máquina rodando (`podman machine start`).
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

export function podman(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult> {
  return run("podman", args, opts);
}

/**
 * Confirma que o runtime está disponível de verdade (binário no PATH +
 * máquina rodando) — chamado uma vez na inicialização da sessão, não
 * assumido. Mesma cautela documentada na Fase 5 parte 1: uma ferramenta
 * pode "existir" e ainda assim não funcionar (Xcode CLT na Fase 1,
 * podman sem VM inicializada nesta própria fase).
 */
export async function checkPodmanAvailable(): Promise<{ available: boolean; detail: string }> {
  const version = await podman(["version", "--format", "{{.Client.Version}}"], { timeoutMs: 5000 });
  if (version.code !== 0) {
    return { available: false, detail: "Binário `podman` não encontrado ou não responde. Rode `podman machine start` (ou instale o runtime)." };
  }
  const info = await podman(["info", "--format", "{{.Host.Arch}}"], { timeoutMs: 5000 });
  if (info.code !== 0) {
    return {
      available: false,
      detail: "`podman` está instalado, mas não consegue falar com a VM. Rode `podman machine start`.",
    };
  }
  return { available: true, detail: `podman ${version.stdout.trim()}` };
}

/**
 * Rede dedicada dos containers de projeto — separada da rede "podman"
 * default de propósito, pra escopar a regra de firewall (ver
 * `applyLanFirewall`) só ao tráfego da SARAH, sem afetar qualquer outro
 * uso de podman que o usuário já tenha nesta máquina. Subnet fixa
 * (10.89.0.0/16) pra a regra de firewall poder liberar exatamente essa
 * faixa (necessária pro próprio DNS/gateway do sandbox) sem precisar
 * redescobrir o valor toda vez.
 */
export const SANDBOX_NETWORK = "sarah-sandbox";
export const SANDBOX_SUBNET = "10.89.0.0/16";

/** Idempotente — cria a rede só se ainda não existir. */
export async function ensureSandboxNetwork(): Promise<void> {
  const inspect = await podman(["network", "inspect", SANDBOX_NETWORK]);
  if (inspect.code === 0) return;

  const create = await podman(["network", "create", SANDBOX_NETWORK, "--subnet", SANDBOX_SUBNET]);
  if (create.code !== 0) {
    throw new Error(`Falha ao criar a rede do sandbox (${SANDBOX_NETWORK}): ${create.stderr.trim()}`);
  }
}

/**
 * Bloqueio de rede local — a parte mais delicada da fundação (ver
 * "Achado real" em docs/architecture.md pro caminho até chegar aqui).
 *
 * O que NÃO funcionou, testado e descartado antes desta versão:
 * `--network none` bloqueia tudo (inclusive internet, inviabilizando
 * `npm install`/`git push`); uma regra `nft` no namespace de rede
 * RAIZ da VM (`podman machine ssh` sem `nsenter`) não tem efeito
 * nenhum, porque o podman roda em modo rootless nesta VM — o tráfego
 * do container passa por um namespace de rede PRÓPRIO por container
 * (gerenciado por `pasta`), não pelo namespace raiz da VM que
 * `podman machine ssh` acessa por padrão.
 *
 * O que funciona (validado de verdade, incluindo confirmar que o
 * PRÓPRIO container não consegue desfazer a regra — ver
 * docs/architecture.md): usar `nsenter -t <PID> -n` a partir da VM
 * (privilégio que só existe do lado de fora do container) pra entrar
 * no namespace de rede DAQUELE container específico, e aplicar ali uma
 * regra `nft` na cadeia OUTPUT: libera o tráfego pra própria subnet do
 * sandbox (necessário pro DNS/gateway) e derruba qualquer destino
 * RFC1918/link-local (a LAN de verdade) — internet continua liberada
 * (policy default da cadeia é `accept`, só os destinos privados têm
 * regra `drop` explícita). Como o container nunca recebe
 * `--cap-add=NET_ADMIN`, ele não tem `CAP_NET_ADMIN` nem no conjunto
 * "bounding" (confirmado inspecionando `/proc/self/status` de dentro
 * do container) — mesmo instalando o pacote `nftables` via `apk` (rede
 * de internet funciona, isso não é bloqueado), rodar `nft flush
 * ruleset` de dentro do container falha com "Operation not permitted".
 * A garantia não depende de o container "se comportar" — o kernel
 * recusa a chamada.
 */
const BLOCKED_LAN_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

export async function applyLanFirewall(pid: string): Promise<void> {
  const rules = [
    "sudo nsenter -t $PID -n nft add table inet fw",
    "sudo nsenter -t $PID -n nft 'add chain inet fw output { type filter hook output priority 0 ; }'",
    `sudo nsenter -t $PID -n nft add rule inet fw output ip daddr ${SANDBOX_SUBNET} accept`,
    ...BLOCKED_LAN_RANGES.map((range) => `sudo nsenter -t $PID -n nft add rule inet fw output ip daddr ${range} drop`),
  ];
  const script = `PID=${pid}\n${rules.join("\n")}\n`;

  const result = await podman(["machine", "ssh", "--", script], { timeoutMs: 15000 });
  if (result.code !== 0) {
    throw new Error(`Falha ao aplicar o firewall de rede (bloqueio de LAN) no container: ${result.stderr.trim()}`);
  }
}

const IMAGE = "docker.io/library/node:20-alpine";
export const CONTAINER_PREFIX = "sarah-proj-";
const MEMORY_LIMIT = "1g";
const CPU_LIMIT = "2";
export const PREVIEW_CONTAINER_PORT = 3000;

export interface ProjectContainer {
  name: string;
  pid: string;
  previewHostPort: number;
}

/**
 * Cria (ou recria, se um container órfão com o mesmo nome sobrou de
 * uma execução anterior — mesma lição de processos zumbis já registrada
 * na Fase 4) o container de UM projeto: só a pasta `hostDir` montada
 * como `/workspace` (nada mais do Mac), rede dedicada (ver
 * `applyLanFirewall`), limites de CPU/memória reais, e uma porta
 * (3000 dentro do container) publicada só em `127.0.0.1` do Mac —
 * nunca em `0.0.0.0` — pro `code.preview` mais tarde. `--rm` garante
 * que parar o container também remove ele, sem resíduo.
 */
export async function createProjectContainer(slug: string, hostDir: string): Promise<ProjectContainer> {
  await ensureSandboxNetwork();
  const name = CONTAINER_PREFIX + slug;

  // Achado real testando com mais de um processo ao mesmo tempo (ver
  // `isOwnerAlive`/`cleanupOrphanedContainers` abaixo pra explicação
  // completa): um container com esse nome já pode existir e pertencer
  // a OUTRO processo da SARAH ainda vivo (ex.: `apps/cli` e
  // `apps/menubar` rodando ao mesmo tempo, o que o projeto suporta de
  // propósito). Só remove se o dono não estiver mais vivo — nunca
  // derruba um container que outra sessão ainda está usando.
  const existing = await podman(["inspect", name, "--format", "{{.Config.Labels}}"]);
  if (existing.code === 0) {
    if (await isOwnerAlive(name)) {
      throw new Error(
        `O projeto "${slug}" já está aberto em outra sessão/janela da SARAH ainda em execução. ` +
          `Feche-a lá antes de abrir este projeto aqui.`
      );
    }
    await podman(["rm", "-f", name]);
  }

  const runResult = await podman([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `sarah.owner-pid=${process.pid}`,
    // A VM (Fedora CoreOS) roda SELinux em modo enforcing
    // (`getenforce` = Enforcing) — sem tratar isso, o mount funciona
    // mas o container recebe "Permission denied" só de tentar LER
    // `/workspace` (SELinux barra o acesso por contexto, não é o mount
    // em si que falha). A opção óbvia (`:Z` no volume, relabeling
    // automático) NÃO funciona de verdade aqui: testado e confirmado
    // que falha com `lsetxattr ... permission denied` ao tentar
    // recriar o container de um projeto que já tem objetos git
    // gravados (git escreve objetos como somente-leitura, modo 0444 —
    // comportamento normal — e a relabeling do `:Z` precisa de
    // permissão de ESCRITA no arquivo pra setar o xattr de SELinux,
    // que um arquivo 0444 não tem nem pro próprio dono). Ou seja:
    // `:Z` até funciona na primeira vez que um projeto é criado, mas
    // QUEBRA ao reabrir qualquer projeto que já tenha um commit —
    // inaceitável pra uma ferramenta cujo propósito é justamente git.
    // Resolvido com `--security-opt label=disable`: desliga a
    // aplicação de SELinux especificamente pra ESTE container, sem
    // tocar nas outras garantias de isolamento (rede, filesystem só a
    // pasta montada, capacidades, limites de recurso) — todas
    // validadas à parte e continuam intactas. SELinux aqui protegeria
    // contra um container malicioso mexendo em OUTROS containers/
    // processos da mesma VM — não é o modelo de ameaça relevante numa
    // VM de uso único, dedicada só aos sandboxes da própria SARAH.
    "--security-opt",
    "label=disable",
    "--network",
    SANDBOX_NETWORK,
    "-v",
    `${hostDir}:/workspace`,
    "-w",
    "/workspace",
    "--memory",
    MEMORY_LIMIT,
    "--cpus",
    CPU_LIMIT,
    "-p",
    `127.0.0.1::${PREVIEW_CONTAINER_PORT}`,
    IMAGE,
    "sleep",
    "infinity",
  ]);
  if (runResult.code !== 0) {
    throw new Error(`Falha ao criar o container do projeto "${slug}": ${runResult.stderr.trim()}`);
  }

  const pidResult = await podman(["inspect", name, "--format", "{{.State.Pid}}"]);
  const pid = pidResult.stdout.trim();
  if (pidResult.code !== 0 || !pid || pid === "0") {
    throw new Error(`Container "${name}" criado, mas não consegui achar o PID dele pra aplicar o firewall.`);
  }

  await applyLanFirewall(pid);

  // node:alpine não traz git/ssh nem conversão SVG→raster por padrão —
  // instala tudo de uma vez na criação do container (não a cada
  // comando). `rsvg-convert` (Fase 5 parte 4, gráficos) NÃO vem junto
  // do pacote `librsvg` no Alpine — é um pacote separado, confirmado
  // testando (`apk search rsvg` lista os dois como pacotes distintos).
  // `imagemagick` sozinho também NÃO tem suporte a JPEG de verdade
  // (testado: `magick ... saida.jpg` escrevia dados PNG com extensão
  // .jpg, e forçar o formato falhava com "no decode delegate") — o
  // pacote `imagemagick-jpeg` é o delegate que falta, confirmado
  // testando que só com ele o JPEG gerado tem os magic bytes certos
  // (`ffd8ff...`) e `magick identify` reconhece como JPEG de verdade.
  // Terceiro achado, o mais sutil: `rsvg-convert` NÃO falha e NÃO
  // avisa nada quando o SVG tem `<text>` — ele simplesmente renderiza
  // o texto como INVISÍVEL, porque a imagem base não tem NENHUMA fonte
  // instalada (`fc-list` vazio, `fc-match sans` sem devolver nada).
  // Só descoberto abrindo o PNG resultante de verdade (não só
  // conferindo os magic bytes) — um círculo azul perfeito, sem a letra
  // que devia estar no meio. `ttf-dejavu` (fonte comum, licença
  // permissiva, boa cobertura) resolve — reconfirmado depois: o mesmo
  // SVG passa a renderizar o texto certinho.
  await podman(
    [
      "exec",
      name,
      "sh",
      "-c",
      "apk add --no-cache git openssh-client rsvg-convert imagemagick imagemagick-jpeg ttf-dejavu >/dev/null 2>&1",
    ],
    { timeoutMs: 45000 }
  );

  const portResult = await podman(["port", name, String(PREVIEW_CONTAINER_PORT)]);
  const portMatch = portResult.stdout.trim().match(/:(\d+)\s*$/);
  const previewHostPort = portMatch ? Number(portMatch[1]) : 0;

  return { name, pid, previewHostPort };
}

export async function stopProjectContainer(name: string): Promise<void> {
  await podman(["stop", "-t", "5", name]);
}

/**
 * `true` se o processo que CRIOU esse container (gravado no label
 * `sarah.owner-pid` na hora do `podman run`, ver `createProjectContainer`)
 * ainda está vivo. `process.kill(pid, 0)` não manda sinal nenhum — só
 * pergunta ao kernel se o PID existe (lança ESRCH se não existir),
 * mesmo truque padrão do Node pra checar liveness sem afetar o
 * processo checado.
 */
async function isOwnerAlive(containerName: string): Promise<boolean> {
  const labelResult = await podman(["inspect", containerName, "--format", "{{index .Config.Labels \"sarah.owner-pid\"}}"]);
  const pidStr = labelResult.stdout.trim();
  if (labelResult.code !== 0 || !pidStr) return false; // sem label (container de uma versão anterior) = trata como órfão
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH — processo não existe mais
  }
}

/**
 * Limpeza de containers de projeto órfãos DE VERDADE — achado real
 * testando com mais de um processo Node ao mesmo tempo (mesma classe
 * de lição já registrada na Fase 4 sobre processos zumbis, mas aqui
 * automatizada, não manual): a primeira versão desta função apagava
 * QUALQUER container `sarah-proj-*` encontrado na inicialização, sem
 * checar se ele ainda pertencia a um processo VIVO — o que derrubava
 * containers de OUTRA sessão da SARAH ainda em uso (ex.: `apps/cli` e
 * `apps/menubar` abertos ao mesmo tempo, suportado de propósito desde
 * a Fase 4). Corrigido: só remove um container se o processo dono
 * (`sarah.owner-pid`) não existir mais — nunca um que outra sessão
 * ainda está usando.
 */
export async function cleanupOrphanedContainers(): Promise<void> {
  const list = await podman(["ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}"]);
  if (list.code !== 0) return;
  const names = list.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!(await isOwnerAlive(name))) {
      await podman(["rm", "-f", name]);
    }
  }
}

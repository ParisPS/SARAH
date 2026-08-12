import { app, Tray, Menu, BrowserWindow, nativeImage, dialog, ipcMain, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfirmFn } from "@sarah/permissions";
import { spawnSarahDaemon, type SarahDaemon } from "./sarah-daemon.js";

/**
 * `apps/menubar` — segunda interface da SARAH (Fase 4, parte 2), lado
 * a lado com `apps/cli`, sem substituí-lo. Reaproveita EXATAMENTE o
 * mesmo `@sarah/core` (Gateway, audit log, memória, tools MCP,
 * `resume` de sessão) — a única coisa nova aqui é COMO o pedido chega
 * (IPC de uma janela, em vez de `readline` de um terminal) e COMO a
 * confirmação de alto risco é mostrada (dialog nativo do Electron, em
 * vez de "(s/n)" no stdout). Ver `ConfirmFn`/`createSarahSession` em
 * @sarah/permissions e @sarah/core pro porquê disso ser só encaixar
 * uma peça nova, sem duplicar lógica nenhuma.
 *
 * Achado da Fase 4 parte 1, resolvido aqui: `ELECTRON_RUN_AS_NODE=1`
 * já vem setado no shell deste ambiente — com essa variável presente,
 * QUALQUER binário Electron invocado roda só como Node puro, nunca
 * abre GUI nenhuma. Corrigido no `package.json` (`"dev": "env -u
 * ELECTRON_RUN_AS_NODE electron ."`) — o processo que LANÇA o
 * Electron precisa limpar essa variável antes de invocar o binário;
 * não dá pra corrigir de dentro deste arquivo, porque o bootstrap
 * nativo do Electron já checa essa variável antes de qualquer linha
 * de JavaScript nosso rodar.
 *
 * Segunda parede real desta fase, resolvida via `sarah-daemon.ts`/
 * `daemon.ts`: `@sarah/core` não é chamado DIRETO neste processo.
 * `better-sqlite3` (usado por @sarah/audit e @sarah/memory) é um
 * módulo nativo com ABI travada a uma versão exata do Node
 * (NODE_MODULE_VERSION) — o binário pré-compilado que já temos é da
 * ABI do Node do sistema (127), e o Node EMBUTIDO no Electron 43 usa
 * outra ABI (148), sem prebuilt publicado pra essa versão (conferido
 * nos releases do pacote no GitHub, não assumido). Rodar
 * `@sarah/core` inteiro dentro do processo do Electron quebraria
 * nesse `require`. Solução: `@sarah/core` roda num processo FILHO
 * separado, com o Node normal do sistema (via `tsx`, mesmo mecanismo
 * que já roda `apps/cli`) — o processo principal do Electron só fala
 * JSON Lines por stdio com ele (`sarah-daemon.ts`). Isso resolve não
 * só o SQLite, mas qualquer módulo nativo futuro que a mesma
 * restrição de ABI afetasse.
 *
 * FASE 4, PARTE 3 (polimento visual + features, ver
 * docs/architecture.md pra decisão detalhada de cada item):
 * visualização holográfica central (Three.js, `renderer/hologram.js`)
 * substituindo qualquer indicador de texto tipo "digitando..."; selo
 * de tool+risco sob cada resposta (o protocolo do daemon passou a
 * carregar `tools: {toolName, risk}[]` por turno, ver `ask()` em
 * @sarah/core); painel de histórico numa janela separada
 * (`openHistoryWindow`, `renderer/history.html`, aberto pelo menu de
 * contexto do ícone); bolhas de conversa com identidade visual
 * própria (paleta azul consistente com o holograma). Nada disso mudou
 * o Gateway/audit log/memória/`apps/cli` — só a camada visual/UX.
 */

// Este processo (o do Electron) não precisa carregar `.env` — quem usa
// as credenciais (Notion/Google) é o processo filho `daemon.ts`, que
// carrega o seu próprio (mesmo padrão de `apps/cli/src/main.ts`).

// Tray/janela/daemon em escopo de MÓDULO, não dentro de uma função —
// bug real de Electron encontrado testando o esqueleto mínimo desta
// fase: um `Tray`/`BrowserWindow` guardado só numa variável LOCAL de
// callback pode ser coletado pelo garbage collector do V8 assim que a
// função termina (o ícone starts existindo e depois some sozinho, ou
// o processo inteiro sai). Guardar em `let` no topo do módulo mantém
// uma referência viva pelo tempo de vida do processo.
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let historyWin: BrowserWindow | null = null;
let daemon: SarahDaemon | null = null;
let isQuitting = false;

/**
 * Ícone de Tray gerado em código (um círculo preto simples, 18x18,
 * com alpha) em vez de um arquivo de imagem — suficiente pra validar
 * a FUNÇÃO do Tray nesta parte da Fase 4; um ícone desenhado de
 * verdade é polimento visual, não faz parte do escopo aqui.
 * `setTemplateImage(true)` é o que faz o macOS inverter as cores
 * automaticamente conforme o tema (claro/escuro) da barra de menu,
 * como qualquer ícone nativo de menu bar.
 */
function buildTrayIcon() {
  const size = 18;
  const buffer = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const inside = dx * dx + dy * dy <= r * r;
      const i = (y * size + x) * 4;
      // BGRA — formato esperado por `createFromBitmap` no macOS.
      buffer[i] = 0;
      buffer[i + 1] = 0;
      buffer[i + 2] = 0;
      buffer[i + 3] = inside ? 255 : 0;
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
  image.setTemplateImage(true);
  return image;
}

/**
 * `ConfirmFn` (ver @sarah/permissions) pra esta interface: dialog
 * nativo do Electron em vez de "(s/n)" no terminal, com a MESMA
 * informação que o terminal já mostra — nome da tool + preview (ou o
 * JSON cru do input, quando não há `formatConfirmationInput` pra essa
 * tool). Botões: "Cancelar" (padrão/cancelId, pra Esc/Enter acidental
 * nunca confirmar sozinho) e "Confirmar".
 */
const confirmViaDialog: ConfirmFn = async (toolName, toolInput, preview) => {
  const detail = preview ?? `Entrada: ${JSON.stringify(toolInput)}`;
  const result = await dialog.showMessageBox({
    type: "warning",
    message: `Ação de ALTO RISCO solicitada: ${toolName}`,
    detail,
    buttons: ["Cancelar", "Confirmar"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
};

// Fase 4 parte 3.5: janela cresceu de 380x480 (só chat) pra caber o
// dashboard (holograma maior + 4 painéis) sem espremer a conversa.
const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 760;

function createWindow(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    resizable: true,
    fullscreenable: false,
    title: "SARAH",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(dirname(fileURLToPath(import.meta.url)), "..", "renderer", "index.html"));

  // Encaminha o console do renderer (DevTools) pro terminal deste
  // processo — sem isso não haveria como validar nada visual/gráfico
  // nesta máquina (sem permissão de Gravação de Tela pra screenshot).
  // Usado agora pra ler o report de FPS do holograma (ver
  // renderer/hologram.js); inofensivo deixar ligado depois também,
  // serve de log de erro do renderer em geral.
  win.webContents.on("console-message", (event) => {
    console.log(`[renderer] ${event.message}`);
  });

  win.once("ready-to-show", () => {
    positionWindowNearTray();
    showAndFocusWindow();
  });

  // Fechar a janela (botão vermelho) só ESCONDE — comportamento
  // padrão de app de menu bar, o app continua rodando (Tray de pé).
  // Sair de verdade é só pelo menu de contexto (botão direito no
  // Tray) ou Cmd+Q, que setam `isQuitting` antes.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });
}

/**
 * A janela cresceu bastante na parte 3.5 (760px de largura) — o
 * cálculo antigo (centralizar embaixo do ícone) podia jogar boa parte
 * dela pra fora da tela quando o ícone está perto da borda direita
 * (bem comum: a barra de menu do macOS fica cheia de ícones do lado
 * direito). Alinha a borda direita da janela com a borda direita do
 * ícone (convenção comum de painel de menu bar) e depois GRAMPEIA
 * (`clamp`) dentro da área útil da tela (`workArea`, já exclui a
 * própria barra de menu), nos dois eixos — nunca deixa a janela
 * nascer parcialmente fora da tela em nenhum monitor.
 */
function positionWindowNearTray(): void {
  if (!tray || !win) return;
  const trayBounds = tray.getBounds();
  const windowBounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width - windowBounds.width);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  x = Math.min(Math.max(x, areaX), areaX + areaWidth - windowBounds.width);
  y = Math.min(Math.max(y, areaY), areaY + areaHeight - windowBounds.height);

  win.setPosition(x, y, false);
}

/**
 * `app.dock?.hide()` (ver `app.whenReady` abaixo) muda a política de
 * ativação do app pra "accessory" no macOS — apps desse tipo não
 * ganham foco automaticamente do mesmo jeito que um app normal, então
 * só `win.show()`/`win.focus()` às vezes deixa a janela aberta atrás
 * de outra já em foco. `app.focus({ steal: true })` força o app a vir
 * pra frente de verdade — comportamento padrão esperado de um app de
 * menu bar (clicar no ícone sempre traz a janela pro topo).
 */
function showAndFocusWindow(): void {
  if (!win) return;
  win.show();
  app.focus({ steal: true });
  win.focus();
}

function toggleWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    positionWindowNearTray();
    showAndFocusWindow();
  }
}

/**
 * Painel de histórico (item 3 da Fase 4 parte 3) — janela SEPARADA,
 * não um painel lateral dentro da janela principal: a janela
 * principal já é pequena (380px de largura), espremer uma segunda
 * área ali brigaria com o holograma/conversa. Aberta pelo menu de
 * contexto do ícone (botão direito → "Histórico"); os dados vêm do
 * mesmo daemon (`sarah:history`), sem duplicar acesso ao SQLite.
 */
function openHistoryWindow(): void {
  if (historyWin) {
    historyWin.show();
    historyWin.focus();
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  historyWin = new BrowserWindow({
    width: 460,
    height: 420,
    title: "SARAH — Histórico",
    webPreferences: {
      preload: join(here, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  historyWin.webContents.on("console-message", (event) => {
    console.log(`[history-renderer] ${event.message}`);
  });
  historyWin.loadFile(join(here, "..", "renderer", "history.html"));
  historyWin.on("closed", () => {
    historyWin = null;
  });
}

app.whenReady().then(() => {
  // Sem ícone no Dock — é um app de menu bar, o Tray já é a UI.
  app.dock?.hide();

  tray = new Tray(buildTrayIcon());
  tray.setToolTip("SARAH");
  tray.on("click", toggleWindow);
  tray.on("right-click", () => {
    const menu = Menu.buildFromTemplate([
      { label: "Histórico...", click: openHistoryWindow },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray?.popUpContextMenu(menu);
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const tsxBinPath = join(here, "..", "node_modules", ".bin", "tsx");
  const daemonScriptPath = join(here, "daemon.ts");
  daemon = spawnSarahDaemon(tsxBinPath, daemonScriptPath, confirmViaDialog);

  ipcMain.handle("sarah:ask", async (_event, prompt: unknown) => {
    if (!daemon) return { ok: false, error: "Sessão da SARAH ainda não foi iniciada." };
    return daemon.ask(String(prompt));
  });

  ipcMain.handle("sarah:history", async (_event, limit: unknown) => {
    if (!daemon) return [];
    return daemon.history(typeof limit === "number" ? limit : undefined);
  });

  ipcMain.handle("sarah:dashboard", async () => {
    if (!daemon) return null;
    return daemon.dashboard();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  daemon?.stop();
});

// Diferente de um app "normal", um app de menu bar NÃO deve sair
// quando a (única) janela fecha — é esperado continuar rodando só com
// o Tray. Sem este handler, o comportamento padrão do Electron em
// alguma plataformas seria encerrar o processo.
app.on("window-all-closed", () => {
  // de propósito, vazio.
});

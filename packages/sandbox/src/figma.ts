import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { writeFile } from "node:fs/promises";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveProjectFilePath } from "./projects.js";

/**
 * Extração de assets do Figma (Fase 5 parte 6) — SÓ leitura/exportação,
 * nunca escreve de volta no Figma. Objetivo: ler fontes, estilos de
 * cor e imagens/componentes de um arquivo do Figma do usuário, e usar
 * como insumo real (não placeholder) pro código gerado pelas tools
 * `code.*` da Fase 5 parte 1 — mesmo sandbox/pasta de projeto, nenhuma
 * infraestrutura nova.
 *
 * Autenticação: CHECADA na documentação oficial atual do Figma antes
 * de implementar (developers.figma.com), não assumida de conhecimento
 * antigo — confirmado em agosto de 2026:
 * - Token de acesso pessoal gerado em Configurações → aba Security →
 *   "Personal access tokens" → "Generate new token" (não é mais um
 *   fluxo simples "gera e pronto" — o Figma passou a exigir escolher
 *   ESCOPOS granulares na criação, diferente de versões antigas da
 *   API que tinham só um escopo `files:read` amplo, hoje depreciado).
 * - Enviado via header `X-Figma-Token: <token>` (não `Authorization`).
 * - Escopos necessários pra esta tool: `file_content:read` (ler nós/
 *   conteúdo do arquivo — cobre document tree, estilos locais E o
 *   endpoint de exportação de imagens, que deriva do conteúdo do
 *   arquivo) + `current_user:read` (só pra validar o token com uma
 *   chamada de baixo privilégio antes de salvar, mesmo padrão já
 *   usado pro GitHub). NÃO usa `file_variables:read` (a API mais nova
 *   de "Variables" do Figma) de propósito — checado que esse escopo é
 *   Enterprise-only; a extração de cor aqui usa o mecanismo clássico
 *   de "Styles" (publicados ou não, sempre presentes no `styles` do
 *   retorno de `/v1/files/:key`), que funciona em qualquer plano.
 *
 * Limitação real, documentada aqui pra não ser prometida além do que
 * existe: a API do Figma NÃO devolve o arquivo de fonte em si (fontes
 * comerciais/licenciadas não são redistribuíveis pela Figma) — só o
 * NOME da família/peso usados no design. "Extrair fontes" aqui
 * significa identificar o que foi usado (pra o agente escolher uma
 * fonte equivalente disponível, ex. via Google Fonts, ou avisar o
 * usuário que precisa da fonte licenciada), nunca baixar o arquivo da
 * fonte.
 *
 * `content.json` (Fase 5 parte 7 — melhoria sobre a parte 6, depois de
 * dois becos sem saída tentando o servidor MCP do Figma: o Dev Mode
 * MCP desktop exige assento pago, e o servidor MCP remoto só aceita
 * uma lista fechada de clientes pré-aprovados pelo Figma — VS Code,
 * Cursor, Claude Code —, sem registro dinâmico pra um cliente novo
 * como a SARAH; documentado em detalhe no docs/architecture.md). Em
 * vez de esperar por acesso externo, a melhoria ficou dentro da
 * própria API REST: `document.characters` (o texto de VERDADE de cada
 * nó `TEXT`) e a hierarquia de frames/grupos/componentes já vinham no
 * mesmo `GET /v1/files/:key` — só não estavam sendo usados. Isso
 * fecha boa parte da lacuna real encontrada na parte 6 (o site de
 * teste tinha cópia/estrutura INVENTADA pelo agente, só a marca era
 * real): agora o agente recebe a estrutura e o texto de verdade do
 * design, não precisa mais inventar.
 */

const FIGMA_TOKEN_SERVICE = "sarah-figma-token";
const API_BASE = "https://api.figma.com/v1";

function account(): string {
  return process.env.USER ?? userInfo().username;
}

function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("security", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** `null` se nenhum token foi configurado ainda — estado padrão, não um erro. */
export async function getFigmaToken(): Promise<string | null> {
  const { code, stdout } = await runSecurity(["find-generic-password", "-a", account(), "-s", FIGMA_TOKEN_SERVICE, "-w"]);
  if (code !== 0 || !stdout.trim()) return null;
  return stdout.trim();
}

function figmaHeaders(token: string): Record<string, string> {
  return { "X-Figma-Token": token };
}

/**
 * Valida o token de verdade (`GET /v1/me`, escopo `current_user:read`,
 * chamada de baixo privilégio) ANTES de salvar — mesmo espírito do
 * resto do projeto (GitHub, Gmail): nunca aceitar uma credencial colada
 * sem testar. Devolve o handle do Figma associado.
 */
export async function saveFigmaToken(token: string): Promise<{ handle: string }> {
  const res = await fetch(`${API_BASE}/me`, { headers: figmaHeaders(token) });
  if (!res.ok) {
    throw new Error(
      `Token do Figma rejeitado (HTTP ${res.status}) — confira se colou certo e se os escopos "File content" ` +
        `(file_content:read) e "Current user" (current_user:read) foram marcados ao criar o token em ` +
        `figma.com → Configurações → Security → Personal access tokens.`
    );
  }
  const body = (await res.json()) as { handle: string };

  const save = await runSecurity(["add-generic-password", "-a", account(), "-s", FIGMA_TOKEN_SERVICE, "-w", token, "-U"]);
  if (save.code !== 0) {
    throw new Error(`Falha ao salvar o token do Figma no Keychain: ${save.stderr.trim() || "erro desconhecido"}`);
  }
  return { handle: body.handle };
}

// --- leitura do arquivo e extração --------------------------------------

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FigmaPaint {
  type: string;
  color?: FigmaColor;
}

interface FigmaExportSetting {
  format: "JPG" | "PNG" | "SVG" | "PDF";
}

interface FigmaTextStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  fills?: FigmaPaint[];
  styles?: Record<string, string>;
  style?: FigmaTextStyle;
  exportSettings?: FigmaExportSetting[];
  /** Texto de VERDADE de um nó TEXT — o campo que faltava usar na Fase 5 parte 6. */
  characters?: string;
  children?: FigmaNode[];
}

interface FigmaStyleMeta {
  name: string;
  // Achado real validando com um arquivo de verdade: o campo vem
  // como `styleType` (camelCase), não `style_type` como o resumo dos
  // docs oficiais sugeria — corrigido depois de inspecionar a
  // resposta real da API, não confiado no resumo sem checar.
  styleType: string;
}

interface FigmaFileResponse {
  document: FigmaNode;
  styles: Record<string, FigmaStyleMeta>;
}

function rgbaToHex({ r, g, b }: FigmaColor): string {
  const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[r, g, b].map((v) => toByte(v).toString(16).padStart(2, "0")).join("")}`;
}

function sanitizeFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "asset";
}

interface FontUsage {
  family: string;
  weight: number | null;
}

interface ColorUsage {
  name: string;
  hex: string;
}

interface ExportCandidate {
  id: string;
  name: string;
  format: "SVG" | "PNG";
}

interface WalkAcc {
  fonts: Map<string, FontUsage>;
  colors: Map<string, ColorUsage>;
  exportables: ExportCandidate[];
  /**
   * Nome (e formato configurado, se houver) de TODO nó visitado, não
   * só os marcados pra exportação — bug real encontrado validando
   * (Fase 5 parte 6): `nodeIds` passado manualmente (comum, já que
   * muitos arquivos do Figma não têm nada marcado pra exportação lá
   * dentro) caía direto no fallback `name: id`, gerando arquivo tipo
   * `1-697.svg` em vez de `logo.svg`. Corrigido indexando TODO nó por
   * ID durante a mesma passagem, pra `nodeIds` manual também resolver
   * o nome de verdade.
   */
  byId: Map<string, { name: string; format?: "SVG" | "PNG" }>;
}

/**
 * Percorre a árvore do documento uma vez, coletando os insumos que a
 * tool precisa — evita passagens separadas por um arquivo que pode
 * ser grande.
 */
function walkDocument(node: FigmaNode, styles: Record<string, FigmaStyleMeta>, acc: WalkAcc): void {
  if (node.type === "TEXT" && node.style?.fontFamily) {
    const key = `${node.style.fontFamily}::${node.style.fontWeight ?? "-"}`;
    if (!acc.fonts.has(key)) {
      acc.fonts.set(key, { family: node.style.fontFamily, weight: node.style.fontWeight ?? null });
    }
  }

  const fillStyleId = node.styles?.fill;
  if (fillStyleId && styles[fillStyleId] && node.fills && node.fills.length > 0) {
    const solid = node.fills.find((f) => f.type === "SOLID" && f.color);
    if (solid?.color && !acc.colors.has(fillStyleId)) {
      acc.colors.set(fillStyleId, { name: styles[fillStyleId].name, hex: rgbaToHex(solid.color) });
    }
  }

  const exportFormat = node.exportSettings?.[0]?.format;
  const resolvedFormat = exportFormat === "SVG" || exportFormat === "PNG" ? exportFormat : undefined;
  acc.byId.set(node.id, { name: node.name, format: resolvedFormat });
  if (resolvedFormat) {
    acc.exportables.push({ id: node.id, name: node.name, format: resolvedFormat });
  }

  for (const child of node.children ?? []) {
    walkDocument(child, styles, acc);
  }
}

/**
 * Tipos de nó que compõem "estrutura de conteúdo" — inclui containers
 * (pra manter a hierarquia real de seções) e TEXT (pro texto de
 * verdade). De propósito NÃO inclui nós puramente visuais (VECTOR,
 * RECTANGLE, ELLIPSE, BOOLEAN_OPERATION, STAR, LINE etc.) — um ícone
 * decomposto em dezenas de paths só acrescentaria ruído, sem nenhum
 * conteúdo/texto relevante; imagens/ícones já são cobertos à parte
 * por `exportSettings`/`nodeIds` (exportação de verdade, não um nome
 * de nó solto).
 */
const CONTENT_NODE_TYPES = new Set(["DOCUMENT", "CANVAS", "FRAME", "GROUP", "SECTION", "COMPONENT", "COMPONENT_SET", "INSTANCE", "TEXT"]);

interface ContentNode {
  /**
   * ID real do nó no Figma (Fase 5 parte 7, item 1 da correção de
   * rate limit) — antes descartado, obrigando uma chamada NOVA a
   * `/v1/files/:key` só pra descobrir o ID de um componente antes de
   * exportá-lo como imagem. Guardando aqui (dado que já vinha de
   * graça na mesma resposta usada pra montar esta árvore), o agente
   * consegue ler `content.json` já salvo e escolher os `nodeIds` certos
   * pra `export_assets` sem gastar nenhuma chamada extra contra a cota
   * do Figma — importante porque `GET file`/`GET file nodes`/`GET
   * images` dividem a MESMA cota Tier 1 (documentado em
   * developers.figma.com/docs/rest-api/rate-limits/): só 6/mês pra
   * seat View/Collab, contra 10-20/min pra seat Dev/Full.
   */
  id: string;
  name: string;
  type: string;
  text?: string;
  children?: ContentNode[];
}

/**
 * Constrói uma árvore só com estrutura + texto de verdade — o insumo
 * que faltava na Fase 5 parte 6 pra gerar um site fiel ao design, sem
 * o agente ter que inventar cópia/seções. Nó de tipo fora de
 * `CONTENT_NODE_TYPES` é simplesmente ignorado (nem ele nem os filhos
 * entram na árvore) — ver comentário de `CONTENT_NODE_TYPES`.
 */
function buildContentTree(node: FigmaNode): ContentNode | null {
  if (!CONTENT_NODE_TYPES.has(node.type)) return null;

  const result: ContentNode = { id: node.id, name: node.name, type: node.type };
  if (node.type === "TEXT" && node.characters) {
    result.text = node.characters;
  }

  const children = (node.children ?? [])
    .map((child) => buildContentTree(child))
    .filter((child): child is ContentNode => child !== null);
  if (children.length > 0) {
    result.children = children;
  }

  return result;
}

/**
 * Lê os headers de rate limit do Figma quando presentes (documentado
 * em developers.figma.com/docs/rest-api/rate-limits/: `Retry-After`
 * em segundos, `X-Figma-Rate-Limit-Type` — "low" pra seat View/Collab
 * (até 6/mês em Tier 1) ou "high" pra seat Dev/Full (10-20/min,
 * conforme o plano) —, e `X-Figma-Plan-Tier`). Fase 5 parte 7, item 4
 * da correção de rate limit: antes disso um 429 só mostrava o corpo
 * cru da resposta, sem dar pra saber se era throttling por minuto ou
 * a cota MENSAL de um seat View/Collab batendo — a diferença importa
 * porque muda completamente o que vale a pena tentar (esperar 1 min
 * não resolve nada se o problema é mensal). Só enriquece a mensagem
 * de erro com dado real; nunca decide sozinha se deve tentar de novo.
 */
function rateLimitInfo(res: Response): string {
  const retryAfter = res.headers.get("Retry-After");
  const limitType = res.headers.get("X-Figma-Rate-Limit-Type");
  const planTier = res.headers.get("X-Figma-Plan-Tier");
  if (!retryAfter && !limitType && !planTier) return "";
  const parts: string[] = [];
  if (retryAfter) parts.push(`Retry-After: ${retryAfter}s`);
  if (limitType) parts.push(`tipo de limite: ${limitType} (low = seat View/Collab até 6/mês, high = seat Dev/Full por minuto)`);
  if (planTier) parts.push(`plano: ${planTier}`);
  return ` [rate limit do Figma — ${parts.join(", ")}]`;
}

async function fetchFigmaFile(token: string, fileKey: string): Promise<FigmaFileResponse> {
  const res = await fetch(`${API_BASE}/files/${fileKey}`, { headers: figmaHeaders(token) });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao ler o arquivo do Figma "${fileKey}" (HTTP ${res.status}): ${detail}${rateLimitInfo(res)}`);
  }
  return (await res.json()) as FigmaFileResponse;
}

/**
 * `/v1/images` só aceita UM `format` por chamada — agrupa os nós por
 * formato resolvido (o que o designer configurou em cada nó, via
 * `exportSettings`, tem prioridade sobre o `format` padrão da tool) e
 * faz uma chamada por grupo, não uma por nó. Isso importa pra cota:
 * `GET file`/`GET file nodes`/`GET images` dividem a MESMA cota Tier 1
 * do Figma (ver `rateLimitInfo` acima) — pedir N componentes do MESMO
 * formato numa chamada com `nodeIds: [id1, id2, ...]` continua sendo
 * só 1 chamada aqui dentro, não N. Só formatos diferentes (ex.: um
 * componente em SVG e outro em PNG na mesma chamada de `export_assets`)
 * geram mais de uma chamada de verdade — por isso vale preferir manter
 * tudo no mesmo formato quando a cota estiver apertada.
 */
async function exportImages(token: string, fileKey: string, nodes: ExportCandidate[]): Promise<Map<string, { url: string; format: "SVG" | "PNG" }>> {
  const byFormat = new Map<"SVG" | "PNG", ExportCandidate[]>();
  for (const node of nodes) {
    const list = byFormat.get(node.format) ?? [];
    list.push(node);
    byFormat.set(node.format, list);
  }

  const result = new Map<string, { url: string; format: "SVG" | "PNG" }>();
  for (const [format, group] of byFormat) {
    const ids = group.map((n) => n.id).join(",");
    const res = await fetch(`${API_BASE}/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${format.toLowerCase()}`, {
      headers: figmaHeaders(token),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Falha ao exportar imagens do Figma (formato ${format}, HTTP ${res.status}): ${detail}${rateLimitInfo(res)}`);
    }
    const body = (await res.json()) as { images: Record<string, string | null>; err?: string };
    if (body.err) throw new Error(`Figma recusou a exportação: ${body.err}`);
    for (const node of group) {
      const url = body.images[node.id];
      if (url) result.set(node.id, { url, format });
    }
  }
  return result;
}

// --- tool MCP -------------------------------------------------------------

const exportAssetsTool = tool(
  "export_assets",
  "Lê um arquivo do Figma do usuário (SÓ leitura — nunca escreve nada de volta no Figma) e exporta pra pasta " +
    "assets/figma/ do projeto: fontes usadas (nome/peso — não o arquivo da fonte em si, o Figma não " +
    "redistribui isso), estilos de cor nomeados (hex), imagens/componentes marcados pra exportação " +
    "dentro do Figma (ou os IDs específicos passados em `nodeIds`), e a ESTRUTURA DE CONTEÚDO real do " +
    "design (content.json) — hierarquia de seções/frames/componentes com o TEXTO DE VERDADE de cada nó, " +
    "não inventado. IMPORTANTE: ao gerar um site/página a partir de um arquivo do Figma, use content.json " +
    "como fonte da estrutura e do texto — NUNCA invente cópia/seções/produtos; só fontes/cores/imagens " +
    "reais sem estrutura real ainda deixa o resultado infiel ao design. `fileKey` é o trecho da URL do " +
    "arquivo (figma.com/design/<fileKey>/... ou figma.com/file/<fileKey>/...). Precisa de `pnpm figma:auth` " +
    "configurado antes — se não estiver, a tool recusa com uma mensagem clara. Baixo risco: só lê o Figma " +
    "e escreve arquivos dentro da pasta do projeto, nada é enviado de volta pro Figma. ATENÇÃO A COTA: " +
    "GET file/GET file nodes/GET images do Figma dividem a MESMA cota (Tier 1) — pra conta sem seat Dev/Full " +
    "pago, é só ~6 chamadas por MÊS (não por minuto). Cada `id` de nó já vem salvo em content.json (campo " +
    "`id` de cada item da árvore) depois da primeira chamada — reaproveite esses IDs pra montar `nodeIds` " +
    "sem precisar chamar de novo. E sempre que possível, passe VÁRIOS `nodeIds` do MESMO formato numa única " +
    "chamada — a tool já agrupa e faz 1 requisição por formato, não 1 por nó, então pedir 8 componentes " +
    "PNG de uma vez custa o mesmo que pedir 1.",
  {
    project: z.string().describe("slug/nome do projeto, retornado por code.create_project"),
    fileKey: z.string().describe("chave do arquivo do Figma, extraída da URL (figma.com/design/<fileKey>/...)"),
    nodeIds: z
      .array(z.string())
      .optional()
      .describe(
        "IDs específicos de nós pra exportar como imagem (opcional — sem isso, exporta os nós já marcados pra exportação dentro do próprio Figma). " +
          "Reaproveite os IDs já salvos em content.json (campo `id`) em vez de ler o arquivo de novo, e passe todos os IDs do mesmo formato juntos numa " +
          "chamada só — evita gastar chamadas extras de uma cota que pode ser mensal (ver descrição da tool)."
      ),
    format: z.enum(["svg", "png"]).default("svg").describe("formato padrão de exportação, usado quando o nó não tem um formato já configurado no Figma"),
  },
  async (args) => {
    try {
      const token = await getFigmaToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "Figma não configurado nesta máquina ainda — rode `pnpm figma:auth` uma vez (gera um token em figma.com, escopos file_content:read + current_user:read).",
              }),
            },
          ],
        };
      }

      const file = await fetchFigmaFile(token, args.fileKey);
      const acc: WalkAcc = { fonts: new Map(), colors: new Map(), exportables: [], byId: new Map() };
      walkDocument(file.document, file.styles, acc);

      // Resolve `nodeIds` manuais pelo nome REAL do nó (via `byId`,
      // indexado pra QUALQUER nó, não só os já marcados pra
      // exportação) — ver comentário em `WalkAcc.byId` pro bug real
      // que isso corrige (arquivo saindo com o ID cru no nome).
      const candidates: ExportCandidate[] = args.nodeIds
        ? args.nodeIds.map((id) => {
            const known = acc.byId.get(id);
            return {
              id,
              name: known?.name ?? id,
              format: known?.format ?? (args.format.toUpperCase() as "SVG" | "PNG"),
            };
          })
        : acc.exportables;

      const fontsPath = await resolveProjectFilePath(args.project, "assets/figma/fonts.json");
      await writeFile(fontsPath, JSON.stringify(Array.from(acc.fonts.values()), null, 2), "utf-8");

      const colorsPath = await resolveProjectFilePath(args.project, "assets/figma/colors.json");
      await writeFile(colorsPath, JSON.stringify(Array.from(acc.colors.values()), null, 2), "utf-8");

      const contentTree = buildContentTree(file.document);
      const contentPath = await resolveProjectFilePath(args.project, "assets/figma/content.json");
      await writeFile(contentPath, JSON.stringify(contentTree, null, 2), "utf-8");

      const written: string[] = [];
      const failed: string[] = [];
      if (candidates.length > 0) {
        const images = await exportImages(token, args.fileKey, candidates);
        for (const node of candidates) {
          const exported = images.get(node.id);
          if (!exported) {
            failed.push(node.name);
            continue;
          }
          const res = await fetch(exported.url);
          if (!res.ok) {
            failed.push(node.name);
            continue;
          }
          const bytes = Buffer.from(await res.arrayBuffer());
          const ext = exported.format === "SVG" ? "svg" : "png";
          const targetPath = await resolveProjectFilePath(args.project, `assets/figma/${sanitizeFilename(node.name)}.${ext}`);
          await writeFile(targetPath, bytes);
          written.push(targetPath);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                fontsFound: acc.fonts.size,
                fontsPath,
                colorsFound: acc.colors.size,
                colorsPath,
                contentPath,
                imagesExported: written,
                imagesFailed: failed,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

export const figmaServer = createSdkMcpServer({
  name: "sarah-figma",
  tools: [exportAssetsTool],
});

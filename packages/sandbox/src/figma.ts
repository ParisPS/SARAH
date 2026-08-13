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

async function fetchFigmaFile(token: string, fileKey: string): Promise<FigmaFileResponse> {
  const res = await fetch(`${API_BASE}/files/${fileKey}`, { headers: figmaHeaders(token) });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao ler o arquivo do Figma "${fileKey}" (HTTP ${res.status}): ${detail}`);
  }
  return (await res.json()) as FigmaFileResponse;
}

/**
 * `/v1/images` só aceita UM `format` por chamada — agrupa os nós por
 * formato resolvido (o que o designer configurou em cada nó, via
 * `exportSettings`, tem prioridade sobre o `format` padrão da tool) e
 * faz uma chamada por grupo.
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
      throw new Error(`Falha ao exportar imagens do Figma (formato ${format}, HTTP ${res.status}): ${detail}`);
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
    "redistribui isso), estilos de cor nomeados (hex) e imagens/componentes marcados pra exportação " +
    "dentro do Figma (ou os IDs específicos passados em `nodeIds`). `fileKey` é o trecho da URL do arquivo " +
    "(figma.com/design/<fileKey>/... ou figma.com/file/<fileKey>/...). Precisa de `pnpm figma:auth` " +
    "configurado antes — se não estiver, a tool recusa com uma mensagem clara. Baixo risco: só lê o Figma " +
    "e escreve arquivos dentro da pasta do projeto, nada é enviado de volta pro Figma.",
  {
    project: z.string().describe("slug/nome do projeto, retornado por code.create_project"),
    fileKey: z.string().describe("chave do arquivo do Figma, extraída da URL (figma.com/design/<fileKey>/...)"),
    nodeIds: z
      .array(z.string())
      .optional()
      .describe("IDs específicos de nós pra exportar como imagem (opcional — sem isso, exporta os nós já marcados pra exportação dentro do próprio Figma)"),
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

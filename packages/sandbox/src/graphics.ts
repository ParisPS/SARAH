import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeProjectFile, runProjectCommand } from "./projects.js";

/**
 * Gráficos vetoriais (Fase 5 parte 4) — SEM API externa nova: o
 * próprio modelo escreve o SVG diretamente como texto (mesma técnica
 * já usada pra mockups nesta conversa), a tool só valida o mínimo e
 * salva dentro do sandbox de código já existente (mesmo projeto,
 * mesma pasta, mesmo container de `code.*` — nenhuma infraestrutura
 * nova). Por isso vive no MESMO pacote (`@sarah/sandbox`) e reusa
 * `writeProjectFile`/`runProjectCommand` já existentes e testados —
 * só um servidor MCP novo (`sarah-graphics`), pra manter os nomes de
 * tool (`graphics.create_svg`/`graphics.export_raster`) separados de
 * `code.*` na hora do agente escolher qual chamar.
 *
 * Baixo risco: escreve um arquivo dentro da pasta `assets/` do
 * projeto (aditivo, reversível), roda um comando de conversão já
 * conhecido dentro do container isolado — mesma garantia de segurança
 * de `code.write_file`/`code.run_command` (o isolamento do container,
 * não confirmação por linha).
 *
 * Ferramenta de rasterização: NÃO assumida disponível na imagem base
 * (`node:20-alpine`) — testado antes de escrever qualquer código (ver
 * `packages/sandbox/src/podman.ts`, `createProjectContainer`): nem
 * `rsvg-convert` nem suporte a JPEG do `imagemagick` vêm por padrão,
 * os três pacotes (`rsvg-convert`, `imagemagick`, `imagemagick-jpeg`)
 * são instalados explicitamente na criação do container.
 */

const ASSETS_DIR = "assets";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function withSvgExtension(filename: string): string {
  return filename.toLowerCase().endsWith(".svg") ? filename : `${filename}.svg`;
}

/** Aceita "logo.svg" ou "assets/logo.svg" — sempre normaliza pra dentro de assets/, nunca duplica o prefixo. */
function assetPath(filename: string): string {
  const base = filename.replace(/^assets\//, "");
  return `${ASSETS_DIR}/${base}`;
}

const createSvgTool = tool(
  "create_svg",
  "Salva um gráfico vetorial (ilustração, logo, ícone, gráfico) dentro da pasta assets/ do projeto. " +
    "VOCÊ escreve o SVG completo (markup <svg>...</svg>) como `svgContent` — igual a fazer um mockup: " +
    "não existe geração automática de imagem aqui, o desenho é o código SVG que você compõe. Salvo " +
    "sempre em `assets/<filename>` (o prefixo é adicionado sozinho se você não incluir). Baixo risco: " +
    "só escreve um arquivo novo dentro da pasta do projeto, nada destrutivo. Depois de criar, use " +
    "`export_raster` se precisar de PNG/JPG (ex.: favicon, redes sociais que não aceitam SVG).",
  {
    project: z.string().describe("slug/nome do projeto, retornado por code.create_project"),
    filename: z.string().describe("nome do arquivo, ex.: 'logo.svg' (a extensão .svg é adicionada se faltar)"),
    svgContent: z.string().describe("o markup SVG completo, incluindo a tag <svg ...>...</svg>, escrito por você"),
    description: z
      .string()
      .optional()
      .describe("descrição curta do que a imagem representa — embutida como <title> acessível dentro do SVG"),
  },
  async (args) => {
    try {
      const trimmed = args.svgContent.trim();
      if (!/<svg[\s>]/i.test(trimmed)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "svgContent não parece um SVG válido — precisa conter uma tag <svg>." }) }],
        };
      }

      let content = trimmed;
      if (args.description) {
        content = content.replace(/(<svg[^>]*>)/i, `$1\n  <title>${escapeXml(args.description)}</title>`);
      }

      const relPath = assetPath(withSvgExtension(args.filename));
      const target = await writeProjectFile(args.project, relPath, content);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, written: target, path: relPath }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

const exportRasterTool = tool(
  "export_raster",
  "Rasteriza um SVG já criado com create_svg pra PNG ou JPG (ex.: favicon, redes sociais que não " +
    "aceitam SVG). Usa `rsvg-convert` pra renderizar o PNG (fiel ao SVG de verdade — gradientes, " +
    "texto, viewBox) e, se o formato pedido for JPG, converte o PNG pra JPG com fundo branco (JPG não " +
    "tem transparência — áreas transparentes do SVG viram brancas). Baixo risco: só lê um arquivo já " +
    "existente do projeto e escreve outro na mesma pasta assets/.",
  {
    project: z.string().describe("slug/nome do projeto"),
    svgFilename: z.string().describe("nome do arquivo SVG já criado (ex.: 'logo.svg'), procurado em assets/ do projeto"),
    format: z.enum(["png", "jpg"]).default("png").describe("formato de saída — 'png' (preserva transparência) ou 'jpg' (fundo branco)"),
    width: z.number().int().positive().optional().describe("largura em pixels do PNG (opcional — mantém a proporção do SVG se omitido)"),
  },
  async (args) => {
    try {
      const svgRel = assetPath(withSvgExtension(args.svgFilename));
      const base = svgRel.replace(/\.svg$/i, "");
      const pngRel = `${base}.png`;
      const widthFlag = args.width ? ` -w ${args.width}` : "";

      const rsvg = await runProjectCommand(args.project, `rsvg-convert${widthFlag} -o "${pngRel}" "${svgRel}"`);
      if (rsvg.code !== 0) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Falha ao rasterizar o SVG: ${rsvg.stderr.trim()}` }) }] };
      }

      if (args.format === "png") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: pngRel }, null, 2) }] };
      }

      const jpgRel = `${base}.jpg`;
      // `magick` (não `convert`, deprecado no ImageMagick 7) — fundo
      // branco explícito (`-flatten`), já que JPG não suporta o canal
      // alfa que o PNG intermediário pode ter.
      const convert = await runProjectCommand(args.project, `magick "${pngRel}" -background white -flatten "${jpgRel}"`);
      if (convert.code !== 0) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Falha ao converter pra JPG: ${convert.stderr.trim()}` }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: jpgRel }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

export const graphicsServer = createSdkMcpServer({
  name: "sarah-graphics",
  tools: [createSvgTool, exportRasterTool],
});

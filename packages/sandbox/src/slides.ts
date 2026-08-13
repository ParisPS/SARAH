import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import PptxGenJS from "pptxgenjs";
import { resolveProjectFilePath } from "./projects.js";

/**
 * Geração de slides (Fase 5 parte 5) — complementar ao Claude Design,
 * não substituto: a SARAH gera um `.pptx` REAL (OOXML padrão) dentro
 * da pasta do projeto; depois de gerado, o usuário pode continuar
 * editando esse MESMO arquivo no Claude Design, PowerPoint, Keynote
 * ou Google Slides — todos leem o mesmo formato.
 *
 * Tecnologia: `pptxgenjs`, checado antes de decidir (não assumido só
 * porque foi a sugestão inicial) — confirmado em agosto de 2026: MIT,
 * definições TypeScript nativas, ~12,3 milhões de downloads/mês,
 * ainda a biblioteca dominante do ecossistema JS pra isso (até
 * alternativas mais novas, como `pptx-automizer`, usam `pptxgenjs` por
 * baixo pra gerar conteúdo do zero). Sem versão nova publicada há
 * cerca de um ano, mas sem sinal de abandono (sem deprecation, issues/
 * PRs continuam ativos) — o formato OOXML em si é estável, não é uma
 * biblioteca que precisaria de releases frequentes pra continuar
 * funcionando.
 *
 * Gera direto no HOST (não dentro do container via `podman exec`,
 * diferente de `graphics.export_raster`) — `pptxgenjs` é JavaScript
 * puro, sem binding nativo, sem binário de sistema envolvido, então
 * não precisa do isolamento do container pra RODAR (só a pasta de
 * destino precisa estar dentro do projeto, garantido por
 * `resolveProjectFilePath`, a mesma validação de path traversal que
 * `code.write_file` usa). Mesmo espírito de `code.create_project`
 * criando o repositório no GitHub direto do processo do daemon.
 *
 * Baixo risco: escreve um arquivo novo dentro da pasta do projeto,
 * aditivo, nada fora dali é tocado.
 */

interface SlideOutline {
  title: string;
  bullets?: string[];
  notes?: string;
}

function withPptxExtension(filename: string): string {
  return filename.toLowerCase().endsWith(".pptx") ? filename : `${filename}.pptx`;
}

async function buildPresentation(target: string, title: string, slides: SlideOutline[]): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "SARAH_16x9", width: 10, height: 5.63 });
  pptx.layout = "SARAH_16x9";

  // Slide de capa — só título, formatação básica (fonte grande,
  // centralizado), separado do conteúdo pra dar uma estrutura de
  // apresentação de verdade, não só uma lista de slides soltos.
  const cover = pptx.addSlide();
  cover.addText(title, {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 1.2,
    fontSize: 36,
    bold: true,
    align: "center",
    color: "1F2937",
  });

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 26, bold: true, color: "1F2937" });
    if (slide.bullets && slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })),
        { x: 0.6, y: 1.3, w: 8.8, h: 4, fontSize: 18, color: "374151" }
      );
    }
    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }

  await pptx.writeFile({ fileName: target });
}

const createPresentationTool = tool(
  "create_presentation",
  "Gera uma apresentação .pptx REAL (formato OOXML padrão, abre no PowerPoint, Keynote, Google Slides " +
    "ou Claude Design) dentro da pasta do projeto — um slide de capa com o título, e um slide por item de " +
    "`slides` (título + tópicos em bullet, opcionalmente notas do apresentador). Complementar ao Claude " +
    "Design, não substituto: depois de gerado, o arquivo pode ser aberto e continuar editado em qualquer " +
    "um desses programas. Baixo risco: só escreve um arquivo novo dentro do projeto.",
  {
    project: z.string().describe("slug/nome do projeto, retornado por code.create_project"),
    filename: z.string().describe("nome do arquivo, ex.: 'apresentacao.pptx' (a extensão é adicionada se faltar)"),
    title: z.string().describe("título da apresentação — vira o slide de capa"),
    slides: z
      .array(
        z.object({
          title: z.string().describe("título do slide"),
          bullets: z.array(z.string()).optional().describe("tópicos em bullet do slide, na ordem"),
          notes: z.string().optional().describe("notas do apresentador (não aparecem na tela, só no modo apresentador)"),
        })
      )
      .min(1)
      .describe("conteúdo de cada slide de conteúdo, na ordem (o slide de capa é gerado à parte, a partir de `title`)"),
  },
  async (args) => {
    try {
      const target = await resolveProjectFilePath(args.project, withPptxExtension(args.filename));
      await buildPresentation(target, args.title, args.slides);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, written: target, slideCount: args.slides.length + 1 }, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
);

export const slidesServer = createSdkMcpServer({
  name: "sarah-slides",
  tools: [createPresentationTool],
});

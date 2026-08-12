// Bootstrap mínimo, JavaScript puro (não TypeScript) — é a única parte
// deste app que TEM que ser um arquivo .js/.mjs de verdade, porque é
// isso que o `"main"` do package.json do Electron exige (não dá pra
// apontar direto pra um `.ts`, nem pra `tsx caminho.ts` como comando).
//
// Registra o loader do `tsx` ANTES de importar qualquer código deste
// app ou de @sarah/core: depois disso, `import` de arquivos `.ts`
// funciona normalmente no processo principal do Electron, do mesmo
// jeito que já funciona no `apps/cli` via `tsx src/main.ts` — só que
// aqui é registrado programaticamente, já que o Electron não aceita
// `tsx` como interpretador na linha de comando do "main".
//
// Bug real encontrado testando isso isolado (por isso testar antes de
// construir o app inteiro): a API "genérica" do Node
// (`node:module`'s `register("tsx/esm", ...)`) registra o loader pelo
// mecanismo ANTIGO (`--loader`, depreciado desde o Node 20.6), e o
// próprio tsx detecta isso e recusa rodar: "tsx must be loaded with
// --import instead of --loader". A API programática CERTA é a que o
// próprio pacote `tsx` expõe pra esse uso exato
// (`tsx/esm/api`) — ela registra do jeito novo (`--import`) por
// baixo dos panos.
import { register } from "tsx/esm/api";

register();

await import("./src/main-process.ts");

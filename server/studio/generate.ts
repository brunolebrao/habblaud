// Estúdio: gera uma imagem com o Codex (ferramenta de geração de imagens) a partir de um prompt e guarda o resultado
// organizado em <raiz>/<projeto>/<AAAA-MM-DD>/: a imagem (<hora>-<assunto>.png), o prompt (.md) e os metadados (.json).
// A raiz é ~/estudio (HABBLAUD_STUDIO_DIR). Roda onde está o Codex: o servidor no modo Node, o auxiliar do host
// (scripts/codex-bridge.ts) no Docker.
//
// Por que `--sandbox danger-full-access`: com o `workspace-write` o Codex recusa a ferramenta de imagens ("exige uma
// aprovação que não está disponível" no exec); é o mesmo modo em que o Codex Desktop gera as imagens. Para conter isso,
// o Codex roda numa pasta só do Estúdio, com um pedido fixo (gerar e salvar uma imagem, nada mais), sem shell
// (execFile) e com prazo. O Estúdio é opcional (HABBLAUD_STUDIO=1). Node puro: também é importado pelo auxiliar.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tr } from '../../shared/i18n';

export const STUDIO_MODEL_DEFAULT = 'gpt-6-luna';
export const GENERATE_TIMEOUT_MS = 10 * 60_000;
export const PROMPT_MAX = 4_000;
export const TITLE_MAX = 80;
/** O prompt com o guia de estilo do projeto (studio.ts), como chega ao auxiliar. */
export const COMPOSED_PROMPT_MAX = PROMPT_MAX + 1_100;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export interface StudioRequest {
  project: string;
  /** Título curto da imagem (vai no nome do arquivo e na galeria). */
  title: string;
  prompt: string;
  /** Edição: a imagem da galeria que serve de base ("<projeto>/<data>/<nome>.png", do mesmo projeto). */
  source?: string;
  /** Trabalho do Higgsfield que gerou a imagem base (serve de referência sem reenviar o arquivo). */
  sourceJob?: string;
  /** "model3d": em vez de imagem, o modelo 3D (STL e GLB) da imagem `source`, pelo 3D AI Studio (model3d.ts). */
  kind?: 'model3d';
}

/** Imagem da galeria: "<projeto>/<data>/<nome>.<png|jpg|webp>". */
export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}-\d{2}-\d{2}\/[\w.-]{1,120}\.(?:png|jpe?g|webp)$/;
const JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StudioOutput {
  /** Caminho relativo à raiz: "<projeto>/<data>/<nome>.png". */
  file: string;
}

export type StudioGenerator = (req: StudioRequest) => Promise<StudioOutput>;

/** Nome de projeto em minúsculas, com hífens: "Lebre HQ" -> "lebre-hq". */
export function projectSlug(raw: string, max = 40): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Confere o pedido: {project, title, prompt} (sem título, o começo do prompt). */
export function parseStudioRequest(raw: unknown, maxPrompt = PROMPT_MAX): StudioRequest | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const project = typeof r.project === 'string' ? projectSlug(r.project) : '';
  if (!PROJECT_RE.test(project)) return { error: tr('projeto inválido (letras, números e hífens)') };
  const kind = r.kind === 'model3d' ? 'model3d' : undefined;
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!prompt && !kind) return { error: tr('escreva o prompt da imagem') };
  if (prompt.length > maxPrompt) return { error: tr('prompt longo demais (até {0} caracteres)', [maxPrompt]) };
  const rawTitle = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
  if (rawTitle.length > TITLE_MAX) return { error: tr('título longo demais (até {0} caracteres)', [TITLE_MAX]) };
  const title = rawTitle || prompt.replace(/\s+/g, ' ').slice(0, 60).trim() || tr('Modelo 3D');
  let source: string | undefined;
  if (r.source !== undefined && r.source !== null && r.source !== '') {
    if (typeof r.source !== 'string' || !SOURCE_RE.test(r.source) || r.source.includes('..') || !r.source.startsWith(`${project}/`)) {
      return { error: tr('imagem base inválida (precisa ser da galeria deste projeto)') };
    }
    source = r.source;
  }
  if (kind && !source) return { error: tr('escolha a imagem da galeria') };
  const sourceJob = source && typeof r.sourceJob === 'string' && JOB_RE.test(r.sourceJob) ? r.sourceJob : undefined;
  return { project, title, prompt, ...(source ? { source } : {}), ...(sourceJob ? { sourceJob } : {}), ...(kind ? { kind } : {}) };
}

export function studioRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HABBLAUD_STUDIO_DIR?.trim() || join(env.HOME || homedir(), 'estudio');
}

/** "2026-10-28" e "134502" no fuso local. */
export function stamp(d: Date): { date: string; time: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
}

/** Nome do arquivo: hora + o título (ou as primeiras palavras do prompt). */
export function imageBaseName(title: string, time: string): string {
  const full = projectSlug(title.split(/\s+/).slice(0, 8).join(' '), 80);
  // Longo: corta na última palavra inteira que cabe.
  const words = full.length <= 48 ? full : full.slice(0, full.lastIndexOf('-', 48) > 0 ? full.lastIndexOf('-', 48) : 48);
  return words ? `${time}-${words}` : time;
}

/** O pedido fixo ao Codex. */
export function codexInstruction(prompt: string, fileName: string, ref?: { path: string; job?: string }): string {
  // No `codex exec` a ferramenta nativa (image_gen) só existe no app Desktop; aqui o caminho é o conector Higgsfield da
  // conta, que gera na nuvem: o Codex espera o trabalho terminar e baixa a imagem para a pasta.
  const edit = ref
    ? [
        '',
        'É uma EDIÇÃO: a nova imagem parte da imagem base "' + ref.path + '" (anexada a esta conversa) e muda só o que o prompt pede;',
        'mantenha o resto (objeto, forma, cores, enquadramento e fundo) igual.',
        ref.job
          ? '- Referência: passe o trabalho do Higgsfield ' + ref.job + ' como imagem de referência (medias) no generate_image.'
          : '- Referência: envie a imagem base ao Higgsfield com mcp__codex_apps__higgsfield_media_upload (siga a descrição da ferramenta) e passe a mídia como imagem de referência (medias) no generate_image.',
        '- Com a ferramenta nativa image_gen, passe a imagem base em referenced_image_paths.',
      ]
    : [];
  return [
    'Gere UMA única imagem a partir do prompt abaixo e salve-a nesta pasta com o nome exato "' + fileName + '".',
    ...edit,
    '',
    'Como gerar:',
    '- Se você tiver a ferramenta nativa image_gen, use-a e copie o arquivo gerado para esta pasta com esse nome.',
    '- Senão, use mcp__codex_apps__higgsfield_generate_image com params {model: "gpt_image_2_5", count: 1, aspect_ratio: "1:1", prompt: <o prompt abaixo>}.',
    '  Depois espere o trabalho terminar (jobs_wait com timeout_seconds 15, repetindo, ou job_status com sync: true),',
    '  pegue o endereço (URL) da imagem pronta e baixe-a com: curl -fsSL -o "' + fileName + '" "<URL>"',
    '',
    'Regras:',
    '- Use o prompt EXATAMENTE como está: não reescreva, não resuma, não traduza e não troque o estilo.',
    '- Gere só uma imagem (uma chamada, count 1). Não crie nem altere nenhum outro arquivo e não rode outros comandos além do envio da imagem base e do download.',
    '- Termine só quando o arquivo "' + fileName + '" existir nesta pasta.',
    '- Na última linha da resposta escreva HIGGSFIELD_JOB=<id do trabalho do Higgsfield> (ou HIGGSFIELD_JOB=nenhum).',
    '',
    'Prompt:',
    prompt,
  ].join('\n');
}

/** Trabalho do Higgsfield guardado no .json ao lado de uma imagem da galeria, ou undefined. */
function jobOfImage(image: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(image.replace(/\.[a-z]+$/i, '.json'), 'utf8')) as { job?: unknown };
    return typeof meta.job === 'string' && JOB_RE.test(meta.job) ? meta.job : undefined;
  } catch {
    return undefined;
  }
}

/** Id do trabalho do Higgsfield na saída do Codex (a linha pedida ou o nome do arquivo baixado), ou undefined. */
export function higgsfieldJobOf(output: string): string | undefined {
  const id = /HIGGSFIELD_JOB=([0-9a-f-]{36})/i.exec(output)?.[1] ?? /hf_\d{8}_\d{6}_([0-9a-f-]{36})/.exec(output)?.[1];
  return id && JOB_RE.test(id.toLowerCase()) ? id.toLowerCase() : undefined;
}

/** Imagem mais recente que o Codex guardou depois de `since` na pasta da sessão (~/.codex/generated_images/<sessão>/). */
export function newestGenerated(dir: string, since: number): string | undefined {
  let best: { path: string; at: number } | undefined;
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (st.isFile() && IMAGE_RE.test(n) && st.mtimeMs >= since && (!best || st.mtimeMs > best.at)) best = { path: p, at: st.mtimeMs };
    }
  };
  walk(dir, 0);
  return best?.path;
}

export interface CodexImageOptions {
  codexBin: string;
  root?: string;
  model?: string;
  codexHome?: string;
  now?: () => Date;
  /** Roda o Codex (troca nos testes); `output` = o que ele escreveu (o cabeçalho traz o "session id"). */
  run?: (bin: string, args: string[], cwd: string) => Promise<CodexRun>;
  /** Cópia de cada imagem pronta (ex.: uma pasta do Google Drive), em <espelho>/<projeto>/<data>/. Falha = só não copia. */
  mirror?: string;
}

/** PNG, JPEG ou WebP de verdade (pelos primeiros bytes), não vazio. */
export function isImageFile(path: string): boolean {
  try {
    const head = readFileSync(path).subarray(0, 12);
    return (
      head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
      (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
    );
  } catch {
    return false;
  }
}

const GUIDE_MARK = '<!-- Gerado pelo Estúdio do Habblaud';

/** CLAUDE.md da pasta do projeto: a agente aberta ali já sabe o estilo, o que existe e como pedir imagens. */
export function projectGuide(p: { slug: string; name: string; description?: string; style?: string }): string {
  return [
    `${GUIDE_MARK}: refeito quando o projeto muda no painel. Para escrever o seu, apague esta linha. -->`,
    `# Projeto do Estúdio: ${p.name}`,
    '',
    `Você é a agente deste projeto de imagens do Estúdio do Habblaud (projeto \`${p.slug}\`, esta pasta).`,
    ...(p.description ? ['', p.description] : []),
    '',
    '## Guia de estilo',
    p.style
      ? `O Estúdio soma este guia a todo prompt: não repita, descreva só a peça.\n\n> ${p.style.replace(/\n/g, '\n> ')}`
      : 'Sem guia de estilo: os prompts vão como estão.',
    '',
    '## Como trabalhar',
    '- Converse com o usuário, proponha ideias e escreva um prompt por imagem (uma peça por imagem).',
    '- Antes de propor, leia os `.md` das imagens que já existem (`./<data>/*.md`: título e prompt) para não repetir e manter tudo coerente.',
    '- Mande cada imagem como pedido esperando aprovação; quem gera é o usuário, no painel (Gerar, Descartar ou Pedir ajuste). Nunca gere direto nem rode o Codex.',
    '- Para mandar (monte o JSON com python3 ou jq, para as aspas):',
    '',
    '```sh',
    `curl -s -X POST localhost:4747/api/studio -H 'Content-Type: application/json' -d '{"project":"${p.slug}","title":"…","prompt":"…","requestedBy":"Claude","session":"'"$CLAUDE_CODE_SESSION_ID"'"}'`,
    '```',
    '',
    '- O "Pedir ajuste" do painel chega a você como mensagem, com o pedido original: reescreva e mande um pedido novo.',
    `- Estado do projeto (pedidos e galeria): \`curl -s 'localhost:4747/api/studio?project=${p.slug}'\`.`,
    '',
  ].join('\n');
}

/** Escreve o CLAUDE.md de cada projeto (cria a pasta). Não toca num CLAUDE.md escrito à mão (sem a marca). Nunca lança. */
export function writeProjectGuides(root: string, projects: unknown): void {
  if (!Array.isArray(projects)) return;
  for (const raw of projects) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const slug = typeof r?.slug === 'string' ? r.slug : '';
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) continue;
    const str = (k: string) => (typeof r?.[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
    const text = projectGuide({ slug, name: str('name') ?? slug, description: str('description'), style: str('style') });
    const dir = join(root, slug);
    const file = join(dir, 'CLAUDE.md');
    try {
      // Nunca seguir links: a pasta e o arquivo têm de ser de verdade e dentro da raiz.
      if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !realpathSync(dir).startsWith(`${realpathSync(root)}/`))) continue;
      if (existsSync(file) && !lstatSync(file).isFile()) continue;
      const old = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      if (old === text || (old !== undefined && !old.startsWith(GUIDE_MARK))) continue;
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.CLAUDE.md.${process.pid}.tmp`);
      writeFileSync(tmp, text, { flag: 'wx' });
      renameSync(tmp, file);
    } catch {
      // pasta sem permissão: a agente só não terá o guia
    }
  }
}

/** Pasta de cópia das imagens (HABBLAUD_STUDIO_MIRROR, com ~ do usuário), ou undefined. */
export function studioMirror(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HABBLAUD_STUDIO_MIRROR?.trim();
  if (!raw) return undefined;
  return raw.startsWith('~/') ? join(env.HOME || homedir(), raw.slice(2)) : raw;
}

/** Copia arquivos da raiz (relativos) para o espelho, na mesma estrutura. Nunca lança: devolve o erro, se houver. */
export function mirrorFiles(root: string, mirror: string, rels: readonly string[]): string | undefined {
  try {
    for (const f of rels) {
      if (!existsSync(join(root, f))) continue;
      mkdirSync(join(mirror, dirname(f)), { recursive: true });
      copyFileSync(join(root, f), join(mirror, f));
    }
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Copia a imagem e os seus .md/.json para o espelho. Nunca lança: devolve o erro, se houver. */
export function mirrorImage(root: string, mirror: string, rel: string): string | undefined {
  const stem = rel.replace(/\.[a-z]+$/i, '');
  return mirrorFiles(root, mirror, [rel, `${stem}.md`, `${stem}.json`]);
}

export type CodexRun = ({ ok: true } | { ok: false; error: string }) & { output: string };

function runCodex(bin: string, args: string[], cwd: string): Promise<CodexRun> {
  return new Promise((ok) => {
    const child = execFile(bin, args, { cwd, timeout: GENERATE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => {
      const output = `${out ?? ''}\n${stderr ?? ''}`;
      if (!err) return ok({ ok: true, output });
      if (err.killed) return ok({ ok: false, error: tr('passou de {0} min sem terminar', [GENERATE_TIMEOUT_MS / 60_000]), output });
      const line = (stderr || err.message || '').split('\n').filter((l) => l.trim()).pop() ?? tr('falhou');
      ok({ ok: false, error: line.trim().slice(0, 300), output });
    });
    // Sem isto o `codex exec` fica esperando mais texto na entrada ("Reading additional input from stdin...") até o prazo.
    child.stdin?.end();
  });
}

/** Id da sessão que o `codex exec` abriu ("session id: <uuid>" no cabeçalho), ou undefined. */
export function sessionIdOf(output: string): string | undefined {
  return /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output)?.[1]?.toLowerCase();
}

export function createCodexImageGenerator(opts: CodexImageOptions): StudioGenerator {
  const root = opts.root ?? studioRoot();
  const model = opts.model ?? (process.env.HABBLAUD_STUDIO_MODEL?.trim() || STUDIO_MODEL_DEFAULT);
  const codexHome = opts.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
  const run = opts.run ?? runCodex;
  return async (req) => {
    const started = (opts.now ?? (() => new Date()))();
    const { date, time } = stamp(started);
    const dir = join(root, req.project, date);
    mkdirSync(dir, { recursive: true });
    const base = imageBaseName(req.title, time);
    const name = `${base}.png`;
    const target = join(dir, name);
    writeFileSync(join(dir, `${base}.md`), `# ${req.title}\n\n${req.prompt}\n`);
    // Edição: a imagem base vai anexada (-i) e o trabalho dela no Higgsfield, se conhecido, como referência.
    const baseImage = req.source ? join(root, req.source) : undefined;
    if (baseImage && !existsSync(baseImage)) throw new Error(tr('a imagem base não está mais na galeria'));
    const sourceJob = req.sourceJob ?? (baseImage ? jobOfImage(baseImage) : undefined);
    const ref = baseImage ? { path: baseImage, ...(sourceJob ? { job: sourceJob } : {}) } : undefined;
    const args = ['exec', '-m', model, '--sandbox', 'danger-full-access', '--skip-git-repo-check', ...(baseImage ? ['-i', baseImage] : []), '-C', dir, codexInstruction(req.prompt, name, ref)];
    const r = await run(opts.codexBin, args, dir);
    // O Codex às vezes deixa a imagem só na pasta dele: copia a desta sessão (nunca a de outra conversa).
    const session = sessionIdOf(r.output);
    // Arquivo vazio ou que não é imagem (ex.: um download que falhou): conta como não gerado.
    if (existsSync(target) && !isImageFile(target)) unlinkSync(target);
    if (!existsSync(target) && session) {
      const generated = newestGenerated(join(codexHome, 'generated_images', session), started.getTime() - 1_000);
      if (generated && isImageFile(generated)) copyFileSync(generated, target);
    }
    if (!existsSync(target)) throw new Error(r.ok ? tr('o Codex terminou sem gerar a imagem') : tr('o Codex falhou: {0}', [r.error]));
    const job = higgsfieldJobOf(r.output);
    const meta = { project: req.project, title: req.title, prompt: req.prompt, model, createdAt: started.toISOString(), file: name, ...(job ? { job } : {}), ...(req.source ? { source: req.source } : {}) };
    writeFileSync(join(dir, `${base}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    const file = `${req.project}/${date}/${name}`;
    if (opts.mirror) mirrorImage(root, opts.mirror, file);
    return { file };
  };
}

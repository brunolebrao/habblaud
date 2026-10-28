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
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
}

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
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!prompt) return { error: tr('escreva o prompt da imagem') };
  if (prompt.length > maxPrompt) return { error: tr('prompt longo demais (até {0} caracteres)', [maxPrompt]) };
  const rawTitle = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
  if (rawTitle.length > TITLE_MAX) return { error: tr('título longo demais (até {0} caracteres)', [TITLE_MAX]) };
  const title = rawTitle || prompt.replace(/\s+/g, ' ').slice(0, 60).trim();
  return { project, title, prompt };
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
export function codexInstruction(prompt: string, fileName: string): string {
  // No `codex exec` a ferramenta nativa (image_gen) só existe no app Desktop; aqui o caminho é o conector Higgsfield da
  // conta, que gera na nuvem: o Codex espera o trabalho terminar e baixa a imagem para a pasta.
  return [
    'Gere UMA única imagem a partir do prompt abaixo e salve-a nesta pasta com o nome exato "' + fileName + '".',
    '',
    'Como gerar:',
    '- Se você tiver a ferramenta nativa image_gen, use-a e copie o arquivo gerado para esta pasta com esse nome.',
    '- Senão, use mcp__codex_apps__higgsfield_generate_image com params {model: "gpt_image_2_5", count: 1, aspect_ratio: "1:1", prompt: <o prompt abaixo>}.',
    '  Depois espere o trabalho terminar (jobs_wait com timeout_seconds 15, repetindo, ou job_status com sync: true),',
    '  pegue o endereço (URL) da imagem pronta e baixe-a com: curl -fsSL -o "' + fileName + '" "<URL>"',
    '',
    'Regras:',
    '- Use o prompt EXATAMENTE como está: não reescreva, não resuma, não traduza e não troque o estilo.',
    '- Gere só uma imagem (uma chamada, count 1). Não crie nem altere nenhum outro arquivo e não rode outros comandos além do download.',
    '- Termine só quando o arquivo "' + fileName + '" existir nesta pasta.',
    '',
    'Prompt:',
    prompt,
  ].join('\n');
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
    const args = ['exec', '-m', model, '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', dir, codexInstruction(req.prompt, name)];
    const r = await run(opts.codexBin, args, dir);
    // O Codex às vezes deixa a imagem só na pasta dele: copia a desta sessão (nunca a de outra conversa).
    const session = sessionIdOf(r.output);
    if (!existsSync(target) && session) {
      const generated = newestGenerated(join(codexHome, 'generated_images', session), started.getTime() - 1_000);
      if (generated) copyFileSync(generated, target);
    }
    if (!existsSync(target)) throw new Error(r.ok ? tr('o Codex terminou sem gerar a imagem') : tr('o Codex falhou: {0}', [r.error]));
    const meta = { project: req.project, title: req.title, prompt: req.prompt, model, createdAt: started.toISOString(), file: name };
    writeFileSync(join(dir, `${base}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    return { file: `${req.project}/${date}/${name}` };
  };
}

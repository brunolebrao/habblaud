// Modo de permissão de uma sessão do Claude Code aberta no terminal interativo: lido do rodapé da tela ("⏸ manual mode
// on", "⏵⏵ accept edits on", "⏸ plan mode on", "auto mode on") e trocado com Shift+Tab, a tecla que o
// próprio Claude Code usa para passar de um modo ao próximo. Puro (o envio das teclas fica em pty/manager.ts).
import type { PermissionModeChoice } from '../../shared/types';

/** Shift+Tab no terminal (CSI Z). */
export const SHIFT_TAB = '\x1b[Z';
/** Indicador de cada modo no rodapé ("⏸ manual mode on", "⏵⏵ accept edits on"...). */
const INDICATORS: ReadonlyArray<[string, PermissionModeChoice | 'bypassPermissions' | 'dontAsk']> = [
  ['bypass permissions on', 'bypassPermissions'],
  ["don't ask on", 'dontAsk'],
  ['auto mode on', 'auto'],
  ['plan mode on', 'plan'],
  ['accept edits on', 'acceptEdits'],
  ['manual mode on', 'default'],
];
/** Dicas do rodapé do prompt no modo manual, nas versões sem o indicador (parado ou trabalhando). */
const DEFAULT_MARKS = ['? for shortcuts', 'esc to interrupt'];
/** Linhas do fim da tela onde o rodapé fica. */
const FOOTER_LINES = 8;

/** Modo que o rodapé mostra (undefined = não deu para ler: tela vazia, um diálogo aberto). */
export function modeFromScreen(text: string): PermissionModeChoice | 'bypassPermissions' | 'dontAsk' | undefined {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (!lines.join('').trim()) return undefined;
  const footer = lines.slice(-FOOTER_LINES).join('\n').toLowerCase();
  for (const [mark, mode] of INDICATORS) if (footer.includes(mark)) return mode;
  // Versões que não mostram nada no modo manual: só vale com o rodapé do prompt à vista (um diálogo, como o de
  // confiar na pasta, não tem).
  return DEFAULT_MARKS.some((m) => footer.includes(m)) ? 'default' : undefined;
}

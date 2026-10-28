// Modo de permissão de uma sessão do Claude Code aberta no terminal interativo: lido do rodapé da tela ("⏸ manual mode
// on", "⏵⏵ accept edits on", "⏸ plan mode on", "auto mode on") e trocado com Shift+Tab, a tecla que o
// próprio Claude Code usa para passar de um modo ao próximo. Puro (o envio das teclas fica em pty/manager.ts).
import type { PermissionModeChoice } from '../../shared/types';

/** Shift+Tab no terminal (CSI Z). */
export const SHIFT_TAB = '\x1b[Z';
/** Indicador de cada modo na linha do rodapé ("⏸ manual mode on", "⏵⏵ accept edits on"...), com o símbolo no começo. */
const INDICATOR = /^\s*[⏸⏵]+\s*(manual mode|accept edits|plan mode|auto mode|bypass permissions|don't ask) on\b/;
const MODES: Record<string, PermissionModeChoice | 'bypassPermissions' | 'dontAsk'> = {
  'manual mode': 'default',
  'accept edits': 'acceptEdits',
  'plan mode': 'plan',
  'auto mode': 'auto',
  'bypass permissions': 'bypassPermissions',
  "don't ask": 'dontAsk',
};
/** Dica do rodapé no modo manual, nas versões sem o indicador (parado ou trabalhando), também no começo da linha. */
const DEFAULT_HINT = /^\s*(\? for shortcuts|esc to interrupt)\b/;
/** Régua da caixa do prompt: o rodapé são as linhas abaixo da última. */
const RULE = /^\s*─{20,}\s*$/;

/**
 * Modo que o rodapé mostra (undefined = não deu para ler: tela vazia, um diálogo aberto). Só as linhas abaixo da
 * caixa do prompt contam, e o indicador tem de começar a linha: um texto do agente com "plan mode on" não engana.
 */
export function modeFromScreen(text: string): PermissionModeChoice | 'bypassPermissions' | 'dontAsk' | undefined {
  const lines = text.replace(/\s+$/, '').split('\n');
  let rule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i]!)) {
      rule = i;
      break;
    }
  }
  if (rule === -1) return undefined;
  const footer = lines.slice(rule + 1).map((l) => l.toLowerCase());
  for (const line of footer) {
    const m = INDICATOR.exec(line);
    if (m) return MODES[m[1]!];
  }
  return footer.some((l) => DEFAULT_HINT.test(l)) ? 'default' : undefined;
}

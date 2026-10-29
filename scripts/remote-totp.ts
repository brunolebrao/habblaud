// npm run remote:totp — liga o segundo fator do login remoto: código de 6 dígitos de app autenticador (TOTP).
//
// Cria um segredo novo, grava SÓ no .env (HABBLAUD_REMOTE_TOTP_SECRET, arquivo 600) e mostra a chave para cadastrar no
// app (Google Authenticator, 1Password, Senhas do iPhone…), com o QR quando o qrencode está instalado. Rode num terminal
// seu: a chave aparece na tela. Depois: npm run docker:up (os logins abertos são encerrados; entre de novo com o código).
//
//   npm run remote:totp            liga (recusa se já estiver ligado; use --new para trocar a chave)
//   npm run remote:totp -- --new   troca a chave (o app antigo para de valer)
//   npm run remote:totp -- --off   desliga (volta a só usuário e senha)
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvValue, updateEnv } from '../server/remote/envfile';
import { newTotpSecret, otpauthUri } from '../server/remote/totp';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');
const KEY = 'HABBLAUD_REMOTE_TOTP_SECRET';

const args = new Set(process.argv.slice(2));
const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const write = (content: string) => {
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
};

if (args.has('--off')) {
  write(updateEnv(current, { [KEY]: null }));
  console.log(tr('Segundo fator desligado. Rode npm run docker:up para valer.'));
  process.exit(0);
}

const user = readEnvValue(current, 'HABBLAUD_REMOTE_USER');
if (!user) {
  console.error(tr('O acesso remoto não está ligado (falta HABBLAUD_REMOTE_USER no .env): rode npm run remote:setup antes.'));
  process.exit(1);
}
if (readEnvValue(current, KEY) && !args.has('--new')) {
  console.error(tr('O segundo fator já está ligado. Para trocar a chave: npm run remote:totp -- --new (o app antigo para de valer).'));
  process.exit(1);
}

const secret = newTotpSecret();
write(updateEnv(current, { [KEY]: secret }));
const uri = otpauthUri(secret, user, 'Habblaud');

console.log(tr('Segundo fator ligado: a chave foi gravada no .env.'));
console.log('');
const qr = spawnSync('qrencode', ['-t', 'ANSIUTF8', uri], { stdio: ['ignore', 'inherit', 'ignore'] });
if (qr.status !== 0) {
  console.log(tr('No app autenticador, escolha "inserir chave" (ou "chave de configuração") e digite:'));
  console.log('');
  console.log(`   ${secret.match(/.{1,4}/g)!.join(' ')}`);
  console.log('');
  console.log(tr('Conta: {0} · tipo: baseado em tempo (6 dígitos, 30 s).', [user]));
  console.log(tr('(Para ver um QR em vez disso: brew install qrencode e rode de novo com --new.)'));
} else console.log(tr('Leia o QR acima com o app autenticador.'));
console.log('');
console.log(tr('Depois: npm run docker:up. Os logins abertos são encerrados; entre de novo com usuário, senha e o código.'));

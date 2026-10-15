import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/init.js';
import { parseEnvContent } from '../src/utils/env-file.js';
import { SolbotError } from '../src/utils/errors.js';
import { getConfigExamplePath } from '../src/utils/paths.js';
import { keypairFromSecretKey } from '../src/wallet/env-signer.js';

/** Racine temporaire simulant un projet vierge (avec l'exemple de config copié). */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-init-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.copyFileSync(getConfigExamplePath(), path.join(root, 'config', 'config.example.yaml'));
  return root;
}

function readEnv(root: string): Map<string, string> {
  return parseEnvContent(fs.readFileSync(path.join(root, '.env'), 'utf8'));
}

describe('runInit', () => {
  it('crée un .env en 600 avec un wallet valide, et copie config.yaml', () => {
    const root = makeRoot();
    const result = runInit({ root });

    const envPath = path.join(root, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    }

    const key = readEnv(root).get('BS58_PRIVATE_KEY');
    expect(key).toBeTruthy();
    expect(keypairFromSecretKey(key ?? '').publicKey.toBase58()).toBe(result.address);

    expect(result.configCreated).toBe(true);
    expect(fs.existsSync(path.join(root, 'config', 'config.yaml'))).toBe(true);
    expect(readEnv(root).get('SOLANA_RPC_URL')).toContain('http');
  });

  it('refuse de remplacer un wallet existant sans --force', () => {
    const root = makeRoot();
    runInit({ root });

    let error: unknown;
    try {
      runInit({ root });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SolbotError);
    expect((error as SolbotError).hint).toContain('--force');
  });

  it('remplace le wallet avec --force', () => {
    const root = makeRoot();
    const first = runInit({ root });
    const second = runInit({ root, force: true });
    expect(second.address).not.toBe(first.address);
    expect(second.replacedWallet).toBe(true);
  });

  it('préserve les autres variables du .env existant', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.env'), 'JUPITER_API_KEY=abc123\nBS58_PRIVATE_KEY=\n');
    const result = runInit({ root });

    const env = readEnv(root);
    expect(env.get('JUPITER_API_KEY')).toBe('abc123');
    expect(env.get('BS58_PRIVATE_KEY')).toBeTruthy();
    expect(env.get('BS58_PRIVATE_KEY')).not.toBe('');
    expect(result.replacedWallet).toBe(false);
  });
});

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_RPC_URL } from '../src/constants.js';
import { parseConfig, parseEnv } from '../src/utils/config.js';
import { ConfigError } from '../src/utils/errors.js';
import { getConfigExamplePath } from '../src/utils/paths.js';
import { createWallet } from '../src/wallet/create.js';

describe('parseEnv', () => {
  it('applique les valeurs par défaut sur un environnement vide', () => {
    const env = parseEnv({});
    expect(env.SOLANA_RPC_URL).toBe(DEFAULT_RPC_URL);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.BS58_PRIVATE_KEY).toBeUndefined();
    expect(env.JUPITER_API_KEY).toBeUndefined();
  });

  it('traite les chaînes vides comme une absence de valeur', () => {
    const env = parseEnv({ BS58_PRIVATE_KEY: '  ', JUPITER_API_KEY: '', SOLANA_RPC_URL: '' });
    expect(env.BS58_PRIVATE_KEY).toBeUndefined();
    expect(env.JUPITER_API_KEY).toBeUndefined();
    expect(env.SOLANA_RPC_URL).toBe(DEFAULT_RPC_URL);
  });

  it('rejette une URL de RPC invalide', () => {
    expect(() => parseEnv({ SOLANA_RPC_URL: 'pas-une-url' })).toThrowError(ConfigError);
    expect(() => parseEnv({ SOLANA_RPC_URL: 'ftp://exemple.com' })).toThrowError(/SOLANA_RPC_URL/);
  });

  it('rejette un LOG_LEVEL inconnu', () => {
    expect(() => parseEnv({ LOG_LEVEL: 'verbeux' })).toThrowError(/LOG_LEVEL/);
  });

  it('rejette une clé privée invalide', () => {
    expect(() => parseEnv({ BS58_PRIVATE_KEY: 'pas-une-cle' })).toThrowError(/BS58_PRIVATE_KEY/);
  });

  it('accepte une clé privée générée par le wallet', () => {
    const wallet = createWallet();
    const env = parseEnv({ BS58_PRIVATE_KEY: wallet.secretKeyBase58 });
    expect(env.BS58_PRIVATE_KEY).toBe(wallet.secretKeyBase58);
  });

  it('valide JUPITER_RPS (débit personnalisé)', () => {
    expect(parseEnv({ JUPITER_RPS: '10' }).JUPITER_RPS).toBe(10);
    expect(parseEnv({ JUPITER_RPS: '' }).JUPITER_RPS).toBeUndefined();
    expect(() => parseEnv({ JUPITER_RPS: '0' })).toThrowError(/JUPITER_RPS/);
    expect(() => parseEnv({ JUPITER_RPS: 'beaucoup' })).toThrowError(/JUPITER_RPS/);
  });
});

describe('parseConfig', () => {
  it('remplit les défauts sur un objet vide', () => {
    const config = parseConfig({});
    expect(config.mode).toBe('paper');
    expect(config.confirm_live).toBe(false);
    expect(config.loop_interval_s).toBe(30);
    expect(config.risk.max_positions).toBe(6);
    expect(config.risk.trailing_stop.retrace_pct).toBe(3);
    expect(config.execution.path).toBe('meta_aggregator');
    expect(config.execution.slippage).toBe('rtse');
    expect(config.strategies.momentum.enabled).toBe(true);
    expect(config.strategies.mean_reversion.enabled).toBe(false);
    expect(config.notifications.telegram.enabled).toBe(false);
    expect(config.universe.category).toBe('toptraded');
    expect(config.universe.interval).toBe('24h');
    expect(config.universe.candidate_limit).toBe(100);
    expect(config.universe.max_watchlist).toBe(40);
  });

  it('rejette une clé inconnue (typo dans une section)', () => {
    expect(() => parseConfig({ univers: {} })).toThrowError(/Univers|univers|Unrecognized/i);
  });

  it('rejette un mode invalide', () => {
    expect(() => parseConfig({ mode: 'turbo' })).toThrowError(/mode/);
  });

  it('exige confirm_live: true pour le mode live', () => {
    expect(() => parseConfig({ mode: 'live' })).toThrowError(/confirm_live/);
    const config = parseConfig({ mode: 'live', confirm_live: true });
    expect(config.mode).toBe('live');
  });

  it('rejette des valeurs hors bornes', () => {
    expect(() => parseConfig({ loop_interval_s: 1 })).toThrowError(/loop_interval_s/);
    expect(() => parseConfig({ risk: { max_positions: 0 } })).toThrowError(/max_positions/);
    expect(() => parseConfig({ universe: { min_organic_score: 300 } })).toThrowError(
      /min_organic_score/,
    );
  });

  it('accepte slippage = rtse ou un entier en bps', () => {
    expect(parseConfig({ execution: { slippage: 'rtse' } }).execution.slippage).toBe('rtse');
    expect(parseConfig({ execution: { slippage: 80 } }).execution.slippage).toBe(80);
    expect(() => parseConfig({ execution: { slippage: 'rapide' } })).toThrowError(/slippage/);
  });

  it('accepte une stratégie partielle et complète ses défauts', () => {
    const config = parseConfig({ strategies: { mean_reversion: { enabled: true, weight: 2 } } });
    expect(config.strategies.mean_reversion.enabled).toBe(true);
    expect(config.strategies.mean_reversion.weight).toBe(2);
    expect(config.strategies.mean_reversion.params).toEqual({});
  });

  it('valide le fichier config.example.yaml livré avec le projet', () => {
    const raw: unknown = parseYaml(fs.readFileSync(getConfigExamplePath(), 'utf8'));
    expect(() => parseConfig(raw)).not.toThrow();
  });
});

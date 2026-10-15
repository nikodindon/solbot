import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFile, maskSecret, parseEnvContent, upsertEnvVar } from '../src/utils/env-file.js';

describe('parseEnvContent', () => {
  it('parse des paires simples, des commentaires et le préfixe export', () => {
    const parsed = parseEnvContent(
      ['# commentaire', 'A=1', 'export B=deux', 'C = 3 ', '', 'D='].join('\n'),
    );
    expect(parsed.get('A')).toBe('1');
    expect(parsed.get('B')).toBe('deux');
    expect(parsed.get('C')).toBe('3');
    expect(parsed.get('D')).toBe('');
    expect(parsed.size).toBe(4);
  });

  it('retire les guillemets', () => {
    const parsed = parseEnvContent(`A="valeur avec espaces"\nB='autre'`);
    expect(parsed.get('A')).toBe('valeur avec espaces');
    expect(parsed.get('B')).toBe('autre');
  });

  it('garde la dernière occurrence pour une clé dupliquée', () => {
    expect(parseEnvContent('A=1\nA=2').get('A')).toBe('2');
  });
});

describe('upsertEnvVar', () => {
  it("remplace une clé existante en préservant l'ordre et les commentaires", () => {
    expect(upsertEnvVar('# header\nA=1\nB=2\n', 'B', '42')).toBe('# header\nA=1\nB=42\n');
  });

  it('ajoute une clé manquante en fin de fichier', () => {
    expect(upsertEnvVar('A=1\n', 'C', '3')).toBe('A=1\nC=3\n');
    expect(upsertEnvVar('A=1', 'C', '3')).toBe('A=1\nC=3\n');
    expect(upsertEnvVar('', 'C', '3')).toBe('C=3\n');
  });

  it('élimine les doublons', () => {
    expect(upsertEnvVar('A=1\nB=2\nA=3\n', 'A', '9')).toBe('A=9\nB=2\n');
  });

  it('est idempotent', () => {
    const once = upsertEnvVar('A=1\n', 'A', '2');
    expect(upsertEnvVar(once, 'A', '2')).toBe(once);
  });
});

describe('maskSecret', () => {
  it('masque intégralement les secrets courts', () => {
    expect(maskSecret('abc')).toBe('********');
    expect(maskSecret('12345678')).toBe('********');
  });

  it('conserve le début et la fin des secrets longs', () => {
    expect(maskSecret('1234567890abcdef')).toBe('1234…cdef');
  });
});

describe('loadEnvFile', () => {
  it('charge le fichier sans écraser les variables déjà définies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\nB=2\n');
    const target: NodeJS.ProcessEnv = { B: 'existant' };
    expect(loadEnvFile(dir, target)).toBe(true);
    expect(target.A).toBe('1');
    expect(target.B).toBe('existant');
  });

  it('remplit aussi les variables vides du process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
    const target: NodeJS.ProcessEnv = { A: '' };
    expect(loadEnvFile(dir, target)).toBe(true);
    expect(target.A).toBe('1');
  });

  it('retourne false quand le fichier est absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-env-'));
    expect(loadEnvFile(dir, {})).toBe(false);
  });
});

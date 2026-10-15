import type { Signal } from './types.js';

export interface WeightedSignal {
  strategy: string;
  weight: number;
  signal: Signal;
}

export interface ScoredSignal extends WeightedSignal {
  score: number;
}

export interface RankedGroup {
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** Candidats triés par score décroissant (le premier est le gagnant). */
  candidates: ScoredSignal[];
}

/**
 * Score composite d'un signal (README section 8) :
 * `confiance × poids × facteur d'edge`, où le facteur d'edge vaut
 * `1 + clamp(edge_bps, 0, 200) / 400` (∈ [1, 1.5]) et 1 quand l'edge n'est pas
 * estimé. Toutes les valeurs sont finies et ≥ 0.
 */
export function scoreSignal(signal: Signal, weight: number): number {
  const edgeFactor =
    signal.edgeEstimateBps === undefined ? 1 : 1 + clamp(signal.edgeEstimateBps, 0, 200) / 400;
  return clamp01(signal.confidence) * Math.max(0, weight) * edgeFactor;
}

/**
 * Arbitrage : regroupe les signaux par (mint, côté), trie les candidats par
 * score décroissant. Le premier de chaque groupe est la décision retenue ;
 * les autres sont journalisés comme écartés (motif `lower_score`).
 */
export function rankSignals(items: WeightedSignal[]): RankedGroup[] {
  const groups = new Map<string, RankedGroup>();
  for (const item of items) {
    const key = `${item.signal.side}:${item.signal.assetMint}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        mint: item.signal.assetMint,
        symbol: item.signal.symbol,
        side: item.signal.side,
        candidates: [],
      };
      groups.set(key, group);
    }
    group.candidates.push({ ...item, score: scoreSignal(item.signal, item.weight) });
  }
  for (const group of groups.values()) {
    group.candidates.sort((a, b) => b.score - a.score || a.strategy.localeCompare(b.strategy));
  }
  return [...groups.values()].sort((a, b) => {
    const scoreA = a.candidates[0]?.score ?? 0;
    const scoreB = b.candidates[0]?.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.mint.localeCompare(b.mint);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

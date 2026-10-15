import { JUPITER_API_BASE, SOL_MINT } from '../constants.js';
import { messageOf } from '../utils/errors.js';

export interface JupiterProbe {
  ok: boolean;
  authenticated: boolean;
  detail: string;
}

/**
 * Vérifie que l'API Jupiter répond (Price v3 sur le mint SOL).
 * Distingue : clé API invalide (401/403), rate limit (429), injoignable.
 * Sans clé API, l'accès reste possible en mode "keyless" (0.5 RPS).
 */
export async function probeJupiterApi(
  apiKey: string | undefined,
  timeoutMs = 7_000,
): Promise<JupiterProbe> {
  const url = `${JUPITER_API_BASE}/price/v3?ids=${SOL_MINT}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const authenticated = Boolean(apiKey);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, authenticated, detail: `API injoignable (${messageOf(error)})` };
  }

  if (response.status === 200) {
    const data: unknown = await response.json().catch(() => undefined);
    const hasPrice =
      typeof data === 'object' && data !== null && SOL_MINT in (data as Record<string, unknown>);
    return {
      ok: hasPrice,
      authenticated,
      detail: hasPrice
        ? authenticated
          ? 'clé API active'
          : 'mode keyless (0.5 RPS — clé API recommandée : https://developers.jup.ag/portal)'
        : 'réponse inattendue (pas de prix SOL)',
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, authenticated, detail: 'clé API invalide ou non autorisée' };
  }
  if (response.status === 429) {
    return { ok: false, authenticated, detail: 'rate limit atteint — réessayez plus tard' };
  }
  return { ok: false, authenticated, detail: `erreur HTTP ${response.status}` };
}

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/monitoring/metrics.js';

describe('MetricsRegistry', () => {
  it('rend compteurs et jauges au format Prometheus (trié, avec HELP/TYPE)', () => {
    const registry = new MetricsRegistry();
    registry.inc('solbot_ticks_total', 'Ticks exécutés', {}, 3);
    registry.set('solbot_nav_usd', 'NAV (USD)', 1000.5);
    const text = registry.render();
    expect(text).toContain('# HELP solbot_nav_usd NAV (USD)');
    expect(text).toContain('# TYPE solbot_nav_usd gauge');
    expect(text).toContain('solbot_nav_usd 1000.5');
    expect(text).toContain('# TYPE solbot_ticks_total counter');
    expect(text).toContain('solbot_ticks_total 3');
    // tri alphabétique : nav avant ticks
    expect(text.indexOf('solbot_nav_usd 1000.5')).toBeLessThan(
      text.indexOf('solbot_ticks_total 3'),
    );
  });

  it('gère les labels (tri, échappement) et la valeur courante', () => {
    const registry = new MetricsRegistry();
    registry.inc('solbot_notifications_total', 'Notifications', { status: 'ok', kind: 'trade' });
    registry.inc('solbot_notifications_total', 'Notifications', { kind: 'trade', status: 'ok' }, 2);
    registry.set('solbot_nav_usd', 'NAV', 10, { mode: 'pa"per' });
    expect(registry.value('solbot_notifications_total', { kind: 'trade', status: 'ok' })).toBe(3);
    const text = registry.render();
    expect(text).toContain('solbot_notifications_total{kind="trade",status="ok"} 3');
    expect(text).toContain('solbot_nav_usd{mode="pa\\"per"} 10');
  });

  it('refuse de mélanger compteur et jauge sur le même nom', () => {
    const registry = new MetricsRegistry();
    registry.inc('solbot_x_total', 'Compteur');
    expect(() => registry.set('solbot_x_total', 'Jauge', 1)).toThrow(/déjà définie en counter/);
  });

  it('rend une chaîne vide sans métrique', () => {
    expect(new MetricsRegistry().render()).toBe('');
  });
});

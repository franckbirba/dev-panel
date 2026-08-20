// Contrat §6, plafond fleet/jour. La règle qui compte, et qui vient d'un
// arbitrage explicite : c'est un gate à l'ADMISSION — un job déjà lancé
// n'est jamais tué parce que la fleet a beaucoup dépensé aujourd'hui.
import { describe, it, expect } from 'vitest';
import { checkSpendGate, fleetDailyLimitEur } from '../../src/worker/spend-gate.js';

describe('fleetDailyLimitEur', () => {
  it('vaut 15 € par défaut', () => {
    expect(fleetDailyLimitEur({})).toBe(15);
  });

  it('lit la config', () => {
    expect(fleetDailyLimitEur({ FLEET_DAILY_SPEND_LIMIT: '40' })).toBe(40);
  });

  it('0 désactive explicitement le gate', () => {
    expect(fleetDailyLimitEur({ FLEET_DAILY_SPEND_LIMIT: '0' })).toBeNull();
  });

  it('retombe sur le défaut si la valeur est absurde', () => {
    expect(fleetDailyLimitEur({ FLEET_DAILY_SPEND_LIMIT: 'beaucoup' })).toBe(15);
    expect(fleetDailyLimitEur({ FLEET_DAILY_SPEND_LIMIT: '-5' })).toBe(15);
  });
});

describe('checkSpendGate', () => {
  it('admet sous le plafond', () => {
    expect(checkSpendGate({ spentTodayEur: 3.2, limitEur: 15 }).admitted).toBe(true);
  });

  it('refuse au-delà, avec une raison lisible', () => {
    const r = checkSpendGate({ spentTodayEur: 15.4, limitEur: 15 });
    expect(r.admitted).toBe(false);
    expect(r.reason).toBe('fleet_daily_spend_limit');
    expect(r.detail).toMatch(/les jobs en cours continuent/);
  });

  it('laisse passer un dispatch urgent malgré le plafond', () => {
    expect(checkSpendGate({ spentTodayEur: 99, limitEur: 15, priority: 'urgent' }).admitted).toBe(true);
    expect(checkSpendGate({ spentTodayEur: 99, limitEur: 15, priority: 'p0' }).admitted).toBe(true);
  });

  it('n\'admet pas un p2 sous prétexte qu\'il est presque urgent', () => {
    expect(checkSpendGate({ spentTodayEur: 99, limitEur: 15, priority: 'p2' }).admitted).toBe(false);
  });

  it('admet tout quand le gate est désactivé', () => {
    expect(checkSpendGate({ spentTodayEur: 1000, limitEur: null }).admitted).toBe(true);
  });

  it('rapporte toujours dépense et plafond, admis ou non', () => {
    for (const spent of [1, 100]) {
      const r = checkSpendGate({ spentTodayEur: spent, limitEur: 15 });
      expect(r.spent_today_eur).toBe(spent);
      expect(r.limit_eur).toBe(15);
    }
  });
});

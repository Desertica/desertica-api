import { hasRucFormat, hasValidRucCheckDigit } from './ruc';

describe('RUC', () => {
  it('accepts well-known valid RUCs', () => {
    // RUC de SUNAT y de empresas públicas conocidas.
    for (const ruc of ['20131312955', '20100070970', '10000000001']) {
      expect(hasRucFormat(ruc)).toBe(true);
    }
    expect(hasValidRucCheckDigit('20131312955')).toBe(true);
    expect(hasValidRucCheckDigit('20100070970')).toBe(true);
  });

  it('rejects a wrong check digit, length or prefix', () => {
    expect(hasValidRucCheckDigit('20131312954')).toBe(false);
    expect(hasValidRucCheckDigit('2013131295')).toBe(false);
    expect(hasRucFormat('30131312955')).toBe(false);
    expect(hasRucFormat('2013131295a')).toBe(false);
  });
});

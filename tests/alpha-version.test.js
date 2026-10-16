import { describe, expect, it } from 'vitest';
import { versionHash } from '../src/modules/alphas/service.js';

describe('alpha version content hash', () => {
  it('normalizes expression whitespace and settings key order', () => {
    expect(versionHash('rank(close)\n', { region: 'USA', delay: 1 })).toBe(versionHash(' rank(close) ', { delay: 1, region: 'USA' }));
  });

  it('changes when settings change', () => {
    expect(versionHash('rank(close)', { delay: 1 })).not.toBe(versionHash('rank(close)', { delay: 2 }));
  });
});

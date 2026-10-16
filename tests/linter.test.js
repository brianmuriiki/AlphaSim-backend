import { describe, expect, it } from 'vitest';
import { parseExpression } from '../src/lib/linter.js';

describe('Fast Expression parser', () => {
  it('parses assignments, calls and a final expression', () => {
    const statements = parseExpression('move = ts_delta(close, 5); rank(move)');
    expect(statements).toHaveLength(2);
    expect(statements[0].type).toBe('assignment');
    expect(statements[1].type).toBe('expression');
  });

  it('reports line and column for malformed syntax', () => {
    expect(() => parseExpression('x = ts_delta(close, 5)\n@')).toThrow();
  });
});

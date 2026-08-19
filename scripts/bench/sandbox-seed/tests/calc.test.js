import { describe, it, expect } from 'vitest';
import { add, mul } from '../src/calc.js';

describe('calc', () => {
  it('adds', () => expect(add(2, 3)).toBe(5));
  it('muls', () => expect(mul(2, 3)).toBe(6));
});

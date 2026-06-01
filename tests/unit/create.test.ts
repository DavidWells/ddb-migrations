import { describe, expect, it } from 'vitest';
import { slugify, timestamp } from '../../src/lib/actions/create.js';

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics into dashes', () => {
    expect(slugify('Add User Schema!')).toBe('add-user-schema');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('  hello  world  ')).toBe('hello-world');
  });

  it('caps slug length at 60 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('timestamp', () => {
  it('formats UTC date as YYYY-MM-DD_HH-MM', () => {
    const t = timestamp(new Date(Date.UTC(2026, 4, 4, 11, 30, 45)));
    expect(t).toBe('2026-05-04_11-30');
  });

  it('zero-pads single-digit components', () => {
    const t = timestamp(new Date(Date.UTC(2026, 0, 1, 1, 2, 3)));
    expect(t).toBe('2026-01-01_01-02');
  });
});

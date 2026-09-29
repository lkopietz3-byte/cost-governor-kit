import { describe as suite, expect, it } from 'vitest';
import { describe, escapeText, isBlank, isPlainRecord } from './internal.js';

suite('isPlainRecord', () => {
  it('accepts plain objects, null-prototype objects and objects from another realm', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a string', 'x'],
    ['a boolean', true],
    ['an array', []],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a Date', new Date(0)],
    ['a RegExp', /x/],
    ['a Promise', Promise.resolve()],
    ['a function', () => 1],
    ['a class instance', new (class Thing {})()],
    ['an object with an ordinary prototype', Object.create({})],
  ])('rejects %s', (_label, value) => {
    expect(isPlainRecord(value)).toBe(false);
  });
});

suite('escapeText', () => {
  it('leaves ordinary text, backslashes and non-ASCII letters alone', () => {
    expect(escapeText('gpt-4 café \\ 日本')).toBe('gpt-4 café \\ 日本');
  });

  it('spells newline, carriage return and tab as backslash escapes', () => {
    expect(escapeText('a\nb\rc\td')).toBe('a\\nb\\rc\\td');
  });

  it('spells every other control, format, separator and lone-surrogate character as \\u{HEX}', () => {
    expect(escapeText('\u001b[31m')).toBe('\\u{1B}[31m');
    expect(escapeText('\u0000\u007f\u009b')).toBe('\\u{0}\\u{7F}\\u{9B}');
    expect(escapeText('‮⁦⁩؜​')).toBe('\\u{202E}\\u{2066}\\u{2069}\\u{61C}\\u{200B}');
    expect(escapeText('  ')).toBe('\\u{2028}\\u{2029}');
    expect(escapeText('a\ud800b')).toBe('a\\u{D800}b');
  });
});

suite('describe', () => {
  it('quotes and escapes a string', () => {
    expect(describe('abc')).toBe('"abc"');
    expect(describe('a\nb‮')).toBe('"a\\nb\\u{202E}"');
  });

  it('cuts a string after 80 characters and marks the cut', () => {
    expect(describe('x'.repeat(80))).toBe(`"${'x'.repeat(80)}"`);
    expect(describe('x'.repeat(81))).toBe(`"${'x'.repeat(80)}"…`);
  });

  it('prints numbers, booleans, null and undefined as themselves', () => {
    expect(describe(3)).toBe('3');
    expect(describe(Number.NaN)).toBe('NaN');
    expect(describe(-Infinity)).toBe('-Infinity');
    expect(describe(true)).toBe('true');
    expect(describe(null)).toBe('null');
    expect(describe(undefined)).toBe('undefined');
  });

  it('prints a bigint with an n suffix', () => {
    expect(describe(5n)).toBe('5n');
  });

  it('names symbols, functions, arrays and objects by kind without calling into them', () => {
    let called = false;
    const hostile = {
      toString(): string {
        called = true;
        throw new RangeError('boom');
      },
      toJSON(): never {
        called = true;
        throw new RangeError('boom');
      },
    };
    expect(describe(Symbol('x'))).toBe('a symbol');
    expect(describe(() => 1)).toBe('a function');
    expect(describe([1, 2])).toBe('an array');
    expect(describe({})).toBe('an object');
    expect(describe(Object.create(null))).toBe('an object');
    expect(describe(hostile)).toBe('an object');
    expect(called).toBe(false);
  });

  it('does not throw for a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describe(proxy)).toBe('an object');
  });
});

suite('isBlank', () => {
  it('is true for empty, whitespace-only and invisible-only strings', () => {
    for (const text of ['', ' ', ' \t\n\r', ' ', ' ', '​', '‍', '⁠', '﻿', '­', '؜', '⁦⁩', '‪‬', '️', 'ㅤ', ' ​⁦ ']) {
      expect(isBlank(text)).toBe(true);
    }
  });

  it('is false as soon as one visible character is present', () => {
    for (const text of ['a', ' a ', '​a​', '0', '.', '⁦x⁩', '日']) {
      expect(isBlank(text)).toBe(false);
    }
  });
});

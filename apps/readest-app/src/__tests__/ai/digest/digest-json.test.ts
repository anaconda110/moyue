// @vitest-environment node
import { describe, expect, test } from 'vitest';

import {
  DigestParseError,
  extractJsonObject,
  hashContent,
  parseBookDigestPayload,
  parseChapterDigestPayload,
  parseVolumeDigestPayload,
} from '@/services/ai/digest/types';

const chapterPayload = {
  summary: 'The hero leaves home.',
  characters: [{ name: 'Hero', change: 'commits to the journey' }],
  events: [
    { text: 'The village burns', importance: 3 },
    { text: 'A letter arrives', importance: 1 },
  ],
  foreshadowing: { planted: ['the broken sword'], paid: ['the prophecy'] },
  quotes: ['We ride at dawn.'],
};

describe('extractJsonObject', () => {
  test('parses a bare JSON object', () => {
    expect(extractJsonObject('{"summary":"ok"}')).toEqual({ summary: 'ok' });
  });

  test('strips a ```json fence', () => {
    const raw = '```json\n{"summary":"fenced"}\n```';
    expect(extractJsonObject(raw)).toEqual({ summary: 'fenced' });
  });

  test('ignores an unlabelled fence', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('recovers an object surrounded by prose', () => {
    const raw = 'Sure! Here is the digest:\n{"summary":"prose"}\nHope this helps.';
    expect(extractJsonObject(raw)).toEqual({ summary: 'prose' });
  });

  test('throws DigestParseError when there is no JSON object', () => {
    expect(() => extractJsonObject('the model refused')).toThrow(DigestParseError);
    expect(() => extractJsonObject('[1,2,3]')).toThrow(DigestParseError);
  });
});

describe('parseChapterDigestPayload', () => {
  test('reads a well-formed payload', () => {
    expect(parseChapterDigestPayload(JSON.stringify(chapterPayload))).toEqual(chapterPayload);
  });

  test('coerces lenient model output', () => {
    const raw = JSON.stringify({
      summary: '  Trim me  ',
      characters: ['Hero', { name: 'Mentor' }, { change: 'no name' }],
      events: [
        'Plain event',
        { text: 'Typed event', importance: '3' },
        { text: 'Odd', importance: 9 },
      ],
      foreshadowing: { planted: 'not an array' },
      quotes: ['q1', '', 42],
    });

    expect(parseChapterDigestPayload(raw)).toEqual({
      summary: 'Trim me',
      characters: [
        { name: 'Hero', change: '' },
        { name: 'Mentor', change: '' },
      ],
      events: [
        { text: 'Plain event', importance: 2 },
        { text: 'Typed event', importance: 3 },
        { text: 'Odd', importance: 2 },
      ],
      foreshadowing: { planted: [], paid: [] },
      quotes: ['q1', '42'],
    });
  });

  test('rejects a payload without a summary', () => {
    expect(() => parseChapterDigestPayload('{"characters":[]}')).toThrow(DigestParseError);
    expect(() => parseChapterDigestPayload('{"summary":"   "}')).toThrow(DigestParseError);
  });
});

describe('parseVolumeDigestPayload', () => {
  test('reads the merge shape and defaults missing arrays', () => {
    expect(parseVolumeDigestPayload('{"summary":"Merged"}')).toEqual({
      summary: 'Merged',
      arcs: [],
      characters: [],
      threads: [],
    });
  });

  test('rejects a payload without a summary', () => {
    expect(() => parseVolumeDigestPayload('{"arcs":["a"]}')).toThrow(DigestParseError);
  });
});

describe('parseBookDigestPayload', () => {
  test('reads the whole-book shape', () => {
    const raw = JSON.stringify({
      logline: 'A hero rises.',
      themes: ['growth'],
      characterArcs: [{ name: 'Hero', change: 'rises' }],
      structure: [{ part: 'One', summary: 'setup' }, { summary: 'no part' }, {}],
      threads: ['open question'],
    });

    expect(parseBookDigestPayload(raw)).toEqual({
      logline: 'A hero rises.',
      themes: ['growth'],
      characterArcs: [{ name: 'Hero', change: 'rises' }],
      structure: [
        { part: 'One', summary: 'setup' },
        { part: '', summary: 'no part' },
      ],
      threads: ['open question'],
    });
  });

  test('rejects a payload without a logline', () => {
    expect(() => parseBookDigestPayload('{"themes":["x"]}')).toThrow(DigestParseError);
  });
});

describe('hashContent', () => {
  test('ignores whitespace-only differences', () => {
    expect(hashContent('a b  c\n')).toBe(hashContent('a b c'));
  });

  test('changes when the text changes', () => {
    expect(hashContent('chapter one')).not.toBe(hashContent('chapter two'));
  });
});

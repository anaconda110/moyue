// @vitest-environment node
import { describe, expect, test } from 'vitest';

import type { ChapterDigest, VolumeDigest } from '@/services/ai/digest/types';
import { renderChapterForMerge } from '@/services/ai/digest/volumeDigest';
import { renderVolumeForMerge } from '@/services/ai/digest/bookDigest';

function chapter(overrides: Partial<ChapterDigest> = {}): ChapterDigest {
  return {
    kind: 'chapter',
    id: 'book:chapter:2',
    bookHash: 'book',
    sectionIndex: 2,
    chapterTitle: 'The Crossing',
    contentHash: 'v1-abc-12',
    status: 'complete',
    summary: 'They cross the river under fire.',
    characters: [{ name: 'Mira', change: 'takes command' }],
    events: [
      { text: 'The bridge burns', importance: 3 },
      { text: 'A ferry is found', importance: 2 },
    ],
    foreshadowing: { planted: ['the sealed letter'], paid: ['the ferryman debt'] },
    quotes: ['Not today.'],
    model: 'test-model',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function volume(overrides: Partial<VolumeDigest> = {}): VolumeDigest {
  return {
    kind: 'volume',
    id: 'book:volume:0-9',
    bookHash: 'book',
    from: 0,
    to: 2,
    summary: 'The company forms and leaves the valley.',
    arcs: ['the crossing'],
    characters: [{ name: 'Mira', change: 'becomes the leader' }],
    threads: ['who sent the letter'],
    chapterIds: ['book:chapter:0', 'book:chapter:1', 'book:chapter:2'],
    model: 'test-model',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('renderChapterForMerge', () => {
  test('renders every field the volume prompt needs', () => {
    const text = renderChapterForMerge(chapter());

    expect(text).toContain('### Chapter 3: The Crossing');
    expect(text).toContain('They cross the river under fire.');
    expect(text).toContain('The bridge burns (3)');
    expect(text).toContain('Mira — takes command');
    expect(text).toContain('Planted: the sealed letter');
    expect(text).toContain('Paid off: the ferryman debt');
    expect(text).toContain('Quotes: Not today.');
  });

  test('omits empty sections instead of printing blank labels', () => {
    const text = renderChapterForMerge(
      chapter({
        summary: '',
        characters: [],
        events: [],
        foreshadowing: { planted: [], paid: [] },
        quotes: [],
      }),
    );

    expect(text).toBe('### Chapter 3: The Crossing');
  });
});

describe('renderVolumeForMerge', () => {
  test('renders the volume header and every merge field', () => {
    const text = renderVolumeForMerge(volume());

    expect(text).toContain('### Chapters 1–3');
    expect(text).toContain('The company forms and leaves the valley.');
    expect(text).toContain('Arcs: the crossing');
    expect(text).toContain('Mira — becomes the leader');
    expect(text).toContain('Open threads: who sent the letter');
  });
});

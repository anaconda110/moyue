// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseBookDeepLink } from '@/utils/deeplink';

describe('parseBookDeepLink', () => {
  it('parses the custom-scheme book-open form', () => {
    expect(parseBookDeepLink('moyue://book/abc123')).toEqual({ bookHash: 'abc123' });
  });
  it('parses the web form', () => {
    // Intentional keep: `web.readest.com` here is the universal-link *domain* the
    // parser still accepts (URL parsing ≠ network/appLink grant). Batch 1 removed the
    // readest.com appLink *permission* (tauri.conf/capabilities), not URL parsing.
    // Domain migration to a Moyue-owned host is the separate Q3 lane.
    expect(parseBookDeepLink('https://web.readest.com/o/book/abc123')).toEqual({
      bookHash: 'abc123',
    });
  });
  it('surfaces the Android Auto autoplay flag', () => {
    expect(parseBookDeepLink('moyue://book/abc123?autoplay=tts')).toEqual({
      bookHash: 'abc123',
      autoplay: true,
    });
  });
  it('omits autoplay when absent or not tts', () => {
    expect(parseBookDeepLink('moyue://book/abc123?autoplay=foo')).toEqual({ bookHash: 'abc123' });
    expect(parseBookDeepLink('moyue://book/abc123')).toEqual({ bookHash: 'abc123' });
  });
  it('does NOT match the annotation form', () => {
    expect(parseBookDeepLink('moyue://book/abc123/annotation/n1')).toBeNull();
  });
  it('ignores unrelated urls', () => {
    expect(parseBookDeepLink('moyue://share/tok')).toBeNull();
    expect(parseBookDeepLink('not a url')).toBeNull();
  });
});

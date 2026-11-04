import { describe, expect, it } from 'vitest';
import { buildUrl, redactUrlString, readTextLimited, trimLeft, trimRight } from '../src/internal/http.js';
import { generateDeviceId } from '../src/internal/device-id.js';

const device = { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };

describe('buildUrl', () => {
  it('includes every device parameter plus extras', () => {
    const url = buildUrl('http://filmixapp.cyou/api/v2/', 'search', device, 'devid', 'tok123', {
      story: 'matrix',
    });
    for (const want of [
      'user_dev_id=devid',
      'user_dev_name=go-filmix',
      'user_dev_vendor=Xiaomi',
      'user_dev_os=11',
      'user_dev_apk=2.0.9',
      'user_dev_token=tok123',
      'story=matrix',
    ]) {
      expect(url).toContain(want);
    }
  });

  it('omits user_dev_token when there is no token', () => {
    const url = buildUrl('http://filmixapp.cyou/api/v2/', 'token_request', device, 'devid', '');
    expect(url).toContain('user_dev_id=devid');
    expect(url).not.toContain('user_dev_token=');
  });

  it('normalises slashes between base and path', () => {
    const url = buildUrl('http://filmixapp.cyou/api/v2', '/post/123', device, 'devid', 'tok');
    expect(url).toContain('/api/v2/post/123?');
  });

  it('appends with & when the base already has a query', () => {
    // Same concatenation order as Go's httpx.Build: base + "/" + path, then
    // "&" because a "?" is already present.
    const url = buildUrl('http://h/api?x=1', 'search', device, 'id', '');
    expect(url).toContain('http://h/api?x=1/search&user_dev_apk=2.0.9');
  });

  it('does not mutate the caller\'s extra record', () => {
    const extra = { story: 'matrix' };
    buildUrl('http://h/', 'search', device, 'id', 'tok', extra);
    expect(Object.keys(extra)).toEqual(['story']);
  });

  it('percent-encodes query values', () => {
    const url = buildUrl('http://h/', 'search', device, 'id', '', { story: 'тест & co' });
    expect(url).toContain('story=%D1%82%D0%B5%D1%81%D1%82+%26+co');
  });
});

describe('redactUrlString', () => {
  it('masks the token and keeps other parameters', () => {
    const got = redactUrlString('http://api/v2/search?story=matrix&user_dev_token=SECRET123');
    expect(got).not.toContain('SECRET123');
    expect(got).toContain('user_dev_token=***');
    expect(got).toContain('story=matrix');
  });

  it('leaves token-free URLs untouched', () => {
    expect(redactUrlString('http://api/v2/token_request?user_dev_id=abc')).toBe(
      'http://api/v2/token_request?user_dev_id=abc',
    );
    expect(redactUrlString('http://example.com/path')).toBe('http://example.com/path');
  });

  it('returns unparseable input verbatim', () => {
    expect(redactUrlString('not a url')).toBe('not a url');
  });
});

describe('trim helpers', () => {
  it('trims only the requested cutset', () => {
    expect(trimRight('http://h/api/v2///', '/')).toBe('http://h/api/v2');
    expect(trimLeft('///post/1', '/')).toBe('post/1');
    expect(trimRight('abc', '/')).toBe('abc');
  });
});

describe('readTextLimited', () => {
  it('truncates at the limit instead of throwing', async () => {
    const res = new Response('abcdefghij');
    expect(await readTextLimited(res, 4)).toBe('abcd');
  });

  it('returns an empty string for a null body', async () => {
    const res = new Response(null, { status: 204 });
    expect(await readTextLimited(res, 1024)).toBe('');
  });
});

describe('generateDeviceId', () => {
  it('returns 16 hex characters that differ across calls', () => {
    const a = generateDeviceId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(generateDeviceId());
  });
});

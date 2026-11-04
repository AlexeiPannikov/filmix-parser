import { describe, expect, it } from 'vitest';
import { Plan, applyQuality, maxQualityFor, parseQualities, pickBest } from '../src/models/quality.js';
import { QualityUnavailableError } from '../src/errors.js';

describe('parseQualities', () => {
  it.each([
    ['movie url with three qualities', 'https://cdn.example.com/path/video_[1080,720,480].mp4', [1080, 720, 480]],
    ['single quality', 'https://cdn.example.com/path/video_[720].mp4', [720]],
    ['url without bracket', 'https://cdn.example.com/path/video.mp4', undefined],
    ['empty string', '', undefined],
    ['high range', 'https://cdn.example.com/v_[2160,1440,1080,720,480].mp4', [2160, 1440, 1080, 720, 480]],
  ])('%s', (_name, input, want) => {
    expect(parseQualities(input)).toEqual(want);
  });
});

describe('applyQuality', () => {
  it.each([
    ['substitute into bracketed url', 'https://cdn.example.com/v_[1080,720,480].mp4', 720, 'https://cdn.example.com/v_720.mp4'],
    ['no bracket leaves url untouched', 'https://cdn.example.com/v.mp4', 720, 'https://cdn.example.com/v.mp4'],
    ['high quality 2160', 'https://cdn.example.com/v_[2160,1440,1080].mp4', 2160, 'https://cdn.example.com/v_2160.mp4'],
    ['printf-style placeholder', 'https://cdn.example.com/series/s01e01_%s.mp4', 1080, 'https://cdn.example.com/series/s01e01_1080.mp4'],
    ['printf placeholder in nested path', 'https://cdn.example.com/season1/ep_%s.mp4', 720, 'https://cdn.example.com/season1/ep_720.mp4'],
  ])('%s', (_name, link, quality, want) => {
    expect(applyQuality(link, quality)).toBe(want);
  });
});

describe('pickBest', () => {
  it.each([
    ['max under cap', [480, 720, 1080], 720, 720],
    ['all under cap', [480, 720], 1080, 720],
    ['single fitting', [720], 1080, 720],
    ['unsorted input', [480, 1080, 720], 1080, 1080],
    ['exact cap match', [480, 720, 1080], 1080, 1080],
  ])('%s', (_name, available, cap, want) => {
    expect(pickBest(available, cap)).toBe(want);
  });

  it.each([
    ['none fit', [1080, 1440], 720],
    ['empty', [], 1080],
    ['undefined', undefined, 1080],
  ])('%s throws QualityUnavailableError', (_name, available, cap) => {
    expect(() => pickBest(available, cap)).toThrow(
      QualityUnavailableError,
    );
  });
});

describe('maxQualityFor', () => {
  it('maps every plan to its cap', () => {
    expect(maxQualityFor(Plan.Guest)).toBe(480);
    expect(maxQualityFor(Plan.Free)).toBe(720);
    expect(maxQualityFor(Plan.Pro)).toBe(1080);
    expect(maxQualityFor(Plan.ProPlus)).toBe(2160);
  });
});

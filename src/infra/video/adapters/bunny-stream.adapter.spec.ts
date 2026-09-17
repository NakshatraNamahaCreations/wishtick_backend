import { mp4FallbackFile } from './bunny-stream.adapter';

describe('mp4FallbackFile', () => {
  it('picks the tallest encoded height', () => {
    expect(mp4FallbackFile('240p,360p,480p,720p')).toBe('play_720p.mp4');
  });

  it('never names a height Bunny does not write an MP4 for', () => {
    // Fallback files stop at 720p; a 1080p entry has nothing behind it.
    expect(mp4FallbackFile('360p,720p,1080p,1440p')).toBe('play_720p.mp4');
    expect(mp4FallbackFile('1080p')).toBeNull();
  });

  it('copes with spacing and order', () => {
    expect(mp4FallbackFile(' 480p , 240p ')).toBe('play_480p.mp4');
  });

  it('answers null when there is nothing', () => {
    expect(mp4FallbackFile('')).toBeNull();
    expect(mp4FallbackFile(null)).toBeNull();
    expect(mp4FallbackFile(undefined)).toBeNull();
  });
});

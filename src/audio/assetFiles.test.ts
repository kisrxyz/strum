import { describe, expect, it } from 'vitest';
import { classifyAssetFile, classifyDrop, isWavHeader } from './assetFiles';

describe('classifyDrop', () => {
  it('tells songs from cabinets by the length of a WAV', () => {
    expect(classifyDrop('song.wav', { durationSeconds: 200 })).toBe('song');
    expect(classifyDrop('cab.WAV', { durationSeconds: 0.5 })).toBe('ir');
    expect(classifyDrop('long reverb.wav', { durationSeconds: 19.9 })).toBe('ir');
    expect(classifyDrop('broken.wav', null)).toBe('ir');
  });

  it('takes the usual song formats and amp models', () => {
    for (const name of ['a.mp3', 'a.m4a', 'a.AAC', 'a.flac', 'a.ogg', 'a.opus']) expect(classifyDrop(name, null)).toBe('song');
    expect(classifyDrop('amp.nam', null)).toBe('model');
  });

  it('takes tabs and lyrics for the open song', () => {
    for (const name of ['Kayen.gp5', 'a.GP', 'a.gpx', 'a.gp3', 'a.musicxml', 'a.mxl', 'a.xml']) expect(classifyDrop(name, null)).toBe('tab');
    for (const name of ['text.cho', 'a.lrc', 'a.txt', 'a.chordpro', 'a.crd']) expect(classifyDrop(name, null)).toBe('lyrics');
  });

  it('ignores everything else', () => {
    expect(classifyDrop('x.pdf', null)).toBeNull();
    expect(classifyDrop('noext', null)).toBeNull();
  });
});

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('classifyAssetFile', () => {
  it('recognises amp models and cabinets by extension', () => {
    expect(classifyAssetFile('Marshall JCM800.NAM')).toBe('model');
    expect(classifyAssetFile('V30 SM57.wav')).toBe('ir');
  });

  it('rejects anything else', () => {
    expect(classifyAssetFile('song.mp3')).toBeNull();
    expect(classifyAssetFile('noext')).toBeNull();
  });
});

describe('isWavHeader', () => {
  it('accepts a WAV whose size bytes look like UTF-8 (the spring.wav case)', () => {
    const bytes = Uint8Array.from([...ascii('RIFF'), 0xc8, 0x96, 0x06, 0x00, ...ascii('WAVEfmt ')]);
    expect(isWavHeader(bytes)).toBe(true);
  });

  it('rejects other files', () => {
    expect(isWavHeader(Uint8Array.from([...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isWavHeader(Uint8Array.from(ascii('RIFF')))).toBe(false);
  });
});

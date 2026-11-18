import { describe, expect, it } from 'vitest';
import { NoteTrail } from './trail';

describe('NoteTrail', () => {
  it('reports a held note once', () => {
    const trail = new NoteTrail();
    expect(trail.push(64, 0)).toBe(64);
    expect(trail.push(64, 50)).toBeNull();
    expect(trail.items(60)).toHaveLength(1);
  });

  it('the same note again after a pause of 150 ms is a new note, after a dropout it is not', () => {
    const trail = new NoteTrail();
    trail.push(64, 0);
    trail.push(64, 50);
    for (let t = 100; t < 300; t += 50) expect(trail.push(null, t)).toBeNull();
    expect(trail.push(64, 300)).toBe(64);
    trail.push(null, 320);
    expect(trail.push(64, 400)).toBeNull(); // 80 ms without a note: the same note ringing on
  });

  it('a different note is new at once', () => {
    const trail = new NoteTrail();
    trail.push(64, 0);
    expect(trail.push(67, 20)).toBe(67);
    trail.push(null, 40);
    expect(trail.push(69, 60)).toBe(69);
  });

  it('fades notes over two seconds from when they were last heard', () => {
    const trail = new NoteTrail();
    trail.push(64, 0);
    trail.push(null, 100);
    trail.push(64, 300);
    trail.push(67, 320);
    trail.push(67, 600); // still ringing
    const items = trail.items(2500);
    expect(items.map((i) => i.midi)).toEqual([67]);
    expect(items[0].at).toBe(600);
    expect(items[0].alpha).toBeGreaterThan(0);
    expect(items[0].alpha).toBeLessThanOrEqual(1);
    expect(items[0].alpha).toBeCloseTo(0.05, 9);
    expect(trail.items(600)[1]).toMatchObject({ midi: 67, alpha: 1 });
    expect(trail.items(2600)).toEqual([]);
  });

  it('keeps one item per note, at most twelve', () => {
    const trail = new NoteTrail();
    trail.push(64, 0);
    trail.push(65, 10);
    trail.push(null, 20);
    trail.push(64, 200);
    expect(trail.items(210).map((i) => i.midi)).toEqual([65, 64]);
    for (let i = 0; i < 20; i++) trail.push(50 + i, 300 + i * 10);
    const items = trail.items(600);
    expect(items).toHaveLength(12);
    expect(items.at(-1)?.midi).toBe(69);
  });
});

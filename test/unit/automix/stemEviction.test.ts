import { describe, expect, it } from 'vitest';
import { pickStemVictim, toPcm } from '../../../src/services/automix/stems';

// Keys are `${playbackSongKey}:${role}`, oldest first - the order a Map hands them back.
const wantedSet = (...keys: string[]) => new Set(keys);

describe('pickStemVictim', () => {
    it('drops the oldest window nobody is waiting on', () => {
        const victim = pickStemVictim(
            ['intro:tail', 'chou:head', 'chou:tail'],
            wantedSet('intro:tail', 'chou:head'),
        );

        expect(victim).toBe('chou:tail');
    });

    it('reproduces the case it was written for', () => {
        // Playing Intro, next up 丑. A window for an abandoned transition (烂泥's head, requested
        // before the listener skipped) finishes late and lands in a full cache. Under plain LRU it
        // evicted Intro's tail - the one window the very next transition was certain to need.
        const cache = ['intro:tail', 'chou:head', 'chou:tail', 'lanni:head'];
        const victim = pickStemVictim(cache, wantedSet('intro:tail', 'chou:head'));

        expect(victim).not.toBe('intro:tail');
        const survivors = cache.filter(key => key !== victim);
        expect(survivors).toContain('intro:tail');
        expect(survivors).toContain('chou:head');
    });

    it('falls back to the oldest when every window is wanted', () => {
        const victim = pickStemVictim(
            ['a:tail', 'b:head'],
            wantedSet('a:tail', 'b:head'),
        );

        expect(victim).toBe('a:tail');
    });

    it('degrades to plain LRU when nothing has been named', () => {
        expect(pickStemVictim(['a:tail', 'b:head'], wantedSet())).toBe('a:tail');
    });

    it('has nothing to drop from an empty cache', () => {
        expect(pickStemVictim([], wantedSet('a:tail'))).toBeUndefined();
    });
});

describe('stem storage', () => {
    const roundTrip = (samples: number[]) => {
        const pcm = toPcm(Float32Array.from(samples), Float32Array.from(samples));
        return [...pcm].map(value => value / 32767);
    };

    it('keeps the two channels apart, left then right', () => {
        const pcm = toPcm(Float32Array.from([1, 1]), Float32Array.from([-1, -1]));

        expect([...pcm]).toEqual([32767, 32767, -32767, -32767]);
    });

    it('holds a sample to within the -96 dBFS floor it claims', () => {
        const samples = [0, 0.5, -0.5, 0.123456, -0.987654];
        roundTrip(samples).slice(0, samples.length).forEach((value, index) => {
            expect(Math.abs(value - samples[index])).toBeLessThan(1 / 32767);
        });
    });

    it('clamps past full scale rather than wrapping it', () => {
        // `other` is a difference of four signals, so this happens. Wrapping turns the loudest
        // sample of a blend into its own negation, which is a click.
        const pcm = toPcm(Float32Array.from([1.4, -1.4]), Float32Array.from([0, 0]));

        expect([...pcm].slice(0, 2)).toEqual([32767, -32768]);
    });
});

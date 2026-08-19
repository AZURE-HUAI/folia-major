import { describe, expect, it } from 'vitest';
import { pickStemVictim } from '../../../src/services/automix/stems';

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

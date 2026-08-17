import { describe, expect, it } from 'vitest';
import { resolveDeckSrc, type DeckSrcInput } from '@/services/automix/useAutomixDecks';

// test/unit/automix/deckSrc.test.ts
// Which of the two decks renders which source, at every step of a transition.
//
// This is the one piece of automix whose failures are entirely silent. A deck blanked at the wrong
// moment throws away everything it buffered - which is the whole point of warming - and a deck
// handed a source another deck is already sounding loads a second copy of the current track over
// the top of the one being listened to. Neither throws, and neither shows up in a log.

const A_SRC = 'https://audio.test/outgoing.flac';
const B_SRC = 'https://audio.test/incoming.flac';

const at = (over: Partial<DeckSrcInput> = {}) => {
    const base: DeckSrcInput = {
        deck: 'A', activeDeck: 'A', audioSrc: A_SRC, tailSrc: null, warmSrc: null, ...over,
    };
    return {
        A: resolveDeckSrc({ ...base, deck: 'A' }),
        B: resolveDeckSrc({ ...base, deck: 'B' }),
    };
};

describe('deck sources, walked through one transition', () => {
    it('leaves the idle deck empty until there is something worth warming', () => {
        expect(at()).toEqual({ A: A_SRC, B: undefined });
    });

    it('gives the idle deck the next track while the current one still plays', () => {
        // Nothing else has moved: the queue, the now-playing song and the progress bar all still
        // belong to A. This is only bytes.
        expect(at({ warmSrc: B_SRC })).toEqual({ A: A_SRC, B: B_SRC });
    });

    it('keeps the warmed source on the deck that just took the active role', () => {
        // The instant a blend arms, the roles swap but `audioSrc` still names the OUTGOING track -
        // it takes playSong a couple of awaits to catch up. Without the fallthrough the active
        // deck's src goes undefined here and every warmed byte is discarded.
        expect(at({ activeDeck: 'B', tailSrc: A_SRC, warmSrc: B_SRC }))
            .toEqual({ A: A_SRC, B: B_SRC });
    });

    it('holds both sources steady while playSong blanks audioSrc on its way past', () => {
        // playSong sets audioSrc to null before it sets the new one. A deck that let go here would
        // reload a moment later, which is exactly the load the warming existed to avoid.
        expect(at({ activeDeck: 'B', audioSrc: null, tailSrc: A_SRC, warmSrc: B_SRC }))
            .toEqual({ A: A_SRC, B: B_SRC });
    });

    it('changes nothing when audioSrc finally arrives at the source already loaded', () => {
        // Same string as the warm one, so React never touches the attribute and the buffer lives.
        expect(at({ activeDeck: 'B', audioSrc: B_SRC, tailSrc: A_SRC, warmSrc: B_SRC }))
            .toEqual({ A: A_SRC, B: B_SRC });
    });

    it('releases the outgoing deck once the transition has settled', () => {
        // Both nulls land in the same render. If warmSrc outlived tailSrc, deck A would be handed
        // the track deck B is playing and would load a second copy of it.
        expect(at({ activeDeck: 'B', audioSrc: B_SRC, tailSrc: null, warmSrc: null }))
            .toEqual({ A: undefined, B: B_SRC });
    });
});

describe('deck sources, refusing to double up', () => {
    it('never warms with the track that is already playing', () => {
        expect(at({ warmSrc: A_SRC })).toEqual({ A: A_SRC, B: undefined });
    });

    it('never warms with the track that is fading out', () => {
        expect(at({ activeDeck: 'B', audioSrc: B_SRC, tailSrc: A_SRC, warmSrc: A_SRC }))
            .toEqual({ A: A_SRC, B: B_SRC });
    });

    it('gives no deck a source before there is one', () => {
        expect(at({ audioSrc: null })).toEqual({ A: undefined, B: undefined });
    });
});

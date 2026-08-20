import { describe, expect, it } from 'vitest';
import {
    ceilingCurve,
    envelopeOf,
    fall,
    incomingCurves,
    outgoingCurves,
    planStemHandover,
    planVocalExit,
    rise,
    CELL_SEC,
    REST_DB,
} from '@/services/automix/stemGesture';

// test/unit/automix/stemGesture.test.ts
// The round-eleven handover, checked where it can be checked without ears.
//
// What these tests can and cannot do is worth being explicit about. Whether this gesture SOUNDS
// good was settled by eight blind listening rounds with a planted noise control, and no assertion
// here re-opens that. What they protect is that the port still does what the harness did: the
// branch fires on the same evidence, the search stays free rather than snapped, and - the one that
// would be silent and total if it broke - every outgoing curve starts at unity, which is the
// property that lets a deck change over from its element to its stems without a step.

/** A window of envelope cells at a constant level, in the shape envelopeOf returns. */
const flat = (seconds: number, value: number): Float32Array =>
    new Float32Array(Math.round(seconds / CELL_SEC)).fill(value);

/** The same, with a quiet stretch cut into it. */
const withRest = (seconds: number, value: number, from: number, to: number, quiet: number) => {
    const out = flat(seconds, value);
    for (let c = Math.round(from / CELL_SEC); c < Math.round(to / CELL_SEC); c += 1) out[c] = quiet;
    return out;
};

describe('envelopeOf', () => {
    it('measures one cell per 50ms and reads back the level that went in', () => {
        const samples = new Float32Array(44100).fill(0.5);
        const envelope = envelopeOf([samples], 44100);
        expect(envelope.length).toBe(Math.floor(1 / CELL_SEC));
        for (const cell of envelope) expect(cell).toBeCloseTo(0.5, 6);
    });

    it('sums channels rather than taking one, so a panned voice is not read as a quiet one', () => {
        // A voice hard left is exactly as present as one in the middle; reading channel 0 alone
        // would call the same performance loud or silent depending on the mix.
        const left = new Float32Array(4410).fill(0.8);
        const right = new Float32Array(4410);
        const [mono] = [envelopeOf([left, right], 44100)];
        expect(mono[0]).toBeCloseTo(0.4, 6);
    });
});

describe('planVocalExit', () => {
    it('cuts inside a real rest', () => {
        // A voice at the mix's own level, with a genuine hole in the middle of the window.
        const exit = planVocalExit(withRest(8, 1, 3, 4, 1e-6), flat(8, 1), 6);
        expect(exit.kind).toBe('rest');
        expect(exit.loudDb).toBeLessThanOrEqual(REST_DB);
        // Inside the hole, and half a second long - a cut, not a fade.
        expect(exit.from).toBeGreaterThanOrEqual(3 - 1e-9);
        expect(exit.to - exit.from).toBeCloseTo(0.5, 6);
    });

    it('recedes across the whole window when there is nowhere quiet to hide', () => {
        // The failure round ten measured: a fade needs somewhere to hide, and a voice that never
        // stops has none, so the exit becomes a long recede rather than a cut nobody can miss.
        const exit = planVocalExit(flat(8, 1), flat(8, 1), 6);
        expect(exit.kind).toBe('recede');
        expect(exit.from).toBeCloseTo(0.05, 6);
        expect(exit.to).toBeCloseTo(6, 6);
    });

    it('measures quiet against the mix, not against the vocal itself', () => {
        // The threshold is -30dB BELOW THE MIX, so the identical vocal envelope has to give
        // opposite branches under two different bands. The dip is only 20dB down on its own terms,
        // which is not a rest under a quiet mix and comfortably one under a loud mix.
        const vocals = withRest(8, 0.1, 3, 4, 0.01);
        expect(planVocalExit(vocals, flat(8, 1), 6).kind).toBe('rest');
        expect(planVocalExit(vocals, flat(8, 0.1), 6).kind).toBe('recede');
    });

    it('finds a rest that no beat grid would have landed on', () => {
        // Round eleven tried snapping the cut to the grid and measured it losing 16dB on a track
        // whose rest is barely half a second long. The search has to stay free, so a rest at an
        // arbitrary offset must still be found exactly.
        const exit = planVocalExit(withRest(8, 1, 2.35, 2.9, 1e-6), flat(8, 1), 6);
        expect(exit.kind).toBe('rest');
        expect(exit.from).toBeCloseTo(2.35, 2);
    });

    it('takes the loudest moment in the half second, not the average', () => {
        // A syllable inside a pause makes that half second unusable. An average would hide it and
        // the cut would land on the one word the listener notices being taken away.
        const vocals = withRest(8, 1, 3, 4, 1e-6);
        vocals[Math.round(3.3 / CELL_SEC)] = 1;          // one loud cell inside the hole
        const exit = planVocalExit(vocals, flat(8, 1), 6);
        expect(exit.kind).toBe('rest');
        // The chosen half second must not contain that cell - on either side of it is fine.
        expect(exit.from > 3.3 || exit.to <= 3.3 + 1e-9).toBe(true);
    });
});

describe('planStemHandover', () => {
    const bars = [0.5, 2.5, 4.5, 6.5];

    it('puts the drum swap on a bar line when one is in reach', () => {
        const plan = planStemHandover(8, 2, 2, bars, flat(8, 1), flat(8, 1));
        expect(bars).toContain(plan.swap);
        // The 42% target is 3.36s, and 2.5 is 0.86 from it against 4.5's 1.14.
        expect(plan.swap).toBe(2.5);
    });

    it('hands the bass over a bar after the drums, never at the same moment', () => {
        const plan = planStemHandover(8, 2, 2, bars, flat(8, 1), flat(8, 1));
        expect(plan.bassAt - plan.swap).toBeCloseTo(2, 6);
    });

    it('does not leave a long blend trailing behind its own handover', () => {
        // The 16.64s blend from a real session, at 115 BPM - a 2.08s bar. On the plain 42% target
        // the drums swapped at 6.99s and the bass at 9.07s, leaving 7.57s in which the outgoing
        // track had already given up its drums, its bass and its voice and was only residue. Every
        // blend in that session that sounded right left at most 1.1 bars behind the handover.
        const bar = 2.08;
        const windowSec = 16.64;
        const downbeats = Array.from({ length: 8 }, (_, index) => 0.4 + index * bar);
        const plan = planStemHandover(windowSec, bar, bar, downbeats, flat(windowSec, 1), flat(windowSec, 1));

        expect(windowSec - plan.bassAt).toBeLessThanOrEqual(2 * bar + 1e-9);
        // Moved LATER, not shortened: the extra length is spent before the handover, not after it.
        expect(plan.swap).toBeGreaterThan(0.42 * windowSec);
        expect(plan.bassAt - plan.swap).toBeCloseTo(bar, 6);
    });

    it('leaves a blend short enough to already land late exactly where it was', () => {
        // The bound is a `max` against the fraction, so it has to be inert here - 8s at a 2s bar
        // leaves 8 - 3 x 2 = 2s, well before the 42% target of 3.36s.
        const plan = planStemHandover(8, 2, 2, bars, flat(8, 1), flat(8, 1));
        expect(plan.swap).toBe(2.5);
    });

    it('still places a handover when the track has no bar lines at all', () => {
        // An unanalysed track must not lose the gesture; it loses only the placement.
        const plan = planStemHandover(8, null, null, [], flat(8, 1), flat(8, 1));
        expect(plan.swap).toBeCloseTo(0.42 * 8, 6);
        expect(plan.bassAt).toBeGreaterThan(plan.swap);
    });

    // `flat` has no rest anywhere, so the exit is always a recede - which is the arm under test.
    it('starts a recede where the beat changes hands, not at the top of the window', () => {
        const plan = planStemHandover(8, 2, 2, bars, flat(8, 1), flat(8, 1));

        expect(plan.exit.kind).toBe('recede');
        // The whole point: the outgoing voice keeps its full level over the incoming track's rise
        // until the drums move. Beginning at the floor faded it out against nothing - measured on a
        // real window, it reached -38 dB before the incoming voice had even entered, so the two
        // songs never overlapped at all.
        expect(plan.exit.from).toBe(plan.swap);
        expect(plan.exit.to).toBeGreaterThan(plan.vocalIn);
    });

    it('never squeezes a recede down into a cut', () => {
        // A long bar in a short window drags `swap` up against the deadline; past that point the
        // fade would be shorter than the half second a cut takes, in a place already judged too
        // loud to cut in.
        const plan = planStemHandover(3, 8, 8, [], flat(3, 1), flat(3, 1));
        expect(plan.exit.to - plan.exit.from).toBeGreaterThanOrEqual(1);
    });

    // Rare by nature - most rests the search finds are at the separation's noise floor - and the
    // whole "it left too fast on a few songs" complaint lives in the marginal ones.
    it('cuts faster the quieter the rest is, so a marginal one is not taken mid-breath', () => {
        const deep = planVocalExit(withRest(8, 1, 3, 4, 1e-6), flat(8, 1), 6);
        // ~-32 dB against the mix: past the threshold, but only just.
        const marginal = planVocalExit(withRest(8, 1, 3, 4, 0.025), flat(8, 1), 6);

        expect(deep.kind).toBe('rest');
        expect(marginal.kind).toBe('rest');
        expect(deep.to - deep.from).toBeCloseTo(0.5, 6);
        expect(marginal.to - marginal.from).toBeGreaterThan(deep.to - deep.from);
    });

    it('keeps every move inside the window', () => {
        // A long bar against a short window used to push the bass swap past the end, where its
        // curve would never run and the bass would simply never change hands.
        const plan = planStemHandover(3, 8, 8, [], flat(3, 1), flat(3, 1));
        for (const at of [plan.swap, plan.bassAt, plan.vocalIn, plan.exit.to]) {
            expect(at).toBeLessThanOrEqual(3);
            expect(at).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('rise / fall', () => {
    it('keeps the harness shape, which dips slightly rather than holding constant power', () => {
        // Pinned deliberately. `fall` is cos(rise * pi/2), not sqrt(1 - rise^2), so the pair loses
        // 1.6dB of power at its midpoint. That is the shape eight listening rounds were scored
        // from, and the crossings it is used for are six milliseconds long. A future reader who
        // "corrects" this to equal power is changing the gesture, not fixing it - this test is here
        // to make that a deliberate act rather than a tidy-up.
        const power = [0.25, 0.5, 0.75].map(at => rise(0, 1, at) ** 2 + fall(0, 1, at) ** 2);
        // 10log10, not 20: these are already powers, not amplitudes.
        expect(10 * Math.log10(Math.min(...power))).toBeCloseTo(-1.57, 1);
    });

    it('are flat outside their own span', () => {
        expect(rise(2, 3, 1)).toBe(0);
        expect(rise(2, 3, 9)).toBe(1);
        expect(fall(2, 3, 1)).toBe(1);
        expect(fall(2, 3, 9)).toBeCloseTo(0, 12);
    });
});

describe('the curves a window is scheduled from', () => {
    const plan = planStemHandover(8, 2, 2, [0.5, 2.5, 4.5, 6.5], flat(8, 1), flat(8, 1));

    it('starts every outgoing stem at unity', () => {
        // THE changeover invariant. At the top of the window the deck crossfades from its media
        // element to these four buffers over eight milliseconds, and the four sum back to the mix
        // exactly - `other` is derived by subtraction for precisely that reason. If any curve
        // started anywhere but 1 the handover would be a level step on that stem, every time.
        for (const curve of Object.values(outgoingCurves(8, plan))) {
            expect(curve[0]).toBeCloseTo(1, 6);
        }
    });

    it('ends every outgoing stem at silence', () => {
        // The other end of the same invariant: the outgoing deck is stopped when the window ends,
        // and a stem still sounding at that moment is cut off rather than faded.
        for (const curve of Object.values(outgoingCurves(8, plan))) {
            expect(curve[curve.length - 1]).toBeCloseTo(0, 3);
        }
    });

    it('ends every incoming stem at unity, so the element can take the track back', () => {
        for (const curve of Object.values(incomingCurves(8, plan))) {
            expect(curve[curve.length - 1]).toBeCloseTo(1, 6);
        }
    });

    it('brings the incoming pad in before its own drums', () => {
        // Round ten's clearest single result: the one entry made to crash in with drums scored 3.0
        // against 7.0 for arriving quietly. The pad has to be established before the beat changes.
        const curves = incomingCurves(8, plan);
        const cell = (curve: Float32Array, at: number) =>
            curve[Math.round((at / 8) * (curve.length - 1))];
        expect(cell(curves.other, plan.swap - 0.3)).toBeGreaterThan(0.2);
        expect(cell(curves.drums, plan.swap - 0.3)).toBeCloseTo(0, 6);
    });

    it('swaps the drums fast enough to read as an edit', () => {
        // Six milliseconds. A drum kit that fades over half a second is two drum kits for half a
        // second, which is the muddle the stem handover exists to avoid.
        const curves = outgoingCurves(8, plan);
        const cell = (at: number) => curves.drums[Math.round((at / 8) * (curves.drums.length - 1))];
        expect(cell(plan.swap - 0.05)).toBeGreaterThan(0.9);
        expect(cell(plan.swap + 0.05)).toBeLessThan(0.1);
    });
});

describe('ceilingCurve', () => {
    // The stem gesture replaces the master crossfade, and the allowance that keeps a blend under
    // full scale lived inside the crossfade. Measured on the pair this was found from - two 0 dBFS
    // masters - the sum peaked at +3.4 dBFS with 1445 samples hard-clipped; where either master had
    // headroom the same gesture peaked at -0.75. So the correction has to be measured, not constant.
    const cells = 160;                                        // eight seconds of 50ms cells

    it('leaves a blend that never reaches full scale exactly alone', () => {
        // The common case, and the one a constant allowance would have made quieter for nothing.
        const curve = ceilingCurve(new Float32Array(cells).fill(0.5), 1536);
        for (const gain of curve) expect(gain).toBe(1);
    });

    it('holds the sum under full scale where it would have clipped', () => {
        const peak = new Float32Array(cells).fill(0.5);
        for (let c = 60; c < 90; c += 1) peak[c] = 1.5;        // +3.5dB over, sustained
        const curve = ceilingCurve(peak, 1536);
        for (let c = 60; c < 90; c += 1) {
            const gain = curve[Math.round((c / (cells - 1)) * (curve.length - 1))];
            expect(peak[c] * gain).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
        }
    });

    it('is smoothed but never lets the peak it was computed from back through', () => {
        // A moving average over the raw requirement WOULD let it through, which is why the running
        // minimum comes first. One isolated loud cell is the case that catches the wrong order.
        const peak = new Float32Array(cells).fill(0.5);
        peak[80] = 2;
        const curve = ceilingCurve(peak, 1536);
        const gain = curve[Math.round((80 / (cells - 1)) * (curve.length - 1))];
        expect(peak[80] * gain).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    });

    it('starts and ends at exactly unity', () => {
        // THE changeover invariant outranks this one: the deck splices from its media element to
        // the stem buffers over eight milliseconds at the top of the window and hands the track
        // back at the bottom. A ceiling that did not return to 1 would put a step on both.
        const curve = ceilingCurve(new Float32Array(cells).fill(4), 1536);
        expect(curve[0]).toBe(1);
        expect(curve[curve.length - 1]).toBe(1);
    });
});

import { describe, expect, it, vi } from 'vitest';
import {
    createCanvasCardSnapshotQueue,
    drawCanvasGridCardSnapshot,
    hitTestCanvasGridCard,
    resolveCanvasGridFrame,
    type CanvasCardRenderOptions,
} from '../../../src/components/folia-grid/canvasGridRenderer';
import type { HexGridCoord } from '../../../src/components/folia-grid/hexViewport';
import type { GridItem } from '../../../src/components/folia-grid/gridTypes';

// Verifies Canvas GridView frame resolution, hit-testing, and snapshot cache reuse.
const renderOptions: CanvasCardRenderOptions = {
    mode: 'tracks',
    cardWidth: 220,
    cardHeight: 330,
    isDaylight: false,
    theme: {
        name: 'test',
        backgroundColor: '#09090b',
        primaryColor: '#f4f4f5',
        accentColor: '#a1a1aa',
        secondaryColor: '#71717a',
        fontStyle: 'sans',
        animationIntensity: 'normal',
    },
    backgroundColor: '#09090b',
    textColor: '#f4f4f5',
};

const frameOptions = {
    clipRadius: 900,
    maxDistance: 500,
    lodStart: 340,
    lodEnd: 385,
    viewportWidth: 1200,
    viewportHeight: 800,
    cardWidth: 220,
    cardHeight: 330,
    visibilityBuffer: 96,
};

const makeItem = (index: number): GridItem => ({
    id: index,
    name: `Track ${index}`,
    description: 'Artist',
    rawTrack: {
        id: index,
        name: `Track ${index}`,
        ar: [{ id: index, name: 'Artist' }],
        al: { id: index, name: 'Album', picUrl: '' },
        dt: 180000,
    } as any,
});

const makeCoord = (index: number, baseX: number, baseY: number): HexGridCoord => ({
    index,
    baseX,
    baseY,
    cube: { x: index, y: -index, z: 0 },
});

const createFakeContext = () => ({
    canvas: { width: 1, height: 1 },
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    lineTo: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
    set globalAlpha(_value: number) {},
});

describe('canvasGridRenderer', () => {
    it('resolves visible cards in far-to-near draw order and skips the overlay card', () => {
        const items = [makeItem(0), makeItem(1), makeItem(2)];
        const coords = [
            makeCoord(0, 0, 0),
            makeCoord(1, 260, 0),
            makeCoord(2, 2000, 0),
        ];

        const frame = resolveCanvasGridFrame({
            items,
            coords,
            dx: 0,
            dy: 0,
            frameOptions,
            renderOptions,
            overlayIndex: 0,
        });

        expect(frame.closestIndex).toBe(0);
        expect(frame.cards.map(card => card.index)).toEqual([1]);
    });

    it('skips all DOM overlay cards when focused and hovered cards are both mounted', () => {
        const items = [makeItem(0), makeItem(1), makeItem(2)];
        const coords = [
            makeCoord(0, 0, 0),
            makeCoord(1, 260, 0),
            makeCoord(2, 0, 260),
        ];

        const frame = resolveCanvasGridFrame({
            items,
            coords,
            dx: 0,
            dy: 0,
            frameOptions,
            renderOptions,
            overlayIndexes: [0, 1],
        });

        expect(frame.closestIndex).toBe(0);
        expect(frame.cards.map(card => card.index)).toEqual([2]);
    });

    it('hit-tests scaled cards using the topmost visible card', () => {
        const items = [makeItem(0), makeItem(1)];
        const coords = [
            makeCoord(0, 260, 0),
            makeCoord(1, 0, 0),
        ];
        const frame = resolveCanvasGridFrame({
            items,
            coords,
            dx: 0,
            dy: 0,
            frameOptions,
            renderOptions,
        });

        expect(hitTestCanvasGridCard(frame.cards, { x: 0, y: 0 })?.index).toBe(1);
        expect(hitTestCanvasGridCard(frame.cards, { x: 1000, y: 1000 })).toBeNull();
    });

    it('reuses snapshot records for identical item and render keys', () => {
        const context = createFakeContext();
        const createCanvas = vi.fn((width: number, height: number) => ({
            width,
            height,
            getContext: () => context,
        } as any));
        const queue = createCanvasCardSnapshotQueue({
            createCanvas,
            loadImage: vi.fn(async () => null),
        });
        const item = makeItem(0);

        const first = queue.getOrQueue(item, renderOptions, vi.fn());
        const second = queue.getOrQueue(item, renderOptions, vi.fn());

        expect(first).toBe(second);
        expect(queue.size()).toBe(1);
        expect(createCanvas).toHaveBeenCalledTimes(1);
        expect(createCanvas).toHaveBeenCalledWith(330, 495);
    });

    it('draws explicit title text when the card name is a React node', () => {
        const context = createFakeContext();
        const item: GridItem = {
            ...makeItem(7),
            name: { type: 'span', props: { children: 'React Title' } } as any,
            titleText: 'Snapshot Title',
        };

        drawCanvasGridCardSnapshot(context as any, item, renderOptions, null);

        expect(context.fillText).toHaveBeenCalledWith(
            'Snapshot Title',
            expect.any(Number),
            expect.any(Number)
        );
    });
});

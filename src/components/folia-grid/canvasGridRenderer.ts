import type { Theme } from '../../types';
import { colorWithAlpha } from '../visualizer/colorMix';
import { computeHexCardFrame, type HexCardFrame, type HexCardFrameOptions } from './hexCardTransform';
import type { HexGridCoord } from './hexViewport';
import type { GridItem, GridViewMode } from './gridTypes';

// Draws and hit-tests the Canvas 2D version of GridView's folia polaroid grid.
export interface CanvasCardRenderOptions {
    mode: GridViewMode;
    cardWidth: number;
    cardHeight: number;
    isDaylight: boolean;
    theme: Theme;
    backgroundColor: string;
    textColor: string;
}

export interface CanvasGridItemSnapshot {
    key: string;
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    ready: boolean;
}

export interface CanvasGridFrameCard {
    index: number;
    item: GridItem;
    coord: HexGridCoord;
    frame: HexCardFrame;
    centerX: number;
    centerY: number;
    width: number;
    height: number;
    zIndex: number;
}

export interface CanvasGridFrame {
    cards: CanvasGridFrameCard[];
    closestIndex: number;
}

export interface CanvasCardHitTarget {
    index: number;
    region: 'card' | 'play' | 'queue';
}

export interface CanvasGridSnapshotQueue {
    getOrQueue: (
        item: GridItem,
        options: CanvasCardRenderOptions,
        onReady: () => void
    ) => CanvasGridItemSnapshot;
    clear: () => void;
    size: () => number;
}

interface SnapshotQueueOptions {
    createCanvas?: (width: number, height: number) => HTMLCanvasElement;
    loadImage?: (src: string) => Promise<CanvasImageSource | null>;
    snapshotScale?: number;
}

const SNAPSHOT_BATCH_SIZE = 3;
const DEFAULT_SNAPSHOT_SCALE = 1.5;
const CARD_PADDING = 12;
const PHOTO_RADIUS = 9;
const CARD_RADIUS = 12;

const toPlainText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return '';
};

const getCardTextLength = (item: GridItem, mode: GridViewMode): number => {
    let length = toPlainText(item.name).length;
    length += item.subtitle?.length ?? 0;
    length += item.description?.length ?? 0;
    if (mode === 'tracks' && item.rawTrack) {
        length += (item.rawTrack.al?.name || item.rawTrack.album?.name || '').length;
    }
    return length;
};

const getCardScaleFactor = (item: GridItem, mode: GridViewMode): number => {
    const textLength = getCardTextLength(item, mode);
    if (textLength > 100) return 1.18;
    if (textLength > 65) return 1.12;
    if (textLength > 35) return 1.06;
    return 1;
};

export const getCanvasGridCardSize = (
    item: GridItem,
    options: Pick<CanvasCardRenderOptions, 'cardWidth' | 'cardHeight' | 'mode'>
) => {
    const factor = getCardScaleFactor(item, options.mode);
    return {
        width: options.cardWidth * factor,
        height: options.cardHeight * factor,
    };
};

const makeSnapshotKey = (item: GridItem, options: CanvasCardRenderOptions): string => ([
    options.mode,
    item.id,
    item.coverUrl ?? '',
    toPlainText(item.name),
    item.subtitle ?? '',
    item.description ?? '',
    item.rawTrack?.al?.name ?? item.rawTrack?.album?.name ?? '',
    options.cardWidth,
    options.cardHeight,
    options.isDaylight ? 'light' : 'dark',
    options.backgroundColor,
    options.textColor,
].join('|'));

const roundedRect = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
) => {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
};

const drawClampedText = (
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number
) => {
    const tokens = /\s/.test(text)
        ? text.split(/(\s+)/).filter(Boolean).flatMap((token) => (
            context.measureText(token).width > maxWidth && !/\s/.test(token)
                ? Array.from(token)
                : [token]
        ))
        : Array.from(text);
    const lines: string[] = [];
    let line = '';

    for (const token of tokens.length > 0 ? tokens : [text]) {
        const next = line ? `${line}${token}` : token;
        if (context.measureText(next).width <= maxWidth || !line) {
            line = next;
            continue;
        }
        lines.push(line.trimEnd());
        line = token.trimStart();
        if (lines.length >= maxLines) break;
    }

    if (line && lines.length < maxLines) {
        lines.push(line.trimEnd());
    }

    for (let index = 0; index < lines.length; index++) {
        let value = lines[index];
        if (index === maxLines - 1 && lines.length === maxLines && context.measureText(value).width > maxWidth) {
            while (value.length > 1 && context.measureText(`${value}...`).width > maxWidth) {
                value = value.slice(0, -1);
            }
            value = `${value}...`;
        }
        context.fillText(value, x, y + index * lineHeight);
    }
};

const drawDiscPlaceholder = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    color: string
) => {
    context.save();
    context.globalAlpha = 0.22;
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, Math.min(size / 3, 30), 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, 5, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.restore();
};

const drawCoverImage = (
    context: CanvasRenderingContext2D,
    image: CanvasImageSource,
    x: number,
    y: number,
    size: number
) => {
    const sourceWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
    const sourceHeight = 'naturalHeight' in image ? image.naturalHeight : image.height;
    const sourceSize = Math.min(Number(sourceWidth) || size, Number(sourceHeight) || size);
    const sourceX = ((Number(sourceWidth) || sourceSize) - sourceSize) / 2;
    const sourceY = ((Number(sourceHeight) || sourceSize) - sourceSize) / 2;
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, x, y, size, size);
};

export const drawCanvasGridCardSnapshot = (
    context: CanvasRenderingContext2D,
    item: GridItem,
    options: CanvasCardRenderOptions,
    coverImage?: CanvasImageSource | null
) => {
    const { width, height } = getCanvasGridCardSize(item, options);
    context.clearRect(0, 0, width, height);

    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.18)';
    context.shadowBlur = 18;
    context.shadowOffsetY = 8;
    roundedRect(context, 0, 0, width, height, CARD_RADIUS);
    context.fillStyle = colorWithAlpha(options.backgroundColor, options.isDaylight ? 0.94 : 0.92);
    context.fill();
    context.restore();

    roundedRect(context, 0.5, 0.5, width - 1, height - 1, CARD_RADIUS);
    context.strokeStyle = colorWithAlpha(options.textColor, 0.08);
    context.lineWidth = 1;
    context.stroke();

    const photoX = CARD_PADDING;
    const photoY = CARD_PADDING;
    const photoSize = width - CARD_PADDING * 2;
    roundedRect(context, photoX, photoY, photoSize, photoSize, PHOTO_RADIUS);
    context.fillStyle = options.isDaylight ? 'rgba(228, 228, 231, 0.72)' : 'rgba(39, 39, 42, 0.72)';
    context.fill();
    context.save();
    roundedRect(context, photoX, photoY, photoSize, photoSize, PHOTO_RADIUS);
    context.clip();
    if (coverImage) {
        drawCoverImage(context, coverImage, photoX, photoY, photoSize);
    } else {
        drawDiscPlaceholder(context, photoX, photoY, photoSize, options.textColor);
    }
    context.restore();

    const labelX = CARD_PADDING;
    let textY = photoY + photoSize + 26;
    context.fillStyle = colorWithAlpha(options.textColor, 0.9);
    context.font = `700 ${Math.max(13, Math.round(width * 0.065))}px Inter, sans-serif`;
    context.textBaseline = 'alphabetic';
    drawClampedText(context, toPlainText(item.name), labelX, textY, width - CARD_PADDING * 2, 17, 3);

    textY += 58;
    if (item.description) {
        context.fillStyle = colorWithAlpha(options.textColor, 0.56);
        context.font = `600 ${Math.max(10, Math.round(width * 0.045))}px Inter, sans-serif`;
        drawClampedText(context, item.description, labelX, textY, width - CARD_PADDING * 2, 13, 2);
    }

    if (options.mode === 'tracks' && item.rawTrack) {
        const album = item.rawTrack.al?.name || item.rawTrack.album?.name || '';
        const duration = item.rawTrack.dt || item.rawTrack.duration || 0;
        const minutes = Math.floor(duration / 60000);
        const seconds = Math.floor((duration % 60000) / 1000);
        context.fillStyle = colorWithAlpha(options.textColor, 0.36);
        context.font = `500 ${Math.max(9, Math.round(width * 0.038))}px ui-monospace, monospace`;
        drawClampedText(context, album, labelX, height - 30, width - 94, 11, 1);
        context.fillText(`${minutes}:${seconds < 10 ? '0' : ''}${seconds}`, labelX, height - 14);
    }
};

export const resolveCanvasGridFrame = ({
    items,
    coords,
    dx,
    dy,
    frameOptions,
    renderOptions,
    overlayIndex,
    candidateIndexes,
}: {
    items: GridItem[];
    coords: HexGridCoord[];
    dx: number;
    dy: number;
    frameOptions: HexCardFrameOptions;
    renderOptions: CanvasCardRenderOptions;
    overlayIndex?: number | null;
    candidateIndexes?: readonly number[];
}): CanvasGridFrame => {
    const cards: CanvasGridFrameCard[] = [];
    let closestIndex = 0;
    let closestDistanceSq = Infinity;
    const indexes = candidateIndexes ?? items.map((_, index) => index);

    for (const index of indexes) {
        const coord = coords[index];
        const item = items[index];
        if (!coord || !item) continue;

        const frame = computeHexCardFrame(coord, dx, dy, frameOptions);
        if (frame.distanceSq < closestDistanceSq) {
            closestDistanceSq = frame.distanceSq;
            closestIndex = index;
        }
        if (!frame.visible || index === overlayIndex) continue;

        const { width, height } = getCanvasGridCardSize(item, renderOptions);
        cards.push({
            index,
            item,
            coord,
            frame,
            centerX: coord.baseX + dx,
            centerY: coord.baseY + dy,
            width,
            height,
            zIndex: Number(frame.zIndex),
        });
    }

    cards.sort((left, right) => left.zIndex - right.zIndex);
    return { cards, closestIndex };
};

const drawCanvasActionButton = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    opacity: number,
    label: 'play' | 'plus',
    textColor: string
) => {
    if (opacity <= 0) return;
    context.save();
    context.globalAlpha *= opacity;
    context.fillStyle = 'rgba(0, 0, 0, 0.10)';
    context.beginPath();
    context.arc(x, y, 18, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = colorWithAlpha(textColor, 0.12);
    context.stroke();
    context.fillStyle = colorWithAlpha(textColor, 0.82);
    context.lineWidth = 2;
    context.beginPath();
    if (label === 'play') {
        context.moveTo(x - 4, y - 7);
        context.lineTo(x - 4, y + 7);
        context.lineTo(x + 8, y);
        context.closePath();
        context.fill();
    } else {
        context.moveTo(x - 7, y);
        context.lineTo(x + 7, y);
        context.moveTo(x, y - 7);
        context.lineTo(x, y + 7);
        context.strokeStyle = colorWithAlpha(textColor, 0.82);
        context.stroke();
    }
    context.restore();
};

export const drawCanvasGridFrame = (
    context: CanvasRenderingContext2D,
    frame: CanvasGridFrame,
    snapshotQueue: CanvasGridSnapshotQueue,
    renderOptions: CanvasCardRenderOptions,
    requestRedraw: () => void,
    viewportSize?: { width: number; height: number }
) => {
    const width = viewportSize?.width ?? context.canvas.width;
    const height = viewportSize?.height ?? context.canvas.height;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);

    for (const card of frame.cards) {
        const snapshot = snapshotQueue.getOrQueue(card.item, renderOptions, requestRedraw);
        context.save();
        context.translate(card.centerX, card.centerY);
        context.scale(card.frame.scale, card.frame.scale);
        context.globalAlpha = Number(card.frame.opacity);
        context.drawImage(snapshot.canvas, -card.width / 2, -card.height / 2, card.width, card.height);

        if (renderOptions.mode === 'tracks') {
            const buttonY = card.height / 2 - 32;
            drawCanvasActionButton(context, card.width / 2 - 72, buttonY, Number(card.frame.playOpacity), 'play', renderOptions.textColor);
            drawCanvasActionButton(context, card.width / 2 - 30, buttonY, Number(card.frame.queueOpacity), 'plus', renderOptions.textColor);
        }
        context.restore();
    }

    context.restore();
};

export const hitTestCanvasGridCard = (
    cards: readonly CanvasGridFrameCard[],
    point: { x: number; y: number }
): CanvasCardHitTarget | null => {
    for (let index = cards.length - 1; index >= 0; index--) {
        const card = cards[index];
        const scale = Math.max(card.frame.scale, 0.001);
        const localX = (point.x - card.centerX) / scale;
        const localY = (point.y - card.centerY) / scale;
        if (Math.abs(localX) > card.width / 2 || Math.abs(localY) > card.height / 2) continue;

        if (Number(card.frame.playOpacity) > 0.1) {
            const playX = card.width / 2 - 72;
            const buttonY = card.height / 2 - 32;
            if ((localX - playX) ** 2 + (localY - buttonY) ** 2 <= 20 ** 2) {
                return { index: card.index, region: 'play' };
            }
        }

        if (Number(card.frame.queueOpacity) > 0.1) {
            const queueX = card.width / 2 - 30;
            const buttonY = card.height / 2 - 32;
            if ((localX - queueX) ** 2 + (localY - buttonY) ** 2 <= 20 ** 2) {
                return { index: card.index, region: 'queue' };
            }
        }

        return { index: card.index, region: 'card' };
    }

    return null;
};

const defaultCreateCanvas = (width: number, height: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
};

const defaultLoadImage = (src: string): Promise<CanvasImageSource | null> => (
    new Promise((resolve) => {
        const image = new Image();
        if (/^https?:\/\//i.test(src)) {
            image.crossOrigin = 'anonymous';
        }
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    })
);

export const createCanvasCardSnapshotQueue = ({
    createCanvas = defaultCreateCanvas,
    loadImage = defaultLoadImage,
    snapshotScale,
}: SnapshotQueueOptions = {}): CanvasGridSnapshotQueue => {
    const records = new Map<string, CanvasGridItemSnapshot>();
    const pending: Array<{
        item: GridItem;
        options: CanvasCardRenderOptions;
        record: CanvasGridItemSnapshot;
        onReady: () => void;
    }> = [];
    let scheduled = false;

    function paintSnapshot(
        record: CanvasGridItemSnapshot,
        item: GridItem,
        options: CanvasCardRenderOptions,
        image: CanvasImageSource | null
    ) {
        const context = record.canvas.getContext('2d');
        if (!context) return;
        const scale = Math.max(record.canvas.width / Math.max(record.width, 1), 1);
        context.setTransform?.(scale, 0, 0, scale, 0, 0);
        drawCanvasGridCardSnapshot(context, item, options, image);
    }

    const process = () => {
        scheduled = false;
        const batch = pending.splice(0, SNAPSHOT_BATCH_SIZE);
        for (const job of batch) {
            void loadImage(job.item.coverUrl || '').then((image) => {
                paintSnapshot(job.record, job.item, job.options, image);
                job.record.ready = true;
                job.onReady();
            });
        }

        if (pending.length > 0) {
            schedule();
        }
    };

    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => process();
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(run, { timeout: 120 });
        } else {
            window.setTimeout(run, 0);
        }
    };

    const resolveSnapshotScale = () => {
        if (snapshotScale !== undefined) {
            return Math.max(1, Math.min(2, snapshotScale));
        }
        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        return Math.max(DEFAULT_SNAPSHOT_SCALE, Math.min(2, dpr));
    };

    return {
        getOrQueue: (item, options, onReady) => {
            const key = makeSnapshotKey(item, options);
            const existing = records.get(key);
            if (existing) return existing;

            const { width, height } = getCanvasGridCardSize(item, options);
            const scale = resolveSnapshotScale();
            const canvas = createCanvas(width * scale, height * scale);

            const record: CanvasGridItemSnapshot = {
                key,
                canvas,
                width,
                height,
                ready: !item.coverUrl,
            };
            paintSnapshot(record, item, options, null);
            records.set(key, record);

            if (item.coverUrl) {
                pending.push({ item, options, record, onReady });
                schedule();
            }

            return record;
        },
        clear: () => {
            records.clear();
            pending.length = 0;
        },
        size: () => records.size,
    };
};

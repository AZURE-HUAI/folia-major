import { Sprite, Texture, type Container } from 'pixi.js';
import type {
    CanvasCardRenderOptions,
    CanvasGridFrame,
    CanvasGridSnapshotQueue,
} from './canvasGridRenderer';

// Manages Pixi sprite and texture reuse for the GPU-backed folia grid surface.
export interface PixiGridSpriteRecord {
    sprite: Sprite;
    texture: Texture;
    snapshotKey: string;
    snapshotReady: boolean;
}

export interface PixiGridSpritePool {
    records: Map<number, PixiGridSpriteRecord>;
}

export interface SyncPixiGridSpritesOptions {
    stage: Container;
    pool: PixiGridSpritePool;
    frame: CanvasGridFrame;
    snapshotQueue: CanvasGridSnapshotQueue;
    renderOptions: CanvasCardRenderOptions;
    viewportSize: { width: number; height: number };
    requestRedraw: () => void;
}

export const createPixiGridSpritePool = (): PixiGridSpritePool => ({
    records: new Map(),
});

const destroyPixiGridSpriteRecord = (record: PixiGridSpriteRecord): void => {
    record.sprite.removeFromParent();
    record.sprite.destroy();
    record.texture.destroy(true);
};

export const clearPixiGridSpritePool = (pool: PixiGridSpritePool): void => {
    for (const record of pool.records.values()) {
        destroyPixiGridSpriteRecord(record);
    }
    pool.records.clear();
};

const createSnapshotTexture = (canvas: HTMLCanvasElement): Texture => {
    const texture = Texture.from(canvas, true);
    texture.source.scaleMode = 'linear';
    return texture;
};

const createPixiCardSprite = (texture: Texture): Sprite => {
    const sprite = new Sprite({ texture, anchor: 0.5 });
    sprite.roundPixels = false;
    return sprite;
};

const replaceRecordTexture = (
    record: PixiGridSpriteRecord,
    texture: Texture,
    snapshotKey: string,
    snapshotReady: boolean
): void => {
    const previousTexture = record.texture;
    record.texture = texture;
    record.snapshotKey = snapshotKey;
    record.snapshotReady = snapshotReady;
    record.sprite.texture = texture;
    previousTexture.destroy(true);
};

// Synchronizes the visible Pixi sprite pool without allocating sprites in the drag hot path.
export const syncPixiGridSprites = ({
    stage,
    pool,
    frame,
    snapshotQueue,
    renderOptions,
    viewportSize,
    requestRedraw,
}: SyncPixiGridSpritesOptions): void => {
    const visibleIndexes = new Set<number>();
    const viewportCenterX = viewportSize.width / 2;
    const viewportCenterY = viewportSize.height / 2;

    for (const card of frame.cards) {
        const snapshot = snapshotQueue.getOrQueue(card.item, renderOptions, requestRedraw);
        let record = pool.records.get(card.index);

        if (!record) {
            const texture = createSnapshotTexture(snapshot.canvas);
            const sprite = createPixiCardSprite(texture);
            record = {
                sprite,
                texture,
                snapshotKey: snapshot.key,
                snapshotReady: snapshot.ready,
            };
            pool.records.set(card.index, record);
            stage.addChild(sprite);
        } else if (record.snapshotKey !== snapshot.key) {
            replaceRecordTexture(
                record,
                createSnapshotTexture(snapshot.canvas),
                snapshot.key,
                snapshot.ready
            );
        } else if (snapshot.ready && !record.snapshotReady) {
            record.texture.source.update();
            record.texture.update();
            record.snapshotReady = true;
        }

        const textureWidth = Math.max(record.texture.width, 1);
        const textureHeight = Math.max(record.texture.height, 1);
        const baseScaleX = card.width / textureWidth;
        const baseScaleY = card.height / textureHeight;
        const frameScale = Number(card.frame.scale);

        record.sprite.visible = true;
        record.sprite.alpha = Number(card.frame.opacity);
        record.sprite.zIndex = card.zIndex;
        record.sprite.position.set(
            viewportCenterX + card.centerX,
            viewportCenterY + card.centerY
        );
        record.sprite.scale.set(baseScaleX * frameScale, baseScaleY * frameScale);
        visibleIndexes.add(card.index);
    }

    for (const [index, record] of pool.records) {
        if (!visibleIndexes.has(index)) {
            record.sprite.visible = false;
        }
    }
};

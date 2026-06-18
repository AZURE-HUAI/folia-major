import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, type DragControls, type MotionValue } from 'framer-motion';
import { Application } from 'pixi.js';
import type { HexCardFrame, HexCardFrameOptions } from './hexCardTransform';
import { computeHexCardFrame } from './hexCardTransform';
import { pixelToCubeCenter, resolveVisibleHexIndexes, toCubeKey, type HexGridCoord } from './hexViewport';
import type { GridItem, GridLayoutConfig, GridViewMode } from './gridTypes';
import {
    createCanvasCardSnapshotQueue,
    hitTestCanvasGridCard,
    resolveCanvasGridFrame,
    type CanvasCardRenderOptions,
    type CanvasGridFrameCard,
} from './canvasGridRenderer';
import {
    clearPixiGridSpritePool,
    createPixiGridSpritePool,
    syncPixiGridSprites,
} from './pixiGridRenderer';
import type { Theme } from '../../types';

// Pixi-backed folia grid surface with GPU sprite transforms and focused/hovered DOM overlays.
export interface PixiGridOverlayRenderState {
    index: number;
    item: GridItem;
    frame: HexCardFrame;
    isFocused: boolean;
}

interface FoliaPixiGridSurfaceProps {
    items: GridItem[];
    coords: HexGridCoord[];
    containerSize: { width: number; height: number };
    layoutConfig: GridLayoutConfig;
    cardFrameOptions: HexCardFrameOptions;
    renderRadius: number;
    renderRing: number;
    mode: GridViewMode;
    isDaylight: boolean;
    theme: Theme;
    dragX: MotionValue<number>;
    dragY: MotionValue<number>;
    dragControls: DragControls;
    dragBounds: { left: number; right: number; top: number; bottom: number };
    focusedIndex: number;
    onFrameFocusedIndexChange: (index: number) => void;
    onDragStart: () => void;
    onDragEnd: () => void;
    onCenterIndex: (index: number) => void;
    onOpenIndex: (index: number) => void;
    renderOverlayCard: (state: PixiGridOverlayRenderState) => React.ReactNode;
}

const MAX_PIXI_DPR = 2;
const CLICK_MOVE_TOLERANCE = 6;

const getPixiDpr = (): number => (
    Math.min(MAX_PIXI_DPR, Math.max(1, window.devicePixelRatio || 1))
);

const getCssVarStyle = (frame: HexCardFrame): React.CSSProperties => ({
    '--queue-opacity': frame.queueOpacity,
    '--queue-pe': frame.queuePointerEvents,
    '--play-opacity': frame.playOpacity,
    '--play-scale': frame.playScale,
    '--play-pe': frame.playPointerEvents,
} as React.CSSProperties);

const setPixiCanvasStyle = (canvas: HTMLCanvasElement): void => {
    canvas.className = 'absolute inset-0 h-full w-full pointer-events-none';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
};

export const FoliaPixiGridSurface: React.FC<FoliaPixiGridSurfaceProps> = ({
    items,
    coords,
    containerSize,
    layoutConfig,
    cardFrameOptions,
    renderRadius,
    renderRing,
    mode,
    isDaylight,
    theme,
    dragX,
    dragY,
    dragControls,
    dragBounds,
    focusedIndex,
    onFrameFocusedIndexChange,
    onDragStart,
    onDragEnd,
    onCenterIndex,
    onOpenIndex,
    renderOverlayCard,
}) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const appRef = useRef<Application | null>(null);
    const rafRef = useRef<number | null>(null);
    const requestDrawRef = useRef<() => void>(() => undefined);
    const frameCardsRef = useRef<CanvasGridFrameCard[]>([]);
    const isDraggingRef = useRef(false);
    const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
    const snapshotQueueRef = useRef(createCanvasCardSnapshotQueue({ snapshotScale: 2 }));
    const spritePoolRef = useRef(createPixiGridSpritePool());
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const coordByKey = useMemo(() => (
        new Map(coords.map((coord) => [toCubeKey(coord.cube), coord.index]))
    ), [coords]);

    const renderOptions = useMemo<CanvasCardRenderOptions>(() => ({
        mode,
        cardWidth: layoutConfig.cardWidth,
        cardHeight: layoutConfig.cardHeight,
        isDaylight,
        theme,
        backgroundColor: theme.backgroundColor,
        textColor: theme.primaryColor,
    }), [
        isDaylight,
        layoutConfig.cardHeight,
        layoutConfig.cardWidth,
        mode,
        theme,
    ]);

    const overlayIndexes = useMemo(() => {
        if (isDragging || items.length === 0) return [];
        const indexes: number[] = [];
        if (focusedIndex >= 0 && focusedIndex < items.length) {
            indexes.push(focusedIndex);
        }
        if (
            hoveredIndex !== null &&
            hoveredIndex >= 0 &&
            hoveredIndex < items.length &&
            hoveredIndex !== focusedIndex
        ) {
            indexes.push(hoveredIndex);
        }
        return indexes;
    }, [focusedIndex, hoveredIndex, isDragging, items.length]);

    const draw = useCallback(() => {
        rafRef.current = null;
        const app = appRef.current;
        if (!app || containerSize.width <= 0 || containerSize.height <= 0) return;

        const nextWidth = Math.max(1, Math.floor(containerSize.width));
        const nextHeight = Math.max(1, Math.floor(containerSize.height));
        if (app.renderer.width !== nextWidth || app.renderer.height !== nextHeight) {
            app.renderer.resize(nextWidth, nextHeight);
        }

        const dx = dragX.get();
        const dy = dragY.get();
        const worldX = -dx;
        const worldY = -dy;
        const centerCube = pixelToCubeCenter(worldX, worldY, layoutConfig.spacingX, layoutConfig.spacingY);
        const candidateIndexes = resolveVisibleHexIndexes(
            centerCube,
            renderRing,
            coordByKey,
            coords,
            worldX,
            worldY,
            renderRadius
        );
        if (candidateIndexes.length === 0 && focusedIndex >= 0 && focusedIndex < items.length) {
            candidateIndexes.push(focusedIndex);
        }

        const frame = resolveCanvasGridFrame({
            items,
            coords,
            dx,
            dy,
            frameOptions: cardFrameOptions,
            renderOptions,
            overlayIndexes,
            candidateIndexes,
        });
        frameCardsRef.current = frame.cards;
        onFrameFocusedIndexChange(frame.closestIndex);

        syncPixiGridSprites({
            stage: app.stage,
            pool: spritePoolRef.current,
            frame,
            snapshotQueue: snapshotQueueRef.current,
            renderOptions,
            viewportSize: containerSize,
            requestRedraw: () => requestDrawRef.current(),
        });
        app.render();
    }, [
        cardFrameOptions,
        containerSize,
        coordByKey,
        coords,
        dragX,
        dragY,
        focusedIndex,
        items,
        layoutConfig.spacingX,
        layoutConfig.spacingY,
        onFrameFocusedIndexChange,
        overlayIndexes,
        renderOptions,
        renderRadius,
        renderRing,
    ]);

    const requestDraw = useCallback(() => {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(draw);
    }, [draw]);
    requestDrawRef.current = requestDraw;

    useEffect(() => {
        let cancelled = false;
        let initialized = false;
        const app = new Application();

        void app.init({
            width: Math.max(1, Math.floor(containerSize.width || 1)),
            height: Math.max(1, Math.floor(containerSize.height || 1)),
            resolution: getPixiDpr(),
            autoDensity: true,
            antialias: true,
            backgroundAlpha: 0,
            autoStart: false,
            preference: 'webgl',
            powerPreference: 'high-performance',
        }).then(() => {
            initialized = true;
            if (cancelled) {
                app.destroy(true, { children: true });
                return;
            }

            const host = hostRef.current;
            if (!host) {
                app.destroy(true, { children: true });
                return;
            }

            app.stage.sortableChildren = true;
            setPixiCanvasStyle(app.canvas);
            host.appendChild(app.canvas);
            appRef.current = app;
            requestDrawRef.current();
        }).catch((error) => {
            console.error('Failed to initialize Pixi grid surface', error);
        });

        return () => {
            cancelled = true;
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            if (appRef.current === app) {
                appRef.current = null;
            }
            clearPixiGridSpritePool(spritePoolRef.current);
            if (initialized) {
                app.destroy(true, { children: true });
            }
        };
    }, []);

    useEffect(() => {
        requestDraw();
        const unsubX = dragX.on('change', requestDraw);
        const unsubY = dragY.on('change', requestDraw);
        return () => {
            unsubX();
            unsubY();
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [dragX, dragY, requestDraw]);

    useEffect(() => {
        snapshotQueueRef.current.clear();
        clearPixiGridSpritePool(spritePoolRef.current);
        requestDrawRef.current();
    }, [renderOptions]);

    useEffect(() => {
        setHoveredIndex(null);
        for (const [index, record] of spritePoolRef.current.records) {
            if (index >= items.length) {
                record.sprite.removeFromParent();
                record.sprite.destroy();
                record.texture.destroy(true);
                spritePoolRef.current.records.delete(index);
            }
        }
        requestDrawRef.current();
    }, [items.length]);

    const getLocalPoint = useCallback((event: React.PointerEvent | React.MouseEvent) => {
        const host = hostRef.current;
        const rect = host?.getBoundingClientRect();
        if (!rect) return null;
        return {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2,
        };
    }, []);

    const updateHoverFromEvent = useCallback((event: React.PointerEvent) => {
        if (isDraggingRef.current) return;
        const point = getLocalPoint(event);
        if (!point) return;
        const hit = hitTestCanvasGridCard(frameCardsRef.current, point);
        setHoveredIndex(prev => (prev === (hit?.index ?? null) ? prev : (hit?.index ?? null)));
    }, [getLocalPoint]);

    const handleClick = useCallback((event: React.MouseEvent) => {
        if (isDraggingRef.current) return;
        const pointerDown = pointerDownRef.current;
        if (pointerDown) {
            const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
            if (moved > CLICK_MOVE_TOLERANCE) return;
        }
        const point = getLocalPoint(event);
        if (!point) return;
        const hit = hitTestCanvasGridCard(frameCardsRef.current, point);
        if (!hit) return;
        if (hit.index === focusedIndex) {
            onOpenIndex(hit.index);
        } else {
            onCenterIndex(hit.index);
        }
    }, [focusedIndex, getLocalPoint, onCenterIndex, onOpenIndex]);

    const overlayCards = overlayIndexes.map((index) => {
        const coord = coords[index];
        const item = items[index];
        if (!coord || !item) return null;
        const frame = computeHexCardFrame(coord, dragX.get(), dragY.get(), cardFrameOptions);
        if (!frame.visible) return null;
        return {
            index,
            coord,
            item,
            frame,
            isFocused: index === focusedIndex,
            isHovered: index === hoveredIndex,
        };
    }).filter((state): state is NonNullable<typeof state> => state !== null);

    return (
        <>
            <div
                ref={hostRef}
                className="absolute inset-0 pointer-events-none"
            />
            {overlayCards.map(({ index, coord, item, frame, isFocused, isHovered }) => (
                <motion.div
                    key={`${mode}-${index}-${item.id}`}
                    className="absolute pointer-events-auto select-none"
                    style={{
                        left: `calc(50% + ${coord.baseX}px)`,
                        top: `calc(50% + ${coord.baseY}px)`,
                        x: dragX,
                        y: dragY,
                        scale: frame.scale,
                        opacity: frame.opacity,
                        zIndex: isHovered ? 66 : 65,
                        transformOrigin: 'center center',
                        translate: '-50% -50%',
                        ...getCssVarStyle(frame),
                    } as React.CSSProperties}
                    onPointerEnter={() => setHoveredIndex(index)}
                    onPointerMove={() => setHoveredIndex(index)}
                    onPointerLeave={() => {
                        setHoveredIndex(prev => (prev === index ? null : prev));
                    }}
                >
                    {renderOverlayCard({
                        index,
                        item,
                        frame,
                        isFocused,
                    })}
                </motion.div>
            ))}
            <div
                className="absolute inset-0 z-[2] cursor-grab active:cursor-grabbing bg-transparent"
                style={{ touchAction: 'none' }}
                onPointerDown={(event) => {
                    pointerDownRef.current = { x: event.clientX, y: event.clientY };
                }}
                onPointerMove={updateHoverFromEvent}
                onPointerLeave={() => setHoveredIndex(null)}
                onClick={handleClick}
            />
            <motion.div
                drag
                dragListener={false}
                dragControls={dragControls}
                dragConstraints={dragBounds}
                dragElastic={0.05}
                dragTransition={{ power: 0.16, timeConstant: 220 }}
                onDragStart={() => {
                    setHoveredIndex(null);
                    isDraggingRef.current = true;
                    setIsDragging(true);
                    onDragStart();
                    requestDraw();
                }}
                onDragEnd={() => {
                    setTimeout(() => {
                        isDraggingRef.current = false;
                        setIsDragging(false);
                        onDragEnd();
                        requestDraw();
                    }, 50);
                }}
                style={{ x: dragX, y: dragY, touchAction: 'none' }}
                className="absolute inset-0 pointer-events-none"
            />
        </>
    );
};

export default FoliaPixiGridSurface;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, type DragControls, type MotionValue } from 'framer-motion';
import type { HexCardFrame, HexCardFrameOptions } from './hexCardTransform';
import { computeHexCardFrame } from './hexCardTransform';
import { pixelToCubeCenter, resolveVisibleHexIndexes, toCubeKey, type HexGridCoord } from './hexViewport';
import type { GridItem, GridLayoutConfig, GridViewMode } from './gridTypes';
import {
    createCanvasCardSnapshotQueue,
    drawCanvasGridFrame,
    hitTestCanvasGridCard,
    resolveCanvasGridFrame,
    type CanvasCardRenderOptions,
    type CanvasGridFrameCard,
} from './canvasGridRenderer';
import type { Theme } from '../../types';

// Canvas-backed folia grid surface with focused and hovered DOM card overlays for rich interaction.
export interface CanvasGridOverlayRenderState {
    index: number;
    item: GridItem;
    frame: HexCardFrame;
    isFocused: boolean;
}

interface FoliaCanvasGridSurfaceProps {
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
    renderOverlayCard: (state: CanvasGridOverlayRenderState) => React.ReactNode;
}

const MAX_CANVAS_DPR = 2;
const CLICK_MOVE_TOLERANCE = 6;

const getCssVarStyle = (frame: HexCardFrame): React.CSSProperties => ({
    '--queue-opacity': frame.queueOpacity,
    '--queue-pe': frame.queuePointerEvents,
    '--play-opacity': frame.playOpacity,
    '--play-scale': frame.playScale,
    '--play-pe': frame.playPointerEvents,
} as React.CSSProperties);

export const FoliaCanvasGridSurface: React.FC<FoliaCanvasGridSurfaceProps> = ({
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
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const requestDrawRef = useRef<() => void>(() => undefined);
    const frameCardsRef = useRef<CanvasGridFrameCard[]>([]);
    const isDraggingRef = useRef(false);
    const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const snapshotQueueRef = useRef(createCanvasCardSnapshotQueue());
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

    useEffect(() => {
        snapshotQueueRef.current.clear();
    }, [renderOptions]);

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
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context || containerSize.width <= 0 || containerSize.height <= 0) return;

        const dpr = Math.min(MAX_CANVAS_DPR, Math.max(1, window.devicePixelRatio || 1));
        const nextWidth = Math.max(1, Math.floor(containerSize.width * dpr));
        const nextHeight = Math.max(1, Math.floor(containerSize.height * dpr));
        if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
            canvas.width = nextWidth;
            canvas.height = nextHeight;
            canvas.style.width = `${containerSize.width}px`;
            canvas.style.height = `${containerSize.height}px`;
        }

        context.setTransform(dpr, 0, 0, dpr, 0, 0);
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
        drawCanvasGridFrame(
            context,
            frame,
            snapshotQueueRef.current,
            renderOptions,
            () => requestDrawRef.current(),
            containerSize
        );
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
        renderRadius,
        renderRing,
        renderOptions,
    ]);

    const requestDraw = useCallback(() => {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(draw);
    }, [draw]);
    requestDrawRef.current = requestDraw;

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

    const getLocalPoint = useCallback((event: React.PointerEvent | React.MouseEvent) => {
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
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
            <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full pointer-events-none"
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

export default FoliaCanvasGridSurface;

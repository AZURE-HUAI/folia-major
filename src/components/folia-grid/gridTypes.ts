import type React from 'react';
import type { SongResult } from '../../types';

// Shared GridView item contracts used by DOM and canvas folia grid surfaces.
export type GridViewMode = 'collection' | 'tracks';

export interface GridItem {
    id: string | number;
    name: React.ReactNode;
    searchText?: string;
    coverUrl?: string;
    subtitle?: string;
    description?: string;
    rawTrack?: SongResult;
    rawTrackIndex?: number;
    rawCollection?: any;
}

export interface GridLayoutConfig {
    cardWidth: number;
    cardHeight: number;
    spacingX: number;
    spacingY: number;
    maxDistance: number;
    lodStart: number;
    lodEnd: number;
}

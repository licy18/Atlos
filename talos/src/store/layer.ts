import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type LayerType = 'M' | 'B1' | 'B2' | 'B3' | 'B4' | 'L1' | 'L2' | 'L3' | 'L4';

const LAYER_TIER_MAP: Record<LayerType, number> = {
    M: 0,
    B1: -1,
    B2: -2,
    B3: -3,
    B4: -4,
    L1: 1,
    L2: 2,
    L3: 3,
    L4: 4,
};

interface LayerState {
    currentLayer: LayerType;
    setCurrentLayer: (layer: LayerType) => void;
}

export const useLayerStore = create<LayerState>()(
    persist(
        (set) => ({
            currentLayer: 'M',
            setCurrentLayer: (layer) => set({ currentLayer: layer }),
        }),
        {
            name: 'atlos-layer-storage',
        }
    )
);

export const useCurrentLayer = () => useLayerStore((state) => state.currentLayer);
export const useSetCurrentLayer = () => useLayerStore((state) => state.setCurrentLayer);

export const getLayerTier = (layer: LayerType): number => LAYER_TIER_MAP[layer];

export const getLayerByTier = (tier: number): LayerType | null => {
    const normalizedTier = Math.trunc(tier);
    const match = Object.entries(LAYER_TIER_MAP).find(([, value]) => value === normalizedTier);
    return match?.[0] as LayerType | undefined ?? null;
};

// Helper to convert layer type to tile suffix
export const getLayerTileSuffix = (layer: LayerType): string => {
    if (layer === 'M') return '';
    return `_${layer.toLowerCase()}`;
};

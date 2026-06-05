import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type LayerType = 'M' | 'B1' | 'B2' | 'B3' | 'B4' | 'L1' | 'L2' | 'L3' | 'L4';

const LAYER_TYPES = ['M', 'B1', 'B2', 'B3', 'B4', 'L1', 'L2', 'L3', 'L4'] as const satisfies readonly LayerType[];

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

export const getLayerTier = (layer: LayerType): number => {
    if (layer === 'M') return 0;
    const tier = Number(layer.slice(1));
    return layer.startsWith('B') ? -tier : tier;
};

export const getLayerByTier = (tier: number): LayerType | null => {
    const normalizedTier = Math.trunc(tier);
    const layer = normalizedTier === 0
        ? 'M'
        : `${normalizedTier < 0 ? 'B' : 'L'}${Math.abs(normalizedTier)}`;
    return LAYER_TYPES.includes(layer as LayerType) ? layer as LayerType : null;
};

// Helper to convert layer type to tile suffix
export const getLayerTileSuffix = (layer: LayerType): string => {
    if (layer === 'M') return '';
    return `_${layer.toLowerCase()}`;
};

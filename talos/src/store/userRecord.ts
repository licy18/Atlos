import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useUiPrefsStore } from './uiPrefs';
import { createConditionalStorage } from '@/utils/storage';
import { DATASET_VERSION } from '@/data/migration/version';

interface IUserRecordStore {
    activePoints: string[];
    datasetVersion: number;
    updatedAt: number;
    addPoint: (id: string) => void;
    deletePoint: (id: string) => void;
    clearPoints: () => void;
    setPoints: (ids: string[]) => void;
}

export const useUserRecordStore = create<IUserRecordStore>()(
    persist<IUserRecordStore, [], [], Partial<IUserRecordStore>>(
        (set, get) => ({
            activePoints: [],
            datasetVersion: DATASET_VERSION,
            updatedAt: Date.now(),
            addPoint: (id) => {
                if (get().activePoints.includes(id)) {
                    return;
                } else {
                    set((state) => ({
                        activePoints: [...state.activePoints, id],
                        datasetVersion: DATASET_VERSION,
                        updatedAt: Date.now(),
                    }));
                }
            },
            deletePoint: (id) => {
                if (!get().activePoints.includes(id)) {
                    return;
                } else {
                    set((state) => ({
                        activePoints: state.activePoints.filter(
                            (point) => point !== id,
                        ),
                        datasetVersion: DATASET_VERSION,
                        updatedAt: Date.now(),
                    }));
                }
            },
            clearPoints: () => {
                set({ activePoints: [], datasetVersion: DATASET_VERSION, updatedAt: Date.now() });
            },
            setPoints: (ids) => {
                set({
                    activePoints: [...new Set(ids.map((id) => String(id)).filter(Boolean))],
                    datasetVersion: DATASET_VERSION,
                    updatedAt: Date.now(),
                });
            },
        }),
        {
            name: 'points-storage',
            storage: createJSONStorage(() => createConditionalStorage(
                localStorage,
                () => useUiPrefsStore.getState().prefsMarkerProgressEnabled,
            )),
            partialize: (state) => ({
                activePoints: state.activePoints,
                datasetVersion: state.datasetVersion,
                updatedAt: state.updatedAt,
            }),
            merge: (persistedState, currentState) => {
                const persisted = persistedState as Partial<IUserRecordStore>;
                // Always restore persisted activePoints when they exist,
                // regardless of the current preference toggle. The preference
                // only controls whether *new* writes go to localStorage (via
                // createConditionalStorage).  We must never discard data from
                // localStorage during hydration — that would wipe the user's
                // progress silently if they toggle the setting off and on.
                if (persisted.activePoints && persisted.activePoints.length > 0) {
                    return {
                        ...currentState,
                        activePoints: persisted.activePoints,
                        updatedAt: persisted.updatedAt ?? currentState.updatedAt,
                    };
                }
                return currentState;
            },
        },
    ),
);

// Auto-restore when preference is enabled
useUiPrefsStore.subscribe((state, prevState) => {
    if (state.prefsMarkerProgressEnabled && !prevState.prefsMarkerProgressEnabled) {
        void useUserRecordStore.persist.rehydrate();
    }
});

export const useUserRecord = () => useUserRecordStore((state) => state.activePoints);
export const useAddPoint = () => useUserRecordStore((state) => state.addPoint);
export const useDeletePoint = () =>
    useUserRecordStore((state) => state.deletePoint);

// Non-hook accessors for non-React modules (e.g., Leaflet renderer)
// Returns empty array if preference is disabled
export const getActivePoints = () => {
    if (!useUiPrefsStore.getState().prefsMarkerProgressEnabled) return [];
    return useUserRecordStore.getState().activePoints;
};

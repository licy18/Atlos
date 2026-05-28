import { useCallback, useEffect, useRef } from 'react';
import SyncConflictModal, { type SyncConflictChoice } from '@/component/sync/conflict';
import { setProgressSyncRequestHandler } from '@/component/progressSync/progressSyncController';
import { useAuthStore } from '@/store/auth';
import { useProgressSyncStore, type CloudProgress } from '@/store/progressSync';
import { useUserRecordStore } from '@/store/userRecord';
import { getProgressManifestPayload, type ProgressManifestPayload } from '@/utils/progressBitmap';
import {
    fetchCloudProgress,
    ProgressSyncError,
    registerProgressManifest,
    syncCloudProgress,
} from '@/utils/progressSyncClient';

const MAX_DIRTY_MS = 60_000;
const COUNT_FLUSH_THRESHOLD = 10;

type SyncReason = 'startup' | 'auto' | 'manual' | 'visibility' | 'online' | 'conflict';
type ProgressBase = Pick<CloudProgress, 'revision' | 'markerIndexHash' | 'pointIds'>;

const normalizePointIds = (pointIds: string[]): string[] =>
    [...new Set(pointIds.map((id) => String(id)).filter(Boolean))];

const isRemoteEmpty = (progress: CloudProgress): boolean =>
    !progress.revision && progress.pointIds.length === 0;

const arePointSetsEqual = (first: string[], second: string[]): boolean => {
    if (first.length !== second.length) return false;
    const firstSet = new Set(first.map((id) => String(id)));
    if (firstSet.size !== second.length) return false;
    return second.every((id) => firstSet.has(String(id)));
};

const buildPointPatch = (basePointIds: string[], nextPointIds: string[]): {
    setPointIds: string[];
    clearPointIds: string[];
} => {
    const baseSet = new Set(basePointIds.map((id) => String(id)));
    const nextSet = new Set(nextPointIds.map((id) => String(id)));
    const setPointIds: string[] = [];
    const clearPointIds: string[] = [];

    nextSet.forEach((id) => {
        if (!baseSet.has(id)) setPointIds.push(id);
    });
    baseSet.forEach((id) => {
        if (!nextSet.has(id)) clearPointIds.push(id);
    });

    return { setPointIds, clearPointIds };
};

const countPointDelta = (before: string[], after: string[]): number => {
    const patch = buildPointPatch(before, after);
    return patch.setPointIds.length + patch.clearPointIds.length;
};

const buildMutationId = (): string => (
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const ProgressSyncHost = () => {
    const sessionUser = useAuthStore((state) => state.sessionUser);
    const baseline = useProgressSyncStore((state) => state.baseline);
    const conflict = useProgressSyncStore((state) => state.conflict);
    const setStatus = useProgressSyncStore((state) => state.setStatus);
    const setBaseline = useProgressSyncStore((state) => state.setBaseline);
    const setCounts = useProgressSyncStore((state) => state.setCounts);
    const setError = useProgressSyncStore((state) => state.setError);
    const setConflict = useProgressSyncStore((state) => state.setConflict);

    const maxTimerRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);
    const suppressLocalChangeRef = useRef(false);
    const dirtyCountRef = useRef(0);
    const baselineRef = useRef<ProgressBase | null>(baseline);
    const manifestRef = useRef<ProgressManifestPayload | null>(null);
    const sessionUidRef = useRef(sessionUser?.uid ?? null);

    useEffect(() => {
        baselineRef.current = baseline;
    }, [baseline]);

    useEffect(() => {
        sessionUidRef.current = sessionUser?.uid ?? null;
    }, [sessionUser?.uid]);

    const clearTimers = useCallback(() => {
        if (maxTimerRef.current !== null) {
            window.clearTimeout(maxTimerRef.current);
            maxTimerRef.current = null;
        }
    }, []);

    const ensureManifest = useCallback(async (): Promise<ProgressManifestPayload> => {
        const manifest = await getProgressManifestPayload();
        if (manifestRef.current?.markerIndexHash !== manifest.markerIndexHash) {
            await registerProgressManifest(manifest);
            manifestRef.current = manifest;
        }
        return manifest;
    }, []);

    const applyRemotePoints = useCallback((progress: CloudProgress) => {
        const remotePointIds = normalizePointIds(progress.pointIds);
        suppressLocalChangeRef.current = true;
        useUserRecordStore.getState().setPoints(remotePointIds);
        queueMicrotask(() => {
            suppressLocalChangeRef.current = false;
        });
        setCounts({ localPointCount: remotePointIds.length, remotePointCount: remotePointIds.length });
        setBaseline({ ...progress, pointIds: remotePointIds });
        setStatus('synced');
        setError(null);
    }, [setBaseline, setCounts, setError, setStatus]);

    const openConflict = useCallback((
        localPointIds: string[],
        remoteProgress: CloudProgress,
    ) => {
        const remotePointIds = normalizePointIds(remoteProgress.pointIds);
        setCounts({ localPointCount: localPointIds.length, remotePointCount: remotePointIds.length });
        setConflict({
            localPointIds,
            remotePointIds,
            localUpdatedAt: useUserRecordStore.getState().updatedAt,
            remoteUpdatedAt: remoteProgress.updatedAt,
            remoteProgress: { ...remoteProgress, pointIds: remotePointIds },
        });
    }, [setConflict, setCounts]);

    const syncNow = useCallback(async (
        reason: SyncReason,
        options: { keepalive?: boolean; forceBase?: ProgressBase; pointIds?: string[]; updatedAt?: number } = {},
    ) => {
        if (!sessionUidRef.current) return;
        if (inFlightRef.current) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false && !options.keepalive) {
            setStatus('offline');
            return;
        }

        inFlightRef.current = true;
        setStatus('syncing');
        setError(null);

        try {
            const manifest = await ensureManifest();
            const localState = useUserRecordStore.getState();
            const activePoints = normalizePointIds(options.pointIds ?? localState.activePoints);
            let base = options.forceBase ?? baselineRef.current;

            if (!base) {
                const { progress: remoteProgress } = await fetchCloudProgress();
                const remote = { ...remoteProgress, pointIds: normalizePointIds(remoteProgress.pointIds) };
                if (!isRemoteEmpty(remote) && !arePointSetsEqual(remote.pointIds, activePoints)) {
                    openConflict(activePoints, remote);
                    return;
                }
                setBaseline(remote);
                baselineRef.current = remote;
                base = remote;
            }

            if (base.markerIndexHash && base.markerIndexHash !== manifest.markerIndexHash) {
                throw new Error('Cloud progress uses a different marker index.');
            }

            if (
                arePointSetsEqual(base.pointIds, activePoints)
                && (reason === 'visibility' || reason === 'online' || reason === 'manual')
            ) {
                setCounts({ localPointCount: activePoints.length, remotePointCount: activePoints.length });
                setStatus('synced');
                dirtyCountRef.current = 0;
                clearTimers();
                return;
            }

            const patch = buildPointPatch(base.pointIds, activePoints);
            if (patch.setPointIds.length === 0 && patch.clearPointIds.length === 0) {
                setStatus('synced');
                dirtyCountRef.current = 0;
                clearTimers();
                return;
            }

            const response = await syncCloudProgress({
                baseRevision: base.revision,
                setPointIds: patch.setPointIds,
                clearPointIds: patch.clearPointIds,
                clientMutationId: buildMutationId(),
                updatedAt: options.updatedAt ?? localState.updatedAt,
            }, {
                keepalive: options.keepalive,
            });

            const nextProgress = {
                ...response.progress,
                pointIds: activePoints,
            };
            setBaseline(nextProgress);
            baselineRef.current = nextProgress;
            setCounts({ localPointCount: activePoints.length, remotePointCount: nextProgress.pointIds.length });
            setStatus('synced');
            setError(null);
            dirtyCountRef.current = 0;
            clearTimers();
            void reason;
        } catch (error) {
            if (error instanceof ProgressSyncError && error.status === 409 && error.current) {
                openConflict(useUserRecordStore.getState().activePoints, error.current);
                return;
            }

            setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error');
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            inFlightRef.current = false;
        }
    }, [clearTimers, ensureManifest, openConflict, setBaseline, setCounts, setError, setStatus]);

    const checkRemoteAndReconcile = useCallback(async () => {
        if (!sessionUidRef.current) return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setStatus('checking');
        setError(null);

        try {
            await ensureManifest();
            const { progress: remoteProgress } = await fetchCloudProgress();
            const remote = { ...remoteProgress, pointIds: normalizePointIds(remoteProgress.pointIds) };
            const localPointIds = normalizePointIds(useUserRecordStore.getState().activePoints);
            setCounts({ localPointCount: localPointIds.length, remotePointCount: remote.pointIds.length });

            if (isRemoteEmpty(remote)) {
                setBaseline(remote);
                baselineRef.current = remote;
                if (localPointIds.length > 0) {
                    inFlightRef.current = false;
                    await syncNow('startup', { forceBase: remote });
                    return;
                }
                setStatus('synced');
                return;
            }

            if (arePointSetsEqual(localPointIds, remote.pointIds)) {
                setBaseline(remote);
                baselineRef.current = remote;
                setStatus('synced');
                return;
            }

            const currentBaseline = baselineRef.current;
            if (currentBaseline && arePointSetsEqual(localPointIds, currentBaseline.pointIds)) {
                applyRemotePoints(remote);
                return;
            }

            if (
                currentBaseline
                && (remote.revision === currentBaseline.revision || arePointSetsEqual(remote.pointIds, currentBaseline.pointIds))
            ) {
                setBaseline(remote);
                baselineRef.current = remote;
                inFlightRef.current = false;
                await syncNow('startup', { forceBase: remote });
                return;
            }

            openConflict(localPointIds, remote);
        } catch (error) {
            setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error');
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            inFlightRef.current = false;
        }
    }, [applyRemotePoints, ensureManifest, openConflict, setBaseline, setCounts, setError, setStatus, syncNow]);

    const scheduleSync = useCallback((changedPoints: number) => {
        if (!sessionUidRef.current) return;
        if (suppressLocalChangeRef.current) return;
        if (changedPoints <= 0) return;
        dirtyCountRef.current += changedPoints;
        setStatus('dirty');
        setCounts({ localPointCount: useUserRecordStore.getState().activePoints.length });

        if (dirtyCountRef.current >= COUNT_FLUSH_THRESHOLD) {
            clearTimers();
            void syncNow('auto');
            return;
        }

        if (maxTimerRef.current === null) {
            maxTimerRef.current = window.setTimeout(() => {
                maxTimerRef.current = null;
                void syncNow('auto');
            }, MAX_DIRTY_MS);
        }
    }, [clearTimers, setCounts, setStatus, syncNow]);

    useEffect(() => {
        if (!sessionUser?.uid) return;
        void checkRemoteAndReconcile();
    }, [checkRemoteAndReconcile, sessionUser?.uid]);

    useEffect(() => {
        const unsubscribe = useUserRecordStore.subscribe((state, prevState) => {
            if (state.updatedAt === prevState.updatedAt) return;
            scheduleSync(countPointDelta(prevState.activePoints, state.activePoints));
        });
        return unsubscribe;
    }, [scheduleSync]);

    useEffect(() => {
        setProgressSyncRequestHandler(async () => {
            await syncNow('manual');
        });
        return () => {
            setProgressSyncRequestHandler(null);
        };
    }, [syncNow]);

    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'hidden') {
                void syncNow('visibility', { keepalive: true });
            } else if (document.visibilityState === 'visible') {
                void syncNow('visibility');
            }
        };
        const handlePageHide = () => {
            void syncNow('visibility', { keepalive: true });
        };
        const handleOnline = () => {
            void syncNow('online');
        };

        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('online', handleOnline);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('pagehide', handlePageHide);
            window.removeEventListener('online', handleOnline);
        };
    }, [syncNow]);

    const handleConflictResolve = useCallback((choice: SyncConflictChoice) => {
        if (!conflict) return;
        const remoteBase = conflict.remoteProgress;
        const pointIds = choice === 'a'
            ? conflict.localPointIds
            : choice === 'b'
                ? conflict.remotePointIds
                : [...new Set([...conflict.localPointIds, ...conflict.remotePointIds])];

        if (choice === 'b') {
            applyRemotePoints(remoteBase);
            setConflict(null);
            return;
        }

        setBaseline(remoteBase);
        baselineRef.current = remoteBase;
        suppressLocalChangeRef.current = true;
        useUserRecordStore.getState().setPoints(pointIds);
        const updatedAt = useUserRecordStore.getState().updatedAt;
        queueMicrotask(() => {
            suppressLocalChangeRef.current = false;
        });
        setConflict(null);
        void syncNow('conflict', { forceBase: remoteBase, pointIds, updatedAt });
    }, [applyRemotePoints, conflict, setBaseline, setConflict, syncNow]);

    return conflict ? (
        <SyncConflictModal
            open
            sourceA={{
                side: 'local',
                updatedAt: conflict.localUpdatedAt,
                pointIds: conflict.localPointIds,
            }}
            sourceB={{
                side: 'remote',
                remoteSource: 'oemDb',
                updatedAt: conflict.remoteUpdatedAt,
                pointIds: conflict.remotePointIds,
            }}
            onClose={() => setConflict(null)}
            onResolve={handleConflictResolve}
        />
    ) : null;
};

export default ProgressSyncHost;

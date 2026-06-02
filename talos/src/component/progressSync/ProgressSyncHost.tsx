import { useCallback, useEffect, useRef, useState } from 'react';
import SyncConflictModal, { type SyncConflictChoice } from '@/component/sync/conflict';
import { setProgressSyncRequestHandler } from '@/component/progressSync/progressSyncController';
import { useAuthStore } from '@/store/auth';
import { useProgressSyncStore, type CloudProgress, type ProgressConflictState } from '@/store/progressSync';
import { useUserRecordStore } from '@/store/userRecord';
import { getProgressManifestPayload, getProgressMarkerIndex, type ProgressManifestPayload } from '@/utils/progressBitmap';
import {
    fetchCloudProgress,
    ProgressSyncError,
    registerProgressManifest,
    syncCloudProgress,
} from '@/utils/progressSyncClient';

const MAX_DIRTY_MS = 60_000;
const COUNT_FLUSH_THRESHOLD = 10;
const MODAL_EXIT_DURATION_MS = 325;

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

const splitByKnownPointIds = (pointIds: string[], knownPointIds: Set<string>): {
    known: string[];
    unknown: string[];
} => {
    const known: string[] = [];
    const unknown: string[] = [];
    normalizePointIds(pointIds).forEach((pointId) => {
        if (knownPointIds.has(pointId)) {
            known.push(pointId);
        } else {
            unknown.push(pointId);
        }
    });
    return { known, unknown };
};

const mergeVisibleWithLocalUnknown = (
    visiblePointIds: string[],
    localPointIds: string[],
    knownPointIds: Set<string>,
): string[] => {
    const localUnknownPointIds = splitByKnownPointIds(localPointIds, knownPointIds).unknown;
    return normalizePointIds([...visiblePointIds, ...localUnknownPointIds]);
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
    const conflictCleanupTimerRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);
    const suppressLocalChangeRef = useRef(false);
    const dirtyCountRef = useRef(0);
    const baselineRef = useRef<ProgressBase | null>(baseline);
    const manifestRef = useRef<ProgressManifestPayload | null>(null);
    const knownPointIdsRef = useRef<Set<string>>(new Set());
    const sessionUidRef = useRef(sessionUser?.uid ?? null);
    const [renderedConflict, setRenderedConflict] = useState<ProgressConflictState | null>(conflict);
    const [conflictOpen, setConflictOpen] = useState(Boolean(conflict));

    useEffect(() => {
        baselineRef.current = baseline;
    }, [baseline]);

    useEffect(() => {
        sessionUidRef.current = sessionUser?.uid ?? null;
    }, [sessionUser?.uid]);

    useEffect(() => {
        if (conflictCleanupTimerRef.current !== null) {
            window.clearTimeout(conflictCleanupTimerRef.current);
            conflictCleanupTimerRef.current = null;
        }

        if (conflict) {
            setRenderedConflict(conflict);
            setConflictOpen(true);
            return;
        }

        setConflictOpen(false);
        conflictCleanupTimerRef.current = window.setTimeout(() => {
            setRenderedConflict(null);
            conflictCleanupTimerRef.current = null;
        }, MODAL_EXIT_DURATION_MS);
    }, [conflict]);

    useEffect(() => () => {
        if (conflictCleanupTimerRef.current !== null) {
            window.clearTimeout(conflictCleanupTimerRef.current);
        }
    }, []);

    const clearTimers = useCallback(() => {
        if (maxTimerRef.current !== null) {
            window.clearTimeout(maxTimerRef.current);
            maxTimerRef.current = null;
        }
    }, []);

    const ensureManifest = useCallback(async (): Promise<ProgressManifestPayload> => {
        const markerIndex = await getProgressMarkerIndex();
        knownPointIdsRef.current = new Set(markerIndex.pointIds);
        const manifest = await getProgressManifestPayload();
        if (manifestRef.current?.markerIndexHash !== manifest.markerIndexHash) {
            await registerProgressManifest(manifest);
            manifestRef.current = manifest;
        }
        return manifest;
    }, []);

    const applyRemotePoints = useCallback((progress: CloudProgress) => {
        const remotePointIds = splitByKnownPointIds(progress.pointIds, knownPointIdsRef.current).known;
        const nextLocalPointIds = mergeVisibleWithLocalUnknown(
            remotePointIds,
            useUserRecordStore.getState().activePoints,
            knownPointIdsRef.current,
        );
        suppressLocalChangeRef.current = true;
        useUserRecordStore.getState().setPoints(nextLocalPointIds);
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
        const remotePointIds = splitByKnownPointIds(remoteProgress.pointIds, knownPointIdsRef.current).known;
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
            const knownPointIds = knownPointIdsRef.current;
            const localPointIds = normalizePointIds(options.pointIds ?? localState.activePoints);
            const { known: activePoints, unknown: retainedLocalPointIds } = splitByKnownPointIds(localPointIds, knownPointIds);
            let base = options.forceBase ?? baselineRef.current;

            if (!base) {
                const { progress: remoteProgress } = await fetchCloudProgress();
                const remote = { ...remoteProgress, pointIds: splitByKnownPointIds(remoteProgress.pointIds, knownPointIds).known };
                if (!isRemoteEmpty(remote) && !arePointSetsEqual(remote.pointIds, activePoints)) {
                    openConflict(activePoints, remote);
                    return;
                }
                setBaseline(remote);
                baselineRef.current = remote;
                base = remote;
            }

            const basePointIds = splitByKnownPointIds(base.pointIds, knownPointIds).known;
            const markerIndexChanged = Boolean(base.markerIndexHash && base.markerIndexHash !== manifest.markerIndexHash);

            if (
                arePointSetsEqual(basePointIds, activePoints)
                && retainedLocalPointIds.length === 0
                && !markerIndexChanged
                && (reason === 'visibility' || reason === 'online' || reason === 'manual')
            ) {
                setCounts({ localPointCount: activePoints.length, remotePointCount: activePoints.length });
                setStatus('synced');
                dirtyCountRef.current = 0;
                clearTimers();
                return;
            }

            const patch = buildPointPatch(basePointIds, activePoints);
            const setPointIds = normalizePointIds([...patch.setPointIds, ...retainedLocalPointIds]);
            if (setPointIds.length === 0 && patch.clearPointIds.length === 0 && !markerIndexChanged) {
                setStatus('synced');
                dirtyCountRef.current = 0;
                clearTimers();
                return;
            }

            const response = await syncCloudProgress({
                baseRevision: base.revision,
                setPointIds,
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
                openConflict(
                    splitByKnownPointIds(useUserRecordStore.getState().activePoints, knownPointIdsRef.current).known,
                    error.current,
                );
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
            const knownPointIds = knownPointIdsRef.current;
            const remote = { ...remoteProgress, pointIds: splitByKnownPointIds(remoteProgress.pointIds, knownPointIds).known };
            const localStatePointIds = normalizePointIds(useUserRecordStore.getState().activePoints);
            const { known: localPointIds, unknown: retainedLocalPointIds } = splitByKnownPointIds(localStatePointIds, knownPointIds);
            setCounts({ localPointCount: localPointIds.length, remotePointCount: remote.pointIds.length });

            if (isRemoteEmpty(remote)) {
                setBaseline(remote);
                baselineRef.current = remote;
                if (localPointIds.length > 0 || retainedLocalPointIds.length > 0) {
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
                if (
                    (remote.markerIndexHash && remote.markerIndexHash !== manifestRef.current?.markerIndexHash)
                    || retainedLocalPointIds.length > 0
                ) {
                    inFlightRef.current = false;
                    await syncNow('startup', { forceBase: remote });
                    return;
                }
                setStatus('synced');
                return;
            }

            const currentBaseline = baselineRef.current;
            if (currentBaseline && arePointSetsEqual(localPointIds, splitByKnownPointIds(currentBaseline.pointIds, knownPointIds).known)) {
                applyRemotePoints(remote);
                return;
            }

            if (
                currentBaseline
                && (
                    remote.revision === currentBaseline.revision
                    || arePointSetsEqual(remote.pointIds, splitByKnownPointIds(currentBaseline.pointIds, knownPointIds).known)
                )
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
        setCounts({
            localPointCount: splitByKnownPointIds(
                useUserRecordStore.getState().activePoints,
                knownPointIdsRef.current,
            ).known.length,
        });

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
        const activeConflict = conflict ?? renderedConflict;
        if (!activeConflict) return;
        const remoteBase = activeConflict.remoteProgress;
        const knownPointIds = knownPointIdsRef.current;
        const localUnknownPointIds = splitByKnownPointIds(
            useUserRecordStore.getState().activePoints,
            knownPointIds,
        ).unknown;
        const pointIds = choice === 'a'
            ? activeConflict.localPointIds
            : choice === 'b'
                ? activeConflict.remotePointIds
                : [...new Set([...activeConflict.localPointIds, ...activeConflict.remotePointIds])];

        if (choice === 'b') {
            applyRemotePoints(remoteBase);
            setConflict(null);
            return;
        }

        setBaseline(remoteBase);
        baselineRef.current = remoteBase;
        suppressLocalChangeRef.current = true;
        useUserRecordStore.getState().setPoints(normalizePointIds([...pointIds, ...localUnknownPointIds]));
        const updatedAt = useUserRecordStore.getState().updatedAt;
        queueMicrotask(() => {
            suppressLocalChangeRef.current = false;
        });
        setConflict(null);
        void syncNow('conflict', {
            forceBase: remoteBase,
            pointIds: normalizePointIds([...pointIds, ...localUnknownPointIds]),
            updatedAt,
        });
    }, [applyRemotePoints, conflict, renderedConflict, setBaseline, setConflict, syncNow]);

    return renderedConflict ? (
        <SyncConflictModal
            open={conflictOpen}
            sourceA={{
                side: 'local',
                updatedAt: renderedConflict.localUpdatedAt,
                pointIds: renderedConflict.localPointIds,
            }}
            sourceB={{
                side: 'remote',
                remoteSource: 'oemDb',
                updatedAt: renderedConflict.remoteUpdatedAt,
                pointIds: renderedConflict.remotePointIds,
            }}
            onClose={() => setConflict(null)}
            onResolve={handleConflictResolve}
        />
    ) : null;
};

export default ProgressSyncHost;

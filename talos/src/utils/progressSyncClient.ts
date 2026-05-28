import { getAuthBase, getAuthHeaders } from '@/component/login/authFlow';
import type { CloudProgress } from '@/store/progressSync';
import type { ProgressManifestPayload } from '@/utils/progressBitmap';

const PROGRESS_API_BASE = `${getAuthBase()}/progress/v1`;

type CloudProgressMeta = Pick<CloudProgress, 'revision' | 'markerIndexHash' | 'updatedAt'>;

type ApiErrorPayload = {
    code?: string;
    message?: string;
    details?: unknown;
    current?: CloudProgress;
    error?: {
        code?: string;
        message?: string;
        details?: unknown;
    };
};

export class ProgressSyncError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: unknown;
    readonly current?: CloudProgress;

    constructor(message: string, options: { status: number; code: string; details?: unknown; current?: CloudProgress }) {
        super(message);
        this.name = 'ProgressSyncError';
        this.status = options.status;
        this.code = options.code;
        this.details = options.details;
        this.current = options.current;
    }
}

const readApiError = async (response: Response): Promise<ProgressSyncError> => {
    try {
        const payload = await response.json() as ApiErrorPayload;
        const code = payload.code || payload.error?.code || `HTTP_${response.status}`;
        const details = payload.details ?? payload.error?.details;
        const current = payload.current
            ?? (details && typeof details === 'object' && 'current' in details
                ? (details as { current?: CloudProgress }).current
                : undefined);
        return new ProgressSyncError(payload.message || payload.error?.message || code, {
            status: response.status,
            code,
            details,
            current,
        });
    } catch {
        return new ProgressSyncError(`HTTP ${response.status}`, {
            status: response.status,
            code: `HTTP_${response.status}`,
        });
    }
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const hasBody = init?.body !== undefined && init.body !== null;
    const response = await fetch(`${PROGRESS_API_BASE}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
            accept: 'application/json',
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...getAuthHeaders(),
            ...(init?.headers ?? {}),
        },
    });

    if (!response.ok) {
        throw await readApiError(response);
    }

    return response.json() as Promise<T>;
}

export const fetchCloudProgress = (): Promise<{ progress: CloudProgress }> =>
    requestJson('/state');

export const registerProgressManifest = (
    payload: ProgressManifestPayload,
): Promise<{ ok: true; manifest: { markerIndexHash: string } }> =>
    requestJson('/manifest', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

export const syncCloudProgress = (
    payload: {
        baseRevision: string;
        clientMutationId: string;
        setPointIds: string[];
        clearPointIds: string[];
        updatedAt: number;
    },
    options: { keepalive?: boolean } = {},
): Promise<{ ok: true; progress: CloudProgressMeta; unchanged?: boolean; idempotent?: boolean }> =>
    requestJson('/sync', {
        method: 'POST',
        body: JSON.stringify(payload),
        keepalive: options.keepalive,
    });

export const fetchProgressStats = (
    markerIndexHash: string,
): Promise<{
    markerIndexHash: string;
    totalSyncedUsers: number;
    sampleSize: number;
    counts: string;
    updatedAt: number | null;
}> => requestJson(`/stats?markerIndexHash=${encodeURIComponent(markerIndexHash)}`);

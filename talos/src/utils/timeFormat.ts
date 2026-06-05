export const parseDateLike = (value?: string | number | null): Date | null => {
    if (value === undefined || value === null || value === '') return null;

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        const ms = value < 1_000_000_000_000 ? value * 1000 : value;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const raw = value.trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) return null;
        const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(normalized);
    if (!hasTimezone) {
        const utcParsed = new Date(`${normalized}Z`);
        return Number.isNaN(utcParsed.getTime()) ? null : utcParsed;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const formatDateYYYYMMDD = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const formatDateTimeYYYYMMDDHHMMSS = (date: Date): string => {
    const dateLabel = formatDateYYYYMMDD(date);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${dateLabel} ${hours}:${minutes}:${seconds}`;
};

export const formatElapsedShort = (fromMs: number, nowMs: number): string => {
    const diffSec = Math.max(0, Math.floor((nowMs - fromMs) / 1000));

    if (diffSec < 60) {
        return `${diffSec}s`;
    }

    if (diffSec < 60 * 60) {
        const minutes = Math.floor(diffSec / 60);
        return `${minutes}m`;
    }

    if (diffSec < 24 * 60 * 60) {
        const hours = Math.floor(diffSec / (60 * 60));
        return `${hours}hr`;
    }

    const days = Math.floor(diffSec / (24 * 60 * 60));
    return `${days}d`;
};

export type DateTimePrecision = 'date' | 'dateTime';

export type AgoDisplay = 'none' | 'inline' | 'hover';

export interface FormattedRelativeTime {
    label: string;
    hoverLabel: string;
    agoText: string;
}

export const formatRelativeTime = (
    date: Date,
    {
        precision = 'dateTime',
        agoDisplay = 'none',
        nowMs = Date.now(),
        agoLabel = 'ago',
    }: {
        precision?: DateTimePrecision;
        agoDisplay?: AgoDisplay;
        nowMs?: number;
        agoLabel?: string;
    } = {},
): FormattedRelativeTime => {
    const label = precision === 'date'
        ? formatDateYYYYMMDD(date)
        : formatDateTimeYYYYMMDDHHMMSS(date);
    const agoText = `${formatElapsedShort(date.getTime(), nowMs)} ${agoLabel}`;

    if (agoDisplay === 'inline') {
        return {
            label: `${label} (${agoText})`,
            hoverLabel: '',
            agoText,
        };
    }

    if (agoDisplay === 'hover') {
        return {
            label,
            hoverLabel: agoText,
            agoText,
        };
    }

    return {
        label,
        hoverLabel: '',
        agoText,
    };
};

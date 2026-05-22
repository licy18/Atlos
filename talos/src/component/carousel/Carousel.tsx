import React, { useCallback, useMemo } from 'react';

type CarouselRenderState<T> = {
    item: T | null;
    index: number;
    count: number;
    hasMultiple: boolean;
    previous: () => void;
    next: () => void;
};

type CarouselProps<T> = {
    items: T[];
    selectedKey?: string | null;
    getKey: (item: T) => string;
    onSelectedKeyChange?: (key: string) => void;
    children: (state: CarouselRenderState<T>) => React.ReactNode;
};

function Carousel<T>({
    items,
    selectedKey,
    getKey,
    onSelectedKeyChange,
    children,
}: CarouselProps<T>) {
    const count = items.length;
    const index = useMemo(() => {
        if (count === 0) return -1;
        const selectedIndex = selectedKey
            ? items.findIndex((item) => getKey(item) === selectedKey)
            : -1;
        return selectedIndex >= 0 ? selectedIndex : 0;
    }, [count, getKey, items, selectedKey]);

    const selectIndex = useCallback((nextIndex: number) => {
        if (count === 0) return;
        const normalizedIndex = (nextIndex + count) % count;
        onSelectedKeyChange?.(getKey(items[normalizedIndex]));
    }, [count, getKey, items, onSelectedKeyChange]);

    const previous = useCallback(() => {
        selectIndex(index - 1);
    }, [index, selectIndex]);

    const next = useCallback(() => {
        selectIndex(index + 1);
    }, [index, selectIndex]);

    return (
        <>
            {children({
                item: index >= 0 ? items[index] : null,
                index,
                count,
                hasMultiple: count > 1,
                previous,
                next,
            })}
        </>
    );
}

export default Carousel;

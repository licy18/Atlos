let requestHandler: (() => Promise<void>) | null = null;

export const setProgressSyncRequestHandler = (handler: (() => Promise<void>) | null): void => {
    requestHandler = handler;
};

export const requestProgressSyncNow = async (): Promise<void> => {
    await requestHandler?.();
};

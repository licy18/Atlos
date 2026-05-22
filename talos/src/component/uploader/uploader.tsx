import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import classNames from 'classnames';
import styles from './uploader.module.scss';
import Viewer from '../detail/viewer/viewer';
import { getAnnouncementLocaleKey } from '@/utils/announcement';
import { openOemAuthModal } from '@/component/login/authEvents';
import { useAuthStore } from '@/store/auth';
import { useLocale, useTranslateUI } from '@/locale';
import type { IMarkerData } from '@/data/marker';
import { usePointShareLink } from '@/utils/shareLink';
import { getAppDocument, subscribePictureInPictureState } from '@/component/scale/pip';
import { Shortcut, type KeyChip } from '@/component/shortcut';
import { modKey } from '@/component/settings/shortcuts';
import Carousel from '@/component/carousel';
import {
    listUGCImages,
    listUGCMyImages,
    resolveUGCUploadTarget,
    toggleUGCImageFlag,
    toggleUGCImageRecall,
    toggleUGCImageUpvote,
    uploadUGCImage,
    UGCClientError,
    type UGCImage,
    type UGCImageActionPatch,
    type UGCSubmissionImage,
    type UGCUploadSubmission,
} from '@/utils/ugcClient';

type Props = {
    point: IMarkerData;
    pointName: string;
    active?: boolean;
};

type ImageState = 'noImage' | 'pending' | 'hasImage';

const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif';
const UPLOAD_KEY_SCALE = 0.75;
const UPLOAD_CLICK_KEYS: KeyChip[] = [{ label: '', type: 'left-click', size: '1u' }];

const hasDraggedFiles = (event: React.DragEvent<HTMLDivElement>): boolean => (
    Array.from(event.dataTransfer.types).includes('Files')
);

type CarouselDirection = 'previous' | 'next';

const getCarouselDirection = (
    rect: DOMRect,
    clientX: number,
    clientY: number,
    controlWidthRatio: number,
    controlHeightRatio: number,
    offsetRatio: number,
): CarouselDirection | null => {
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const controlWidth = rect.width * controlWidthRatio;
    const controlHeight = controlWidth * controlHeightRatio;
    const offset = rect.width * offsetRatio;
    const top = (rect.height - controlHeight) / 2;
    const bottom = top + controlHeight;

    if (y < top || y > bottom) return null;
    if (x >= offset && x <= offset + controlWidth) return 'previous';
    if (x >= rect.width - offset - controlWidth && x <= rect.width - offset) return 'next';
    return null;
};

const isPending = (image: UGCSubmissionImage): boolean => (
    image.status === 'pending_openai' || image.status === 'pending_audit'
);

const isPublic = (image: UGCSubmissionImage): boolean => (
    image.status === 'active' || image.status === 'flagged' || image.status === 'remove_request'
);

const getUpvoteCount = (image: UGCImage): number => (
    Number.isFinite(image.upvotes)
        ? Math.max(0, image.upvotes as number)
        : Number.isFinite(image.upvoteCount)
            ? Math.max(0, image.upvoteCount as number)
            : 0
);

const getImageCreatedAtTime = (image: UGCImage): number => {
    const time = Date.parse(image.createdAt);
    return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
};

const isActionConflict = (err: unknown): boolean => (
    err instanceof UGCClientError && err.status === 409
);

const useUpload = (point: IMarkerData) => {
    const tUI = useTranslateUI();
    const locale = useLocale();
    const user = useAuthStore((state) => state.sessionUser);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const target = useMemo(() => resolveUGCUploadTarget(point), [point]);
    const [images, setImages] = useState<UGCImage[]>([]);
    const [myImages, setMyImages] = useState<UGCSubmissionImage[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [viewerOpen, setViewerOpen] = useState(false);
    const [pendingLoginUpload, setPendingLoginUpload] = useState(false);
    const [lastSubmission, setLastSubmission] = useState<UGCUploadSubmission | null>(null);
    const [actionPending, setActionPending] = useState(false);
    const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

    const errText = useCallback((err: unknown): string => {
        if (err instanceof UGCClientError) {
            const translated = tUI(`detail.errors.${err.code}`);
            const fallback = tUI(err.status ? 'detail.errors.backendUnknown' : 'detail.errors.uploadFailed');
            return typeof translated === 'string' && translated
                ? translated
                : String(fallback || 'Upload failed.');
        }

        return String(tUI('detail.errors.uploadFailed') || 'Upload failed.');
    }, [tUI]);

    useEffect(() => {
        setImages([]);
        setMyImages([]);
        setError(null);
        setLastSubmission(null);
        setViewerOpen(false);
        setSelectedImageId(null);
        if (!target) return;

        let disposed = false;
        setLoading(true);
        void listUGCImages(point.id)
            .then((nextImages) => {
                if (!disposed) setImages(nextImages);
            })
            .catch(() => {
                if (!disposed) setImages([]);
            })
            .finally(() => {
                if (!disposed) setLoading(false);
            });

        if (user) {
            void listUGCMyImages(point.id)
                .then((nextImages) => {
                    if (!disposed) setMyImages(nextImages);
                })
                .catch(() => {
                    if (!disposed) setMyImages([]);
                });
        }

        return () => {
            disposed = true;
        };
    }, [point.id, target, user]);

    useEffect(() => {
        if (!pendingLoginUpload || !user) return;
        setPendingLoginUpload(false);
        requestAnimationFrame(() => inputRef.current?.click());
    }, [pendingLoginUpload, user]);

    const pointImages = useMemo(
        () => images.filter((image) => image.markerId === point.id),
        [images, point.id],
    );
    const pointMyImages = useMemo(
        () => myImages.filter((image) => image.markerId === point.id),
        [myImages, point.id],
    );
    const ownPublic = useMemo(
        () => pointMyImages.find(isPublic) ?? null,
        [pointMyImages],
    );
    const activeImages = useMemo(() => {
        const publicActiveImages = pointImages
            .map((image) => {
                const ownMatch = pointMyImages.find((myImage) => myImage.id === image.id);
                return ownMatch
                    ? {
                    ...image,
                    ...ownMatch,
                    author: image.author ?? ownMatch.author,
                    url: image.url || ownMatch.url,
                    }
                    : image;
            })
            .sort((a, b) => getImageCreatedAtTime(a) - getImageCreatedAtTime(b));

        if (publicActiveImages.length > 0) return publicActiveImages;
        return ownPublic ? [ownPublic] : [];
    }, [ownPublic, pointImages, pointMyImages]);
    const active = useMemo(() => {
        if (activeImages.length === 0) return null;
        return activeImages.find((image) => image.id === selectedImageId) ?? activeImages[0];
    }, [activeImages, selectedImageId]);

    useEffect(() => {
        if (activeImages.length === 0) {
            setSelectedImageId(null);
            return;
        }
        if (selectedImageId && activeImages.some((image) => image.id === selectedImageId)) return;
        setSelectedImageId(activeImages[0].id);
    }, [activeImages, selectedImageId]);

    const isOwnActive = Boolean(active && pointMyImages.some((image) => image.id === active.id));
    const pendingOwn = useMemo(
        () => pointMyImages.find(isPending) ?? null,
        [pointMyImages],
    );
    const state: ImageState = pendingOwn || lastSubmission?.status === 'pending_openai' || lastSubmission?.status === 'pending_audit'
        ? 'pending'
        : active
            ? 'hasImage'
            : 'noImage';
    const canUpload = Boolean(target) && state !== 'hasImage' && state !== 'pending' && !uploading;
    const canPreview = Boolean(active);
    const interactive = canPreview || canUpload;
    const karma = Number.isFinite(user?.karma) ? Math.max(0, user?.karma as number) : 0;
    const showRules = canUpload && state === 'noImage' && karma < 2;
    const rulesUrl = useMemo(
        () => `https://blog.opendfieldmap.org/${getAnnouncementLocaleKey(locale)}/docs/community-guidelines`,
        [locale],
    );

    const requestUpload = useCallback(() => {
        if (!canUpload) return;
        setError(null);
        if (!user) {
            setPendingLoginUpload(true);
            openOemAuthModal('login');
            return;
        }
        inputRef.current?.click();
    }, [canUpload, user]);

    const uploadFile = useCallback(async (file: File) => {
        if (!file || !target) return;

        setUploading(true);
        setProgress(0.02);
        setError(null);
        setLastSubmission(null);
        try {
            const submission = await uploadUGCImage(target, file, setProgress);
            setLastSubmission(submission);
            const [nextImages, nextMyImages] = await Promise.allSettled([
                listUGCImages(point.id),
                listUGCMyImages(point.id),
            ]);
            if (nextImages.status === 'fulfilled') {
                setImages(nextImages.value);
            }
            if (nextMyImages.status === 'fulfilled') {
                setMyImages(nextMyImages.value);
            }
        } catch (err) {
            setLastSubmission(null);
            setError(errText(err));
        } finally {
            setUploading(false);
            setProgress(0);
        }
    }, [errText, point.id, target]);

    const upload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        await uploadFile(file);
    }, [uploadFile]);

    return {
        active,
        activeImages,
        authorNickname: active?.author?.nickname ?? '',
        authorPublicUid: active?.author?.publicUid ?? '',
        canUpload,
        canPreview,
        error,
        inputRef,
        interactive,
        loading,
        progress,
        requestUpload,
        rulesUrl,
        selectedImageId,
        setSelectedImageId,
        setViewerOpen,
        show: Boolean(target) || pointImages.length > 0,
        showRules,
        state,
        upload,
        uploadFile,
        uploading,
        viewerOpen,
        actionPending,
        isOwnActive,
        isAuthenticated: Boolean(user),
        createdAt: active?.createdAt ?? '',
        setActionPending,
        setImages,
        setMyImages,
    };
};

const Uploader = memo(({ point, pointName, active: activeDetail = true }: Props) => {
    const tUI = useTranslateUI();
    const {
        active,
        activeImages,
        authorNickname,
        authorPublicUid,
        canUpload,
        canPreview,
        createdAt,
        error,
        actionPending,
        inputRef,
        interactive,
        isAuthenticated,
        isOwnActive,
        loading,
        progress,
        requestUpload,
        rulesUrl,
        selectedImageId,
        setSelectedImageId,
        setViewerOpen,
        show,
        showRules,
        state,
        upload,
        uploadFile,
        uploading,
        viewerOpen,
        setActionPending,
        setImages,
        setMyImages,
    } = useUpload(point);
    const { copiedPopupVisible, copyPointShareUrl } = usePointShareLink(point);
    const pendingUploadFileRef = useRef<File | null>(null);
    const dragDepthRef = useRef(0);
    const [appDocumentVersion, setAppDocumentVersion] = useState(0);
    const [dragActive, setDragActive] = useState(false);
    const [carouselHoverDirection, setCarouselHoverDirection] = useState<CarouselDirection | null>(null);
    const progressStyle = useMemo(
        () => ({ '--uploader-progress': `${Math.round(progress * 100)}%` }) as CSSProperties,
        [progress],
    );
    const uploadPasteKeys = useMemo<KeyChip[]>(
        () => [{ label: modKey(), variant: 'mod' }, { label: 'V' }],
        [],
    );
    const uploadShortcutHint = useMemo(() => {
        const text = String(tUI('detail.noInfo'));
        const parts = text.split(/(\{paste\}|\{click\})/g).filter(Boolean);

        return parts.map((part, index) => {
            if (part === '{paste}') {
                return <Shortcut key={`${part}:${index}`} keys={uploadPasteKeys} scale={UPLOAD_KEY_SCALE} />;
            }
            if (part === '{click}') {
                return <Shortcut key={`${part}:${index}`} keys={UPLOAD_CLICK_KEYS} scale={UPLOAD_KEY_SCALE} />;
            }
            return <span key={`${part}:${index}`}>{part}</span>;
        });
    }, [tUI, uploadPasteKeys]);

    const handleClick = useCallback(() => {
        if (canPreview) {
            setViewerOpen(true);
            return;
        }
        requestUpload();
    }, [canPreview, requestUpload, setViewerOpen]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (!interactive || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        handleClick();
    }, [handleClick, interactive]);

    const handleCarouselLayerClick = useCallback((
        event: React.MouseEvent<HTMLDivElement>,
        previous: () => void,
        next: () => void,
    ) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const direction = getCarouselDirection(rect, event.clientX, event.clientY, 0.087, 1.5879, 0.052);

        if (direction === 'previous') {
            event.stopPropagation();
            previous();
            return;
        }

        if (direction === 'next') {
            event.stopPropagation();
            next();
        }
    }, []);

    const handleCarouselLayerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const direction = getCarouselDirection(
            event.currentTarget.getBoundingClientRect(),
            event.clientX,
            event.clientY,
            0.087,
            1.5879,
            0.052,
        );
        setCarouselHoverDirection(direction);
    }, []);

    const handleCarouselLayerPointerLeave = useCallback(() => {
        setCarouselHoverDirection(null);
    }, []);

    const handleCarouselLayerKeyDown = useCallback((
        event: React.KeyboardEvent<HTMLDivElement>,
        previous: () => void,
        next: () => void,
    ) => {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            previous();
            return;
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            next();
        }
    }, []);

    useEffect(() => subscribePictureInPictureState(() => {
        setAppDocumentVersion((version) => version + 1);
    }), []);

    useEffect(() => {
        pendingUploadFileRef.current = null;
        dragDepthRef.current = 0;
        setDragActive(false);
    }, [point.id]);

    const handleClipboardUpload = useCallback(async (file: File) => {
        if (!file) return;
        if (!isAuthenticated) {
            pendingUploadFileRef.current = file;
            openOemAuthModal('login');
            return;
        }
        await uploadFile(file);
    }, [isAuthenticated, uploadFile]);

    useEffect(() => {
        if (!activeDetail || !canUpload || !isAuthenticated || uploading) return;
        const file = pendingUploadFileRef.current;
        if (!file) return;
        pendingUploadFileRef.current = null;
        void uploadFile(file);
    }, [activeDetail, canUpload, isAuthenticated, uploadFile, uploading]);

    useEffect(() => {
        if (!activeDetail || !canUpload || uploading || viewerOpen) return undefined;
        const activeDocument = getAppDocument();

        const handlePaste = (event: ClipboardEvent) => {
            const items = Array.from(event.clipboardData?.items ?? []);
            const file = items
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .find((item): item is File => Boolean(item));

            if (!file) return;
            event.preventDefault();
            void handleClipboardUpload(file);
        };

        activeDocument.addEventListener('paste', handlePaste);
        return () => activeDocument.removeEventListener('paste', handlePaste);
    }, [activeDetail, appDocumentVersion, canUpload, handleClipboardUpload, uploading, viewerOpen]);

    useEffect(() => {
        if (activeDetail && canUpload && !uploading && !viewerOpen) return;
        dragDepthRef.current = 0;
        setDragActive(false);
    }, [activeDetail, canUpload, uploading, viewerOpen]);

    const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        if (!activeDetail || !canUpload || uploading || viewerOpen) return;
        dragDepthRef.current += 1;
        setDragActive(true);
    }, [activeDetail, canUpload, uploading, viewerOpen]);

    const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = activeDetail && canUpload && !uploading && !viewerOpen ? 'copy' : 'none';
    }, [activeDetail, canUpload, uploading, viewerOpen]);

    const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        if (!activeDetail || !canUpload || uploading || viewerOpen) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setDragActive(false);
        }
    }, [activeDetail, canUpload, uploading, viewerOpen]);

    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        if (!activeDetail || !canUpload || uploading || viewerOpen) return;

        const file = event.dataTransfer.files[0];
        if (!file) return;

        if (!isAuthenticated) {
            pendingUploadFileRef.current = file;
            openOemAuthModal('login');
            return;
        }

        void uploadFile(file);
    }, [activeDetail, canUpload, isAuthenticated, uploadFile, uploading, viewerOpen]);

    const patchActiveImage = useCallback((patch: (image: UGCImage) => UGCImage) => {
        if (!active) return;
        setImages((current) => current.map((image) => (image.id === active.id ? patch(image) : image)));
        setMyImages((current) => current.map((image) => (image.id === active.id ? patch(image) as UGCSubmissionImage : image)));
    }, [active, setImages, setMyImages]);

    const applyServerImage = useCallback((serverImage: UGCImageActionPatch) => {
        setImages((current) => current.map((image) => (image.id === serverImage.id ? {
            ...image,
            ...serverImage,
        } : image)));
        setMyImages((current) => current.map((image) => (image.id === serverImage.id ? {
            ...image,
            ...serverImage,
            status: (serverImage as UGCSubmissionImage).status ?? image.status,
        } : image)));
    }, [setImages, setMyImages]);

    const handleToggleUpvote = useCallback(async () => {
        if (!active || actionPending) return;
        if (!isAuthenticated) {
            openOemAuthModal('login');
            return;
        }
        const nextUpvoted = !active.upvoted;
        const delta = nextUpvoted ? 1 : -1;
        patchActiveImage((image) => ({
            ...image,
            upvoted: nextUpvoted,
            upvotes: Math.max(0, getUpvoteCount(image) + delta),
            upvoteCount: Math.max(0, getUpvoteCount(image) + delta),
        }));
        setActionPending(true);
        try {
            applyServerImage(await toggleUGCImageUpvote(active.id, nextUpvoted));
        } catch {
            patchActiveImage((image) => ({
                ...image,
                upvoted: !nextUpvoted,
                upvotes: Math.max(0, getUpvoteCount(image) - delta),
                upvoteCount: Math.max(0, getUpvoteCount(image) - delta),
            }));
        } finally {
            setActionPending(false);
        }
    }, [actionPending, active, applyServerImage, isAuthenticated, patchActiveImage, setActionPending]);

    const handleToggleFlag = useCallback(async () => {
        if (!active || actionPending || isOwnActive) return;
        if (!isAuthenticated) {
            openOemAuthModal('login');
            return;
        }
        const nextFlagged = !active.flagged;
        patchActiveImage((image) => ({
            ...image,
            flagged: nextFlagged,
            status: nextFlagged ? 'flagged' : image.status === 'flagged' ? 'active' : image.status,
        }));
        setActionPending(true);
        try {
            applyServerImage(await toggleUGCImageFlag(active.id, nextFlagged));
        } catch {
            patchActiveImage((image) => ({
                ...image,
                flagged: !nextFlagged,
                status: !nextFlagged ? 'flagged' : image.status === 'flagged' ? 'active' : image.status,
            }));
        } finally {
            setActionPending(false);
        }
    }, [actionPending, active, applyServerImage, isAuthenticated, isOwnActive, patchActiveImage, setActionPending]);

    const handleToggleRecall = useCallback(async () => {
        if (!active || actionPending || !isOwnActive) return;
        if (!isAuthenticated) {
            openOemAuthModal('login');
            return;
        }
        const nextRecallRequested = !active.recallRequested && active.status !== 'remove_request';
        patchActiveImage((image) => ({
            ...image,
            recallRequested: nextRecallRequested,
            status: nextRecallRequested ? 'remove_request' : image.status === 'remove_request' ? 'active' : image.status,
        }));
        setActionPending(true);
        try {
            applyServerImage(await toggleUGCImageRecall(active.id, nextRecallRequested));
        } catch (err) {
            if (nextRecallRequested && isActionConflict(err)) {
                patchActiveImage((image) => ({
                    ...image,
                    recallRequested: true,
                    status: 'remove_request',
                }));
                return;
            }
            patchActiveImage((image) => ({
                ...image,
                recallRequested: !nextRecallRequested,
                status: !nextRecallRequested ? 'remove_request' : image.status === 'remove_request' ? 'active' : image.status,
            }));
        } finally {
            setActionPending(false);
        }
    }, [actionPending, active, applyServerImage, isAuthenticated, isOwnActive, patchActiveImage, setActionPending]);

    if (!show) return null;

    return (
        <>
            <div
                className={classNames(styles.pointImage, {
                    [styles.noImage]: state === 'noImage',
                    [styles.pending]: state === 'pending',
                    [styles.hasImage]: state === 'hasImage',
                    [styles.isClickable]: interactive,
                    [styles.isDragActive]: dragActive,
                    [styles.isUploading]: uploading,
                })}
                style={progressStyle}
                onClick={handleClick}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onKeyDown={handleKeyDown}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {state === 'hasImage' && active ? (
                    <Carousel
                        items={activeImages}
                        selectedKey={selectedImageId}
                        getKey={(image) => image.id}
                        onSelectedKeyChange={setSelectedImageId}
                    >
                        {({ item, hasMultiple, previous, next }) => item && (
                            <>
	                                <img src={item.url} alt={item.content || pointName} />
	                                {hasMultiple && (
	                                    <div
	                                        className={styles.carouselLayer}
	                                        data-hover={carouselHoverDirection ?? undefined}
	                                        role="button"
	                                        tabIndex={-1}
	                                        aria-label="Switch image"
	                                        onClick={(event) => handleCarouselLayerClick(event, previous, next)}
	                                        onKeyDown={(event) => handleCarouselLayerKeyDown(event, previous, next)}
	                                        onPointerMove={handleCarouselLayerPointerMove}
	                                        onPointerLeave={handleCarouselLayerPointerLeave}
	                                    />
	                                )}
	                            </>
                        )}
                    </Carousel>
                ) : (
                    <div className={styles.noImage}>
                        {uploading
                            ? tUI('detail.uploading')
                            : loading
                                ? ''
                                : state === 'pending'
                                    ? tUI('detail.uploadPending')
                                    : (
                                        <span className={styles.uploadShortcutHint}>
                                            {uploadShortcutHint}
                                        </span>
                                    )}
                        {showRules && !uploading && !loading && (
                            <div className={styles.communityRule}>
                                <span>{tUI('detail.communityRule1')}</span>
                                {' '}
                                <a
                                    href={rulesUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    {tUI('detail.communityRule2')}
                                </a>
                            </div>
                        )}
                    </div>
                )}
            </div>
            <input
                ref={inputRef}
                className={styles.imageInput}
                type="file"
                accept={UPLOAD_ACCEPT}
                onChange={(event) => void upload(event)}
            />
            {error && (
                <div className={styles.uploadHint}>{error}</div>
            )}
            <Viewer
                open={viewerOpen && Boolean(active)}
                images={activeImages}
                selectedImageId={selectedImageId}
                onSelectedImageIdChange={setSelectedImageId}
                imageUrl={active?.url ?? ''}
                alt={active?.content || pointName}
                authorNickname={authorNickname}
                authorPublicUid={authorPublicUid}
                createdAt={createdAt}
                upvoteCount={active ? getUpvoteCount(active) : 0}
                upvoted={Boolean(active?.upvoted)}
                flagged={Boolean(active?.flagged)}
                recallRequested={Boolean(active?.recallRequested || active?.status === 'remove_request')}
                canFlag={!isOwnActive}
                canRecall={isOwnActive}
                actionPending={actionPending}
                shareCopied={copiedPopupVisible}
                onToggleUpvote={() => void handleToggleUpvote()}
                onToggleFlag={() => void handleToggleFlag()}
                onShare={() => void copyPointShareUrl()}
                onToggleRecall={() => void handleToggleRecall()}
                onClose={() => setViewerOpen(false)}
            />
        </>
    );
});

Uploader.displayName = 'Uploader';

export default Uploader;

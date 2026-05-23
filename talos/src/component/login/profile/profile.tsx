import { useEffect, useRef, useState } from 'react';
import ProfileIcon from '@/assets/logos/profile.svg?react';
import Modal from '@/component/modal/modal';
import { requestEndfieldBinding } from '@/component/locator';
import SyncConflictModal, { type SyncConflictChoice } from '@/component/sync/conflict';
import { useTranslateUI } from '@/locale';
import { useDevice } from '@/utils/device';
import { EFBackendError, getEFBindingStatus } from '@/utils/endfield/backendClient';
import {
  applyOfficialMarks,
  hasOfficialMarksConflict,
  loadOfficialMarksSnapshot,
  type OfficialMarksSnapshot,
} from '@/utils/endfield/officialMarks';
import { AccessButton } from '../access';
import IdCardView, { type IdCardRenderModel } from '../idcardView';
import { useIdCardHoverAngle } from '../useIdCardHoverAngle';
import styles from './profile.module.scss';

const MODAL_EXIT_DURATION_MS = 325;

interface ProfileModalProps {
  profileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
  profileName: string;
  setProfileName: (name: string) => void;
  profileError: string | null;
  isSavingProfile: boolean;
  cardProfile: IdCardRenderModel;
  profileAvatar: number;
  onAvatarCycle: () => void;
  handleCloseProfile: () => Promise<void>;
  handleSaveProfile: () => Promise<void>;
  handleLogout: () => Promise<void>;
}

const ProfileModal = ({
  profileOpen,
  setProfileOpen,
  profileName,
  setProfileName,
  profileError,
  isSavingProfile,
  cardProfile,
  profileAvatar,
  onAvatarCycle,
  handleCloseProfile,
  handleSaveProfile,
  handleLogout,
}: ProfileModalProps) => {
  const t = useTranslateUI();
  const { isMobile } = useDevice();
  const { cardRef, handleCardMouseMove, handleCardMouseLeave } = useIdCardHoverAngle();
  const [isImportingOfficialMarks, setIsImportingOfficialMarks] = useState(false);
  const [conflictSnapshot, setConflictSnapshot] = useState<OfficialMarksSnapshot | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const conflictCleanupTimerRef = useRef<number | null>(null);
  const conflictOpenTimerRef = useRef<number | null>(null);
  const profileErrorText = profileError ?? '';
  const shouldShowProfileError = profileOpen && Boolean(profileErrorText);
  const isProfileErrorRemoved = !shouldShowProfileError;
  const modalSize = isMobile ? 'full' : 'm';

  useEffect(() => () => {
    if (conflictCleanupTimerRef.current !== null) {
      window.clearTimeout(conflictCleanupTimerRef.current);
    }
    if (conflictOpenTimerRef.current !== null) {
      window.clearTimeout(conflictOpenTimerRef.current);
    }
  }, []);

  const clearConflictTimers = () => {
    if (conflictCleanupTimerRef.current !== null) {
      window.clearTimeout(conflictCleanupTimerRef.current);
      conflictCleanupTimerRef.current = null;
    }
    if (conflictOpenTimerRef.current !== null) {
      window.clearTimeout(conflictOpenTimerRef.current);
      conflictOpenTimerRef.current = null;
    }
  };

  const closeConflictModal = () => {
    setConflictOpen(false);
    if (conflictCleanupTimerRef.current !== null) {
      window.clearTimeout(conflictCleanupTimerRef.current);
    }
    conflictCleanupTimerRef.current = window.setTimeout(() => {
      setConflictSnapshot(null);
      conflictCleanupTimerRef.current = null;
    }, MODAL_EXIT_DURATION_MS);
  };

  const openConflictModalAfterProfile = async (snapshot: OfficialMarksSnapshot) => {
    clearConflictTimers();
    await handleCloseProfile();
    setConflictSnapshot(snapshot);
    setConflictOpen(false);
    conflictOpenTimerRef.current = window.setTimeout(() => {
      setConflictOpen(true);
      conflictOpenTimerRef.current = null;
    }, MODAL_EXIT_DURATION_MS);
  };

  const requestBindingThenImport = () => {
    void handleCloseProfile();
    requestEndfieldBinding({
      enableLocator: false,
      onBound: handleImportOfficialMarks,
    });
  };

  const handleImportOfficialMarks = async () => {
    if (isImportingOfficialMarks) return;
    setIsImportingOfficialMarks(true);
    try {
      const status = await getEFBindingStatus();
      if (!status.binding.bound || !status.binding.enabled) {
        requestBindingThenImport();
        return;
      }

      const snapshot = await loadOfficialMarksSnapshot();
      if (hasOfficialMarksConflict(snapshot)) {
        void openConflictModalAfterProfile(snapshot);
        return;
      }

      applyOfficialMarks(snapshot.officialPointIds, snapshot.unresolved);
    } catch (error) {
      if (error instanceof EFBackendError && error.code === 'ENDFIELD_BINDING_NOT_FOUND') {
        requestBindingThenImport();
        return;
      }
      console.warn('[sync][official] import failed', error);
    } finally {
      setIsImportingOfficialMarks(false);
    }
  };

  const handleConflictResolve = (choice: SyncConflictChoice) => {
    if (!conflictSnapshot) return;
    const pointIds = choice === 'a'
      ? conflictSnapshot.localPointIds
      : choice === 'b'
        ? conflictSnapshot.officialPointIds
        : [...new Set([...conflictSnapshot.localPointIds, ...conflictSnapshot.officialPointIds])];
    applyOfficialMarks(pointIds, conflictSnapshot.unresolved);
    closeConflictModal();
  };

  return (
    <>
      <Modal
        open={profileOpen}
        size={modalSize}
        title={t('idcard.profile.title')}
        icon={<ProfileIcon />}
        iconScale={0.8}
        onClose={() => {
          void handleCloseProfile();
        }}
        onChange={(nextOpen) => {
          if (nextOpen) {
            setProfileOpen(true);
            return;
          }
          void handleCloseProfile();
        }}
        customHeight='80dvh'
      >
        <div className={styles.profileModal}>
          <IdCardView
            embedded
            profile={cardProfile}
            cardRef={cardRef}
            onCardMouseMove={handleCardMouseMove}
            onCardMouseLeave={handleCardMouseLeave}
            onAvatarClick={onAvatarCycle}
            avatarAriaLabel={t('idcard.profile.avatarHint')}
            avatarIndex={profileAvatar}
            editableName
            nameValue={profileName}
            onNameValueChange={setProfileName}
            nickName={t('idcard.profile.nickName')}
            nameAriaLabel={t('idcard.profile.nameEditHint')}
            nameMaxLength={15}
          />

          <div className={styles.profileDivider} data-label={t('idcard.profile.note') || 'Note'}></div>

          <div className={styles.profileNote}>
            <p>{t('idcard.profile.noteNickname') || 'You can use letters, numbers, and underscores in your username.'}</p>
            <p>
              {t('idcard.profile.noteUID') ||
                'UID is assigned on first setup and cannot be changed. You can update your username any time.'}
            </p>
          </div>

          <div
            className={styles.profileError}
            data-removed={isProfileErrorRemoved ? 'true' : 'false'}
            data-text={profileErrorText}
            aria-live="polite"
          >
            {profileErrorText}
          </div>

          <div className={styles.profileDivider} data-label={t('idcard.profile.auditLabel') || 'Audit'}></div>

          <div className={styles.profileActions}>
            <div className={styles.profileActionWide}>
              <AccessButton
                onClick={() => {
                  void handleImportOfficialMarks();
                }}
                disabled={isSavingProfile || isImportingOfficialMarks}
                label={isImportingOfficialMarks
                  ? t('common.loading') || 'Loading...'
                  : t('idcard.profile.importOfficial')}
              />
            </div>
            <AccessButton
              onClick={() => {
                void handleSaveProfile();
              }}
              disabled={isSavingProfile}
              label={isSavingProfile
                ? t('idcard.profile.saving') || 'Saving...'
                : t('idcard.profile.save') || 'Save Changes'}
            />
            <AccessButton
              onClick={() => {
                void handleLogout();
              }}
              disabled={isSavingProfile}
              label={t('idcard.profile.logout') || 'Sign Out'}
            />
          </div>
        </div>
      </Modal>
      {conflictSnapshot && (
        <SyncConflictModal
          open={conflictOpen}
          sourceA={{
            side: 'local',
            updatedAt: conflictSnapshot.localUpdatedAt,
            pointIds: conflictSnapshot.localPointIds,
          }}
          sourceB={{
            side: 'remote',
            remoteSource: 'official',
            updatedAt: conflictSnapshot.officialUpdatedAt,
            pointIds: conflictSnapshot.officialPointIds,
          }}
          onClose={closeConflictModal}
          onResolve={handleConflictResolve}
        />
      )}
    </>
  );
};

export default ProfileModal;

import type { FC } from '../../lib/teact/teact';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';

import type { TgPluginApi, TgTeactNode } from '../types';
import type { AntiDeleteArchive } from './archive';
import type { AntiDeleteCaptureRecord } from './capture';
import type { AntiDeleteRevisionRecord } from './revisions';

import { copyTextToClipboard } from '../../util/clipboard';
import { formatDateToString } from '../../util/dates/oldDateFormat';

import styles from './viewer.module.scss';

/** App lang key, derived from the contract so the plugin stays policy-clean. */
type ViewerLangKey = Parameters<TgPluginApi['util']['getLocalizedString']>[0];
type ViewerLangVariables = Parameters<TgPluginApi['util']['getLocalizedString']>[1];

/** Page size for the archive walk; one screen holds far less than this. */
const PAGE_LIMIT = 50;

/** Distance from the list end (px) that triggers loading the next older page. */
const LOAD_MORE_THRESHOLD_PX = 120;

/** Seconds (the capture's `date`) → milliseconds for `formatDateToString`. */
const MS_PER_SECOND = 1000;

/** Locale passed to `formatDateToString`; the viewer has no lang-pack handle. */
const DATE_LOCALE = 'en-US';

type OwnProps = {
  archive: AntiDeleteArchive;
  chatId: string;
  /** Translates app lang keys; `tg.util.getLocalizedString` in production. */
  localize: (key: ViewerLangKey, variables?: ViewerLangVariables) => string;
};

/**
 * The archive viewer rendered through `tg.ui.openScreen`: one chat's captured
 * deletions, newest first, with cursor paging into older captures, text
 * search, text copy and a per-chat clear behind a confirmation. Media
 * captures render as a placeholder in this ticket. The markup is plain DOM:
 * plugin code stays within the plugin-safe import set.
 */
const ArchiveViewer: FC<OwnProps> = ({ archive, chatId, localize }) => {
  const [captures, setCaptures] = useState<AntiDeleteCaptureRecord[] | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [isClearConfirmShown, setIsClearConfirmShown] = useState(false);
  const [copiedMessageIds, setCopiedMessageIds] = useState<number[]>([]);

  const chatIdRef = useRef(chatId);
  const isLoadingRef = useRef(false);

  const isInSearch = searchQuery.trim().length > 0;

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  // Loads the first page on open, and a fresh result set on every query change.
  useEffect(() => {
    let isCancelled = false;
    isLoadingRef.current = true;

    const firstPage = isInSearch
      ? archive.searchCaptures(chatId, searchQuery)
      : archive.readCaptures(chatId, { limit: PAGE_LIMIT });

    void firstPage.then((page) => {
      if (isCancelled || chatIdRef.current !== chatId) return;
      setCaptures(page.captures);
      // The search page is exhaustive and carries no cursor
      setNextCursor('nextCursor' in page ? page.nextCursor : undefined);
      isLoadingRef.current = false;
    }).catch(() => {
      if (isCancelled) return;
      isLoadingRef.current = false;
    });

    return () => {
      isCancelled = true;
    };
  }, [archive, chatId, searchQuery, isInSearch]);

  const handleListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // The search walk is exhaustive; only the paged walk loads more.
    if (isInSearch || isLoadingRef.current || nextCursor === undefined) return;

    const container = e.currentTarget;
    const distanceToEnd = container.scrollHeight - container.scrollTop - container.offsetHeight;
    if (distanceToEnd > LOAD_MORE_THRESHOLD_PX) return;

    const cursor = nextCursor;
    isLoadingRef.current = true;
    void archive.readCaptures(chatId, { limit: PAGE_LIMIT, cursor }).then((page) => {
      setCaptures((previous) => [...previous ?? [], ...page.captures]);
      setNextCursor(page.nextCursor);
      isLoadingRef.current = false;
    }).catch(() => {
      isLoadingRef.current = false;
    });
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.currentTarget.value);
  };

  const handleCopy = (capture: AntiDeleteCaptureRecord) => {
    const text = capture.text?.text ?? '';
    if (text.length === 0) return;

    if (copyTextToClipboard(text)) {
      setCopiedMessageIds((previous) => [...previous, capture.messageId]);
    }
  };

  const handleClearConfirm = () => {
    setIsClearConfirmShown(false);
    setCaptures([]);
    setNextCursor(undefined);
    void archive.clearCaptures(chatId);
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="text"
          dir="auto"
          placeholder={localize('DeletedMessagesSearchPlaceholder')}
          value={searchQuery}
          onChange={handleSearchChange}
        />
        <button type="button" className={styles.clearButton} onClick={() => setIsClearConfirmShown(true)}>
          {localize('DeletedMessagesClear')}
        </button>
      </div>
      <div className={styles.list} onScroll={handleListScroll}>
        {captures === undefined && (
          <div className={styles.empty}>{localize('DeletedMessagesLoading')}</div>
        )}
        {captures !== undefined && captures.length === 0 && (
          <div className={styles.empty}>
            <svg className={styles.emptyIcon} viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"
                fill="currentColor"
              />
            </svg>
            <p dir="auto">{localize(isInSearch ? 'DeletedMessagesEmptySearch' : 'DeletedMessagesEmpty')}</p>
          </div>
        )}
        {captures?.map((capture) => (
          renderCaptureRow(archive, capture, localize, copiedMessageIds, handleCopy)
        ))}
      </div>
      {isClearConfirmShown && (
        <div className={styles.confirmBackdrop} onClick={() => setIsClearConfirmShown(false)}>
          <div className={styles.confirm} role="alertdialog" onClick={stopEventPropagation}>
            <p dir="auto">{localize('DeletedMessagesClearConfirm')}</p>
            <div className={styles.confirmButtons}>
              <button
                type="button"
                className={`${styles.confirmButton} ${styles.confirmButtonDestructive}`}
                onClick={handleClearConfirm}
              >
                {localize('DeletedMessagesClear')}
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={() => setIsClearConfirmShown(false)}
              >
                {localize('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The per-row edit-history expander: stays hidden until tapped (revisions
 * load lazily — the viewer never scans revision records upfront), then lists
 * the message's captured pre-edit revisions newest-first, each with its
 * edit date and text. The capture row itself is the final state for a
 * deleted message, so the list reads as before/after.
 */
const RevisionExpander: FC<{
  archive: AntiDeleteArchive;
  capture: AntiDeleteCaptureRecord;
  localize: (key: ViewerLangKey, variables?: ViewerLangVariables) => string;
}> = ({ archive, capture, localize }) => {
  const [revisions, setRevisions] = useState<AntiDeleteRevisionRecord[] | undefined>(undefined);
  const [isExpanded, setIsExpanded] = useState(false);
  const isLoadingRef = useRef(false);

  // Loads the revisions on first expand only; a later collapse/expand reuses
  // the loaded list.
  const handleExpand = () => {
    if (isExpanded || isLoadingRef.current) {
      setIsExpanded(!isExpanded);
      return;
    }

    isLoadingRef.current = true;
    void archive.readRevisions(capture.chatId, capture.messageId).then((records) => {
      isLoadingRef.current = false;
      setRevisions(records);
      setIsExpanded(true);
    }).catch(() => {
      isLoadingRef.current = false;
    });
  };

  return (
    <div className={styles.revisions}>
      <button type="button" className={styles.revisionsToggle} onClick={handleExpand}>
        {localize('DeletedMessagesEditHistory')}
      </button>
      {isExpanded && (
        revisions === undefined || revisions.length === 0
          ? <div className={styles.revisionsEmpty}>{localize('DeletedMessagesLoading')}</div>
          : (
            <div>
              {revisions.map((revision) => (
                <div key={revision.editDate} className={styles.revision}>
                  <div className={styles.revisionMeta}>
                    <span>{localize('DeletedMessagesEditHistoryRevision')}</span>
                    <span>{formatCaptureDate(revision.editDate)}</span>
                  </div>
                  <div className={styles.revisionText} dir="auto">{revision.text.text}</div>
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
};

/** Lang key per deletion source, for the per-row "why it went" label. */
const SOURCE_LANG_KEYS: Record<AntiDeleteCaptureRecord['source'], 'DeletedMessagesSourceDelete'
  | 'DeletedMessagesSourceHistoryClear' | 'DeletedMessagesSourceTtl'> = {
  delete: 'DeletedMessagesSourceDelete',
  historyClear: 'DeletedMessagesSourceHistoryClear',
  ttl: 'DeletedMessagesSourceTtl',
};

function renderCaptureRow(
  archive: AntiDeleteArchive,
  capture: AntiDeleteCaptureRecord,
  localize: (key: ViewerLangKey, variables?: ViewerLangVariables) => string,
  copiedMessageIds: number[],
  onCopy: (capture: AntiDeleteCaptureRecord) => void,
) {
  const isCopied = copiedMessageIds.includes(capture.messageId);
  const text = capture.text?.text ?? '';

  return (
    <div key={`${capture.chatId}-${capture.messageId}`} className={styles.row}>
      <div className={styles.rowHeader}>
        <span className={styles.sender} dir="auto">{capture.senderId ?? localize('DeletedMessagesUnknownSender')}</span>
        <span className={styles.meta}>
          <span className={styles.deletedMark}>{localize('DeletedMessagesDeletedMark')}</span>
          <span className={styles.source}>{localize(SOURCE_LANG_KEYS[capture.source])}</span>
          <span className={styles.date}>{formatCaptureDate(capture.date)}</span>
        </span>
      </div>
      {text.length > 0 && <div className={styles.text} dir="auto">{text}</div>}
      {capture.content.type !== 'text' && (
        <div className={styles.media}>
          <span className={styles.mediaIcon} aria-hidden="true">▣</span>
          <span dir="auto">{localize('DeletedMessagesMediaPlaceholder')}</span>
          <span className={styles.mediaType}>{capture.content.type}</span>
        </div>
      )}
      <div className={styles.rowFooter}>
        <RevisionExpander archive={archive} capture={capture} localize={localize} />
        {text.length > 0 && (
          <button type="button" className={styles.copyButton} onClick={() => onCopy(capture)}>
            {isCopied ? localize('DeletedMessagesCopied') : localize('Copy')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The capture's original-message date, like a message list meta line. */
function formatCaptureDate(dateSeconds: number): string {
  // `formatDateToString` renders a locale-neutral "Mon DD, HH:mm" style line
  // without a lang-pack handle, which fits the viewer's import set.
  return formatDateToString(new Date(dateSeconds * MS_PER_SECOND), DATE_LOCALE, true, 'short');
}

function stopEventPropagation(e: React.SyntheticEvent) {
  e.stopPropagation();
}

/**
 * Builds the screen descriptor the plugin passes to `tg.ui.openScreen`: a
 * localized title plus a render factory closing over the current lifetime's
 * archive and the chat the menu was opened on.
 */
export function createArchiveViewerScreen(
  archive: AntiDeleteArchive,
  chatId: string,
  localize: (key: ViewerLangKey, variables?: ViewerLangVariables) => string,
): { title: string; render: () => TgTeactNode } {
  return {
    title: localize('DeletedMessages'),
    render: () => <ArchiveViewer archive={archive} chatId={chatId} localize={localize} />,
  };
}

export default memo(ArchiveViewer);

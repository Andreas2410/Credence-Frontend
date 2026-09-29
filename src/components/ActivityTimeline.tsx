import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import './ActivityTimeline.css'
import { ActivityItem, ActivityTone, SAMPLE_ACTIVITY, ACTIVITY_ITEMS } from '../data/activity'
import { AttestationStatus, toneToStatus } from '../events'
import { formatAmount } from '../lib/format'
import EmptyState from './states/EmptyState'
import CopyableHash from './CopyableHash'
import Badge from './Badge'
import type { BadgeVariant } from './Badge'

export type ActivityTimelineState = 'loading' | 'ready' | 'error' | 'stale' | 'forbidden'

export interface ActivityTimelineError {
  message: string
  retryable?: boolean
}

/**
 * Maps ActivityTimeline tone values to Badge variants.
 * Tones represent attestation status severity levels.
 */
export function toneToBadgeVariant(tone: ActivityTone): BadgeVariant {
  const mapping: Record<ActivityTone, BadgeVariant> = {
    success: 'active',
    warning: 'grace-period',
    info: 'locked',
  }
  return mapping[tone]
}

/**
 * Detects if meta string represents a transaction hash.
 * Returns true if meta starts with "Tx 0x" pattern.
 */
export function isTxHash(meta: string): boolean {
  return /^Tx\s+0x/i.test(meta)
}

/**
 * Resolves the filterable status for an activity item. Prefers the
 * explicit `status` field and falls back to `toneToStatus(tone)` so that
 * legacy items added before `status` was introduced keep working.
 */
export function resolveItemStatus(item: ActivityItem): AttestationStatus | null {
  if (item.status) return item.status
  return toneToStatus(item.tone)
}

/**
 * Normalizes a potentially untrusted items array into a deterministic
 * list. Duplicate ids are deduped by last-write-wins so a refetch that
 * returns a stale and fresh copy of the same event never renders twice.
 * Entries missing a stable `id` are dropped rather than rendered with
 * an ephemeral key, which would orphan expansion state and break a
 * retry/replay guarantee.
 */
export function normalizeItems(items: ActivityItem[]): ActivityItem[] {
  const seen = new Map<string, ActivityItem>()
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
    seen.set(item.id, item)
  }
  return Array.from(seen.values())
}

export interface ActivityTimelineProps {
  compact?: boolean
  items?: ActivityItem[]
  /** Override the default empty-state title (defaults to "No activity yet"). */
  emptyTitle?: string
  /** Override the default empty-state description. */
  emptyDescription?: string
  /** Opts into drawer-based navigation: swaps the disclosure button to "View details" and makes the row clickable. */
  onSelect?: (item: ActivityItem) => void
  /** Idempotency nonce for deterministic safe retry and replay protection. */
  nonce?: string

  /** Explicit lifecycle state. When omitted the component derives
   *  'ready' or 'error' from the provided items/error props for backwards
   *  compatibility with existing callers. */
  state?: ActivityTimelineState
  /** Structured error description. Only the message is rendered;
   *  never raw server payloads. */
  error?: ActivityTimelineError | null
  /** Invoked when the user requests a retry from an error/stale state.
   *  If omitted the retry affordance is not rendered. */
  onRetry?: () => void
  /** True while a retry is in flight so the button can disable and
   *  prevent concurrent duplicate requests. */
  retrying?: boolean
  /** Optional callback for observability when a failure is surfaced.
   *  Receives a sanitized event name only. */
  onStateError?: (event: string, detail?: Record<string, unknown>) => void
}

const STATE_MESSAGES: Record<Exclude<ActivityTimelineState, 'ready'>, {
  title: string
  description: string
}> = {
  loading: {
    title: 'Loading activity',
    description: 'Fetching the latest attestations and events…',
  },
  error: {
    title: 'Unable to load activity',
    description: 'Something went wrong while loading the timeline.',
  },
  stale: {
    title: 'Activity may be out of date',
    description: 'We couldn’t refresh the latest activity. Showing the last known good data.',
  },
  forbidden: {
    title: 'Access restricted',
    description: 'You do not have permission to view this activity.',
  },
}

/**
 * Attestation timeline surface.
 *
 * The original disclosure pattern (Show/Hide details) is the default and
 * is what the Trust Score surface consumes (via `compact`). The
 * Attestations route opts in to drawer-based navigation by passing
 * `onSelect`, which swaps the disclosure button to "View details" and
 * makes the entire row clickable.
 *
 * Implements accessible disclosure pattern (inline path only):
 * - aria-expanded / aria-controls wiring
 * - Enter / Space toggle activation
 * - Escape to collapse + return focus
 * - Focus management on open / close
 *
 * Lifecycle invariants:
 * - The list is never rendered in a non-ready state. Loading, error,
 *   stale, and forbidden states show a state surface instead.
 * - In the stale state the last known good items are still rendered
 *   below a non-blocking banner so user data is never lost.
 * - Expansion state is cleared whenever the underlying item disappears,
 *   when the nonce changes, or when the component leaves the ready state.
 *
 * See docs/ATTESTATIONS_VIEW_DESIGN.md, §3 and §4.
 */
export default function ActivityTimeline({
  compact = false,
  items = SAMPLE_ACTIVITY,
  emptyTitle = 'No activity yet',
  emptyDescription = 'Attestations and events will appear here once activity begins.',
  onSelect,
  nonce,
  state,
  error,
  onRetry,
  retrying = false,
  onStateError,
}: ActivityTimelineProps): ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  // Derive the effective lifecycle state. An explicit `state` prop wins;
  // otherwise fall back to error/ready derived from the existing props
  // so legacy callers that only pass `items` keep working unchanged.
  const effectiveState: ActivityTimelineState =
    state ?? (error ? 'error' : 'ready')

  // Normalize items once per render so duplicate ids and malformed
  // entries cannot produce an inconsistent or ambiguous tree.
  const normalizedItems = normalizeItems(items)

  const count = normalizedItems.length
  const summary = `${count} recent ${count === 1 ? 'event' : 'events'}`

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      // Escape handling is meaningful only for the inline disclosure path.
      // When `onSelect` is provided the drawer owns the focus trap and
      // its own Escape handler — see AttestationDetailDrawer.
      if (event.key !== 'Escape' || !expandedId || onSelect) return
      const openId = expandedId
      setExpandedId(null)
      const trigger = triggerRef.current.get(openId)
      if (trigger) trigger.focus()
    },
    [expandedId, onSelect]
  )

  // Atomic state recovery: Ensure that if items change (e.g. filtered, replaced, or rolled back on error),
  // any expandedId that is no longer present in items is automatically cleared so no orphaned panel or
  // unauthorized partial detail remains open.
  useEffect(() => {
    if (expandedId !== null && !normalizedItems.some((item) => item.id === expandedId)) {
      setExpandedId(null)
    }
  }, [normalizedItems, expandedId])

  // Reset expansion state when nonce changes to guarantee deterministic replay and idempotency protection.
  useEffect(() => {
    setExpandedId(null)
  }, [nonce])

  // Collapse any open disclosure when the component leaves the ready
  // state. This prevents a stale expanded panel from re-appearing after
  // a failed refetch and recovery.
  useEffect(() => {
    if (effectiveState !== 'ready' && effectiveState !== 'stale') {
      setExpandedId(null)
    }
  }, [effectiveState])

  // Surface failures for observability without echoing sensitive payloads.
  useEffect(() => {
    if (!error) return
    onStateError?.('activity_timeline_error', {
      state: effectiveState,
      retryable: Boolean(error.retryable),
    })
  }, [error, effectiveState, onStateError])

  const handleRetry = useCallback(() => {
    if (!onRetry || retrying) return
    onRetry()
  }, [onRetry, retrying])

  const isReady = effectiveState === 'ready' || effectiveState === 'stale'
  const showRetry = Boolean(onRetry) && (effectiveState === 'error' || effectiveState === 'stale')

  const renderStateSurface = () => {
    if (effectiveState === 'ready') return null
    const message = STATE_MESSAGES[effectiveState]
    const title = effectiveState === 'error' && error?.message ? error.message : message.title
    return (
      <div
        className={`inline-flex flex-col gap-2 rounded-border border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700`}
        role={effectiveState === 'error' ? 'alert' : 'status'}
        aria-live={effectiveState === 'error' ? 'assertive' : 'polite'}
        data-state={effectiveState}
      >
        <p className="font-medium text-slate-900">{title}</p>
        <p className="text-slate-600">{message.description}</p>
        {showRetry && (
          <button
            type="button"
            className="self-start rounded-border border border-slate-300 bg-white px-3 py-1 font-medium text-slate-800 disabled:opacity-50"
            onClick={handleRetry}
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    )
  }

  return (
    <section
      className={`activity-surface${compact ? ' activity-surface--compact' : ''}`}
      aria-label="Activity and attestations"
      onKeyDown={handleKeyDown}
      data-nonce={nonce}
      data-state={effectiveState}
    >
      <header className="activity-surface__header">
        <div>
          <p className="activity-surface__eyebrow">Activity Surface Concept</p>
          <h2 className="activity-surface__title">Attestation timeline</h2>
        </div>
        {isReady && count > 0 && (
          <p className="activity-surface__summary" aria-live="polite" aria-atomic="true">
            {summary}
          </p>
        )}
      </header>

      {renderStateSurface()}

      {isReady && (
        count === 0 ? (
          <EmptyState
            illustration="activity"
            title={emptyTitle}
            description={emptyDescription}
          />
        ) : (
          <ul className="activity-timeline" aria-label="Recent timeline events">
            {normalizedItems.map((item) => {
              const isExpanded = expandedId === item.id
              const panelId = `details-${item.id}`
              const buttonId = `trigger-${item.id}`
              const rowClassName = [
                'activity-row',
                onSelect ? 'activity-row--selectable' : '',
              ]
                .filter(Boolean)
                .join(' ')
              const disclosureLabel = onSelect
                ? 'View details'
                : isExpanded
                  ? 'Hide details'
                  : 'Show details'
              const statusPrefix = item.statusLabel ? `${item.statusLabel}. ` : ''
              return (
                <li
                  className={rowClassName}
                  key={item.id}
                  onClick={
                    onSelect
                      ? () => {
                          // The disclosure button calls stopPropagation in its own
                          // handler, so this row-level handler only fires for
                          // clicks outside the button.
                          onSelect(item)
                        }
                      : undefined
                  }
                >
                  <div className="activity-row__rail" aria-hidden="true">
                    <span className={`activity-row__node activity-row__node--${item.tone}`} />
                    <span className="activity-row__line" />
                  </div>

                  <time className="activity-row__time">{item.timestamp}</time>

                  <div className="activity-row__content">
                    <div className="activity-row__title-wrap">
                      <p className="activity-row__title">{item.title}</p>
                      <Badge variant={toneToBadgeVariant(item.tone)} label={item.statusLabel} />
                    </div>
                    <p className="activity-row__description">{item.description}</p>

                    {item.amountUsdc != null && (
                      <p
                        className="activity-row__amount"
                        aria-label={`Amount: ${formatAmount(item.amountUsdc)}`}
                      >
                        {formatAmount(item.amountUsdc)}
                      </p>
                    )}

                    <button
                      id={buttonId}
                      type="button"
                      className="activity-row__disclosure"
                      aria-expanded={onSelect ? undefined : isExpanded}
                      aria-controls={onSelect ? undefined : panelId}
                      aria-label={`${statusPrefix}${disclosureLabel}`}
                      onClick={(event) => {
                        if (onSelect) {
                          event.stopPropagation()
                          onSelect(item)
                          return
                        }
                        toggleExpand(item.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (onSelect) {
                            onSelect(item)
                            return
                          }
                          toggleExpand(item.id)
                        }
                      }}
                      ref={(el) => {
                        if (el) triggerRefs.current.set(item.id, el)
                        else triggerRefs.current.delete(item.id)
                      }}
                    >
                      <span aria-hidden="true">{disclosureLabel}</span>
                    </button>

                    {isExpanded && (
                      <div id={panelId} className="activity-row__detail-panel" role="region" aria-label="Details">
                        <p className="activity-row__actor">
                          <strong>Actor:</strong> {item.actor}
                        </p>
                        <p className="activity-row__meta">
                          <strong>Meta:</strong>{' '}
                          {isTxHash(item.meta) ? (
                            <CopyableHash hash={item.meta} kind="tx" />
                          ) : (
                            item.meta
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )
      )}
    </section>
  )
}

/** Re-exported for legacy callers (e.g. Trust Score surface) that
 *  previously imported `SAMPLE_ACTIVITY` directly from this module. */
export { SAMPLE_ACTIVITY, ACTIVITY_ITEMS }

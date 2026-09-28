/**
 * Realtime Michael — voice toggle + live state indicator (card rt-3, Phase 1).
 *
 * A reusable mic button for the god/orchestrator agent ("Michael"). It consumes the
 * already-built `useRealtimeMichael()` voice-loop hook (a shared module-level singleton —
 * see realtime/session.ts) and exposes a single start/stop control plus a live indicator
 * of the loop's status.
 *
 * Gating mirrors the established Free Flow / Groq precedent (FreeFlowButton in
 * MessageQueueComposer): the button stays VISIBLE but DISABLED when no BYOK OpenAI key is
 * present (`hasOpenAiKey === false`), with a tooltip pointing at Settings — so connect() /
 * getUserMedia are never reached without a key (the zero-call-when-unavailable guarantee).
 *
 * Click behaviour: status==='off' → connect(); anything else → disconnect().
 *
 * Rendered in two places (AgentCard for the god card, FullscreenTerminal header when
 * Michael is fullscreen). It is intentionally state-only / hook-only so both can mount it.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useRealtimeMichael, type RealtimeStatus } from '@/realtime/session';

/** Per-status presentation: button variant, SHORT label, dot color, and (optional)
 *  animation for the live-state indicator dot. Maps hook.status → visuals.
 *  Labels are i18n keys (`realtimeToggle.*`); the long help/title text is
 *  resolved per-render via t() since it can interpolate the error. */
const STATE_VIEW: Record<
  RealtimeStatus,
  {
    variant: 'primary' | 'secondary' | 'destructive';
    labelKey: string;
    dot: string;
    anim?: string;
    helpKey: string;
    /** When live, the button fill — a distinct accent so the active mic never
     *  reads as a flat black 'primary' button. (working uses the destructive
     *  coral variant, already non-black, so it needs no override.) */
    activeBg?: string;
  }
> = {
  off: {
    variant: 'secondary',
    labelKey: 'realtimeToggle.talk',
    dot: 'var(--cth-ink-300)',
    helpKey: 'realtimeToggle.helpOff'
  },
  connecting: {
    variant: 'secondary',
    labelKey: 'realtimeToggle.connecting',
    dot: 'var(--cth-lemon)',
    anim: 'cth-blink 700ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpConnecting'
  },
  listening: {
    variant: 'primary',
    labelKey: 'realtimeToggle.listening',
    dot: 'var(--cth-mint)',
    anim: 'cth-pulse 1000ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpListening',
    activeBg: 'var(--cth-mint)'
  },
  responding: {
    variant: 'primary',
    labelKey: 'realtimeToggle.speaking',
    dot: 'var(--cth-sky)',
    anim: 'cth-pulse 600ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpSpeaking',
    activeBg: 'var(--cth-sky)'
  },
  working: {
    variant: 'destructive',
    labelKey: 'realtimeToggle.working',
    dot: 'var(--cth-coral)',
    anim: 'cth-blink 500ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpWorking'
  }
};

export interface RealtimeMichaelToggleProps {
  /** Compact form for the fullscreen header / tight rows — hides the text label. */
  compact?: boolean;
}

export function RealtimeMichaelToggle({ compact = false }: RealtimeMichaelToggleProps) {
  const { t } = useTranslation();
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  const voiceBackend = useStore((s) => s.voiceBackend);
  const { status, error, connect, disconnect } = useRealtimeMichael();
  // Measured viewport coords, not a CSS offset. The agent dock clips its
  // children, so a popover positioned inside the card gets sliced at the card's
  // edge no matter how it is anchored — which is exactly what happened. A portal
  // to <body> with fixed coordinates leaves that clipping context entirely.
  const [hint, setHint] = useState<{ left: number; top: number } | null>(null);
  const hintRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hintOpen = hint !== null;

  const view = STATE_VIEW[status];
  const localVoice = voiceBackend === 'local-tts';

  // In local mode the loop's `listening` state means something completely
  // different: nothing is being heard, because no microphone is open. Showing
  // the live-mic treatment — green pulsing dot, "listening", mic glyph — for a
  // control that is really an announcer is not cosmetic, it tells the user the
  // wrong thing about what is happening, which is the one thing an indicator is
  // for. So the local mode gets its own visual language.
  const isAnnouncing = localVoice && status === 'listening';

  // The two backends are gated on DIFFERENT things, and getting this wrong makes
  // the local voice unreachable for exactly the people who chose it. The local
  // voice opens no session, contacts no model and needs no key — it is a speaker.
  // Gating it on a BYOK key would leave the button greyed out for the people with
  // no credits, who are the ones the local voice exists for.
  const noKey = localVoice ? false : !hasOpenAiKey;
  // The label follows what the button actually does. "Talk" in local mode would
  // promise a conversation the backend cannot hold: there is no session, so
  // nothing listens and nothing answers.
  const labelKey = isAnnouncing ? 'realtimeToggle.announcing' : view.labelKey;
  // The icon states what the control does. A microphone promises a conversation
  // the local backend cannot hold, so the announcer gets a bell instead.
  const iconName = isAnnouncing || (localVoice && status === 'off') ? 'bell' : 'mic';

  // The tooltip carries the full WHY; the quiet info affordance below gives a
  // discoverable cue so the user never just hits a silently-dead button.
  const title = noKey
    ? t('realtimeToggle.noKeyTitle')
    : error
      ? `${t(view.helpKey)} — ${error}`
      : localVoice
        ? t(status === 'off' ? 'realtimeToggle.helpAnnounceOff' : 'realtimeToggle.helpAnnounceOn')
        : t(view.helpKey);

  const onClick = () => {
    if (noKey) return;
    if (status === 'off') void connect();
    else disconnect();
  };

  // Jump straight to the tab that holds the key. App owns the Settings modal's
  // open state, so this goes through the `cth:` window-event convention rather
  // than threading a callback down through AgentCard/FullscreenTerminal.
  // Target is VOICE, not Agents & Models: the key is settable in both, but only
  // one of them explains what it is for.
  const openKeySettings = (e: MouseEvent): void => {
    e.stopPropagation();
    setHint(null);
    window.dispatchEvent(
      new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } })
    );
  };

  const HINT_W = 210;
  const HINT_GAP = 8;

  /** Place the popover against the icon in VIEWPORT space, preferring above and
   *  flipping below only when there is genuinely no room — the agent dock sits on
   *  the bottom edge, so "above" is almost always right. Both axes are clamped to
   *  the viewport so it can never hang off an edge. */
  const toggleHint = (e: MouseEvent): void => {
    e.stopPropagation();
    if (hint) { setHint(null); return; }
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    // Height is content-dependent; this is the two-line + link case, and the
    // clamp below absorbs the error if it wraps to three.
    const estH = 78;
    const above = r.top - HINT_GAP - estH;
    const top = above >= 8 ? above : Math.min(r.bottom + HINT_GAP, window.innerHeight - estH - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - HINT_W - 8));
    setHint({ left, top: Math.max(8, top) });
  };

  // Click-to-open explanation. A hover title would do for a mouse, but this sits
  // on a disabled control — the one thing people click when nothing happens — so
  // the answer belongs behind that click.
  useEffect(() => {
    if (!hintOpen) return;
    const onDown = (ev: globalThis.MouseEvent): void => {
      const t = ev.target as Node;
      // The popover is portalled out of this subtree, so an inside-click has to
      // be tested against BOTH the anchor and the floating panel.
      if (hintRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setHint(null);
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setHint(null); };
    // A dock that scrolls or a window that resizes leaves fixed coords stale, and
    // a popover stranded away from its icon is worse than one that closed.
    const onReflow = (): void => setHint(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [hintOpen]);

  // Wrap in a (non-disabled) span so the native title tooltip still shows on hover even
  // when the inner button is disabled — Chromium suppresses tooltips on a disabled button.
  return (
    <span
      title={title}
      className="cth-titlebar-nodrag"
      // minWidth:0 is what actually stops the overflow: without it this inline-flex
      // keeps its max-content width and pushes past the card's edge no matter what
      // the label inside does.
      style={{ display: 'inline-flex', alignItems: 'center', gap: noKey ? 4 : 0, minWidth: 0 }}
      // Stop the click bubbling to a parent card's onClick (selecting the agent).
      onClick={(e) => e.stopPropagation()}
    >
      <PixelButton
        variant={isAnnouncing ? 'secondary' : view.variant}
        size="sm"
        onClick={onClick}
        disabled={noKey}
        // Live mic → a clear accent fill (mint listening / sky speaking) so the
        // active button never reads as a flat black primary. Skipped when disabled
        // (no key) and when off/connecting, so those states are untouched.
        style={!noKey && view.activeBg ? { background: view.activeBg, color: 'var(--cth-ink-900)' } : undefined}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          {/* Live-state indicator dot — color + animation reflect the loop status.
              The announcer is ARMED here, not hearing: the live-mic mint pulse
              would be a lie (nothing is listening), so it gets the lemon idle
              dot instead, which is the same "on, waiting" signal the connecting
              state already uses. Speaking still goes sky, so the two states
              remain distinguishable. */}
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              background: noKey ? 'var(--cth-ink-300)' : (isAnnouncing ? 'var(--cth-lemon)' : view.dot),
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              animation: noKey ? 'none' : (isAnnouncing ? 'cth-blink 1400ms steps(2, end) infinite' : view.anim)
            }}
          />
          {/* The icon states what the control does. A microphone promises a
              conversation the local backend cannot hold — it opens no session
              and listens to nothing — so the announcer gets a bell instead. */}
          <Icon name={iconName} />
          {!compact && (
            <span style={{ fontFamily: 'var(--cth-font-ui)' }}>
              {noKey ? t('realtimeToggle.talk') : t(labelKey)}
            </span>
          )}
        </span>
      </PixelButton>
      {/* Missing key is a SETUP STATE, not a failure — so this is a quiet info mark
          and a way to fix it, never a warning chip. The old lemon chip spelled the
          whole problem out inline ("needs OpenAI key · Settings") and, being
          nowrap + flex-shrink:0, pushed itself past the agent card's edge instead
          of wrapping. The explanation now lives in the hover tooltip; what stays on
          screen is one 16px glyph plus a two-word action.

          In compact mode (fullscreen toolbar) the icon alone carries it — the
          tooltip still explains, and Settings is a click away in the same header. */}
      {noKey && (
        <span ref={hintRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button
            ref={iconRef}
            type="button"
            aria-label={t('realtimeToggle.whyDisabled')}
            aria-expanded={hintOpen}
            onClick={toggleHint}
            style={{
              border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              opacity: hintOpen ? 1 : 0.75
            }}
          >
            <Icon name="info" />
          </button>

          {hint && createPortal(
            <div
              ref={panelRef}
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: hint.left,
                top: hint.top,
                zIndex: 460,
                width: HINT_W,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                boxSizing: 'border-box',
                background: 'var(--cth-paper-100)',
                // Matches the note editor's portalled popover: hairline + a hard
                // drop shadow, so it reads as floating above the dock rather than
                // as part of whichever card it happens to cover.
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 11,
                lineHeight: '15px',
                color: 'var(--cth-ink-900)',
                textAlign: 'left',
                whiteSpace: 'normal'
              }}
            >
              <span>{t('realtimeToggle.popoverBody')}</span>
              <button
                type="button"
                onClick={openKeySettings}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  alignSelf: 'flex-start',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >
                {t('realtimeToggle.setItUpNow')}
              </button>
            </div>,
            document.body
          )}
        </span>
      )}
    </span>
  );
}

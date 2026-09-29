/**
 * Capabilities: the machine-readable answer to "who SHOULD be doing this".
 *
 * WHY A NEW FIELD AND NOT A QUERY ON `role`
 *
 * Measured on the live floor: `role` holds free text a person typed, and the
 * system had produced two spellings of one job, both live — `"Developer"` and
 * `"developer"`. Case-insensitive that is two agents, case-sensitive it is one,
 * so "all the developers" cannot be asked at all. A field that only holds what a
 * human typed cannot be queried: not by a spelling, not by a stem (a 5-char stem
 * over a plain-language question returned all four live agents, because four of
 * the eight words were stopwords), and not by a loose match that returns
 * everything.
 *
 * `role` STAYS free text, because people read it and they must be able to write
 * "Sviluppatore". But no automatic decision reads it any more. A field for people
 * and a field for machines cannot live in the same place.
 *
 * WHY `capabilities` (the field that already existed)
 *
 * It was already on `AgentMeta` and had been populated zero times out of five
 * agents, so nothing needed inventing. `modelForRole` was the one automatic
 * decision that read `role`, and it read it with a regex; it now reads
 * capabilities only.
 *
 * THE VOCABULARY IS CLOSED, and that is the whole trick
 *
 * `CAPABILITIES` is the complete list. A value outside it is dropped, never
 * coerced — coercion is how a closed list becomes free text again, which is how
 * `role` became unusable. god declared these five and said two more must be
 * asked for before anyone adds them: a vocabulary that grows on demand stops
 * being a vocabulary.
 *
 * THE RULE THAT MAKES IT RELIABLE
 *
 * A capability that designates an agent whose folder is gone answers
 * "nobody" — NOT a second candidate. This floor proved why the night of
 * 2026-09-28: `kelly-multst41` (role "VocalSender") was archived 15 seconds
 * after spawning and `kelly-multwfg2` ("Vocal Message sender") did the work, so
 * "who sends the voice messages" had two correct answers. A designation that
 * outlives the thing it designates is not a designation, it is a memory.
 */

/** The complete vocabulary. Closed on purpose — ask before adding a sixth. */
export const CAPABILITIES = [
  'orchestrator',
  'office-dev',
  'cacioverse',
  'rush-breaker',
  'voice-sender'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const KNOWN = new Set<string>(CAPABILITIES);

/** Is this value in the closed vocabulary? Exact, after trimming. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && KNOWN.has(value.trim());
}

/**
 * Keep only vocabulary values, deduped, order preserved.
 *
 * Unknown values are DROPPED and reported, never repaired: "VocalSender" does
 * not become "voice-sender" by guessing, because a guess that is wrong is
 * indistinguishable from a guess that is right until the day it is load-bearing.
 */
export function normalizeCapabilities(values: unknown): {
  kept: Capability[];
  rejected: string[];
} {
  const list = Array.isArray(values) ? values : [];
  const kept: Capability[] = [];
  const rejected: string[] = [];
  for (const raw of list) {
    if (isCapability(raw)) {
      const v = raw.trim() as Capability;
      if (!kept.includes(v)) kept.push(v);
    } else if (typeof raw === 'string' && raw.trim()) {
      rejected.push(raw.trim());
    }
  }
  return { kept, rejected };
}

/**
 * The capability the SYSTEM derives from facts it already owns, for one agent.
 *
 * The point of deriving rather than accepting: `role` is unreliable precisely
 * because a person types it, and a machine-read field that a person can also
 * type inherits every typo they ever made. Every token here comes from either
 * `isGod` (set by the harness) or `cwd` (validated at spawn), never from prose.
 *
 * `office-dev` is deliberately NOT derived: no existing fact says who is an
 * office developer, and guessing it would be inventing a designation — the one
 * thing this whole field exists to prevent.
 */
export function deriveCapabilities(meta: {
  isGod?: boolean;
  cwd?: string;
}): Capability[] {
  const out: Capability[] = [];
  if (meta.isGod) out.push('orchestrator');
  const cwd = (meta.cwd ?? '').replace(/\\/g, '/').toLowerCase();
  if (cwd) {
    // The office IS munder-difflin, so the office lane derives from it. This
    // hole was pointed out on 2026-09-29: the field that answers "who should"
    // was built on a table that did not cover the office, and a hole in the
    // table is a hole in the answer.
    if (cwd.includes('/munder-difflin')) out.push('office-dev');
    if (cwd.includes('/rush-breaker')) out.push('rush-breaker');
    if (cwd.includes('/cacioverse')) out.push('cacioverse');
  }
  return out;
}

/**
 * Capabilities the system CANNOT derive, each with the reason.
 *
 * Exported so the list of holes is part of the module's surface rather than a
 * comment nobody re-reads: a hole nobody wrote down is a hole someone will
 * rediscover as a missing answer.
 *
 * `voice-sender` is here because of a counterexample, not a hunch. On
 * 2026-09-28 the office lane held TWO agents in cwd `munder-difflin` and only
 * one of them sent voice messages — the other is its developer. A directory
 * cannot tell those two apart, so anything derived from cwd would have
 * designated BOTH, which is precisely the "two correct answers" failure this
 * field exists to remove. Deriving it would have been inventing a designation.
 * It needs a fact the system does not yet have.
 */
export const NOT_DERIVABLE: ReadonlyArray<{
  capability: Capability;
  because: string;
}> = [
  {
    capability: 'voice-sender',
    because:
      'two agents share cwd munder-difflin and only one sends voice messages, so a directory cannot designate a function. Needs a fact the system does not have yet.'
  }
];

/** The minimal registry shape this module needs. */
export interface CapabilityRosterEntry {
  id: string;
  capabilities?: unknown;
  archived?: boolean;
}

export interface WhoShouldDoResult {
  /** The capability asked about, normalized. */
  capability: string;
  /** Agents that should be doing it. Empty means NOBODY, and that is an answer. */
  agents: string[];
  /** True when the value is not in the closed vocabulary at all. */
  unknownCapability: boolean;
  /**
   * Ids that hold the capability but cannot be counted: archived, or their
   * folder is gone. Reported so that "nobody" is never a silent shrug — the
   * caller can see a designation pointing at a corpse.
   */
  deadDesignations: string[];
  /** More than one live agent holds it: an ambiguous designation, not a pick. */
  ambiguous: boolean;
}

export interface WhoShouldDoDeps {
  /** True when this agent's own folder exists on disk. */
  agentFolderExists: (id: string) => boolean;
}

/**
 * Who SHOULD be doing this — the answer read off designations, not off names.
 *
 * `agentFolderExists` is injected rather than reaching for a path so the rule
 * that matters (a dead folder means nobody) is testable without a filesystem,
 * and so this module stays free of hive-root knowledge.
 *
 * Returns a result object rather than a bare list on purpose: a caller that
 * gets `[]` must be able to tell "nobody is designated" from "you asked for
 * something that is not a capability" from "two people are designated", and a
 * bare array makes all three look identical — which is the confusion that cost
 * two people 197 seconds each.
 */
export function whoShouldDo(
  roster: CapabilityRosterEntry[] | Record<string, CapabilityRosterEntry>,
  capability: string,
  deps: WhoShouldDoDeps
): WhoShouldDoResult {
  const entries = Array.isArray(roster)
    ? roster
    : Object.values((roster ?? {}) as Record<string, CapabilityRosterEntry>);
  const wanted = typeof capability === 'string' ? capability.trim() : '';
  const known = isCapability(wanted);
  const empty: WhoShouldDoResult = {
    capability: wanted,
    agents: [],
    unknownCapability: !known,
    deadDesignations: [],
    ambiguous: false
  };
  if (!known) return empty;

  const agents: string[] = [];
  const deadDesignations: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    const { kept } = normalizeCapabilities(entry.capabilities);
    if (!kept.includes(wanted as Capability)) continue;
    // A designation survives its subject, it is a memory. Archive OR a missing
    // folder means this candidate does not exist as a worker, so it is reported
    // and excluded — and there is deliberately no fallback to another holder.
    if (entry.archived || !deps.agentFolderExists(entry.id)) {
      deadDesignations.push(entry.id);
      continue;
    }
    agents.push(entry.id);
  }
  return {
    capability: wanted,
    agents,
    unknownCapability: false,
    deadDesignations,
    ambiguous: agents.length > 1
  };
}

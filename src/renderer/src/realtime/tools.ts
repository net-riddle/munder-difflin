/**
 * Realtime Michael — read-tools (rt-4, Realtime Michael Phase 1).
 *
 * The real function-tools that replace rt-2's placeholder no-op. Each one is a
 * thin, READ-ONLY wrapper over a window.cth bridge that already powers the office
 * floor UI, formatted as short spoken prose — a TTS voice reads these aloud, so
 * there is no markdown, no bullet characters, and no asterisks. Phase 1 is
 * read-only by construction: there is not a single mutating call in this file
 * (action-tools are rt-5, held).
 *
 * SECURITY: tools run in the RENDERER and only touch already-exposed read IPC.
 * The real OpenAI key never appears here (rt-1's mint keeps it main-only). And
 * get_config NEVER dumps HarnessConfig — that object carries secrets
 * (groqApiKey, slack/webhook tokens); we surface a hand-picked, non-sensitive
 * allowlist only.
 *
 * INTEGRATION (rt-2's src/renderer/src/realtime/session.ts — Jim's file):
 *   import { realtimeReadTools, realtimeSessionSummary } from './tools';
 *   ...
 *   tools: realtimeReadTools()            // swap for placeholderTools() at the `tools:` field
 * and optionally prepend `await realtimeSessionSummary()` to the agent instructions
 * for a warm-start orientation. The agent_tool_start / agent_tool_end mic-idle
 * lifecycle in session.ts is tool-agnostic, so it survives the swap unchanged.
 */
import { tool } from '@openai/agents-realtime';
import i18n from 'i18next';
import { interpolate, VOICE_PHRASES, type VoiceVars } from '@shared/voicePhrases';

// ─── spoken-prose formatting helpers ────────────────────────────────────────
//
// Everything in this file is eventually READ ALOUD: these strings are tool
// results, the model repeats them, and the voice speaks them. So the sentences
// are localized through the `rt.*` keyspace (see the `rt` block in the locale
// files) rather than written inline — the same reason the action layer returns
// a phrase key instead of prose.
//
// Two things are deliberately NOT localized, and the line between them matters:
//   - the DATA half of a result (the JSON payload appended to a summary) — that
//     is machine-readable context for the model, not something to pronounce;
//   - a card title or a message body, which is text an agent or a person wrote.
//     Translating those puts words in someone's mouth.
// The number formatting below is shared by both, and it is language-neutral
// except for the magnitude words, which are keys.

const t = (key: string, vars?: Record<string, unknown>): string =>
  interpolate(
    (i18n.t(`rt.${key}`) as unknown as string) || VOICE_PHRASES[`rt.${key}`] || key,
    (vars ?? {}) as VoiceVars
  );

/** Relative "x ago" for a unix-ms timestamp; voice-safe and defensive. */
function ago(ts: unknown): string {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return t('ago.unknown');
  const ms = Date.now() - ts;
  if (ms < 5_000) return t('ago.now');
  const s = Math.round(ms / 1000);
  if (s < 60) return t('ago.seconds', { count: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('ago.minutes', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('ago.hours', { count: h });
  const d = Math.round(h / 24);
  return t('ago.days', { count: d });
}

/** Humanize an interval in ms into spoken cadence ("every 5 minutes"). */
function every(ms: unknown): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return t('cadence.unknown');
  const m = Math.round(ms / 60_000);
  if (m < 1) return t('cadence.under_minute');
  if (m < 60) return t('cadence.minutes', { count: m });
  const h = Math.round(m / 60);
  return t('cadence.hours', { count: h });
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Compact a big number for speech (1.2 thousand / 3.4 million). */
function tokens(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v >= 1_000_000) return t('num.million', { value: (v / 1_000_000).toFixed(1) });
  if (v >= 1_000) return t('num.thousand', { value: (v / 1_000).toFixed(1) });
  return `${Math.round(v)}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + ' (truncated)' : s;
}

/** The trailing folder name of a path — speech-friendly (the persona avoids
 *  reading full file paths aloud unless asked). e.g. /a/b/cth-voice-tools → cth-voice-tools. */
function shortDir(p: string): string {
  const parts = (p || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Strip markdown to plain speakable prose (headers, emphasis, bullets, links,
 *  code fences) and collapse whitespace. */
function despan(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Wrap a tool body so a read failure degrades to a spoken sentence rather than
 *  rejecting the model's tool call. */
async function spoken(fn: () => Promise<string>, what: string): Promise<string> {
  try {
    const out = (await fn()).trim();
    return out || t('tool.none_found', { what });
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('ago.unknown');
    return t('tool.read_failed', { what, reason: msg });
  }
}

// ─── the read-tools ──────────────────────────────────────────────────────────

/**
 * The real Phase-1 read-tools. Returned as an array so rt-2's session can pass it
 * straight to `tools:` in place of placeholderTools().
 */
export function realtimeReadTools(): ReturnType<typeof tool>[] {
  return [
    // ── get_fleet_status ──────────────────────────────────────────────────
    tool({
      name: 'get_fleet_status',
      description:
        'Who is in the agent hive right now: how many agents, which are active versus archived, who the god orchestrator is, and each active agent name, role, and engine. Call this when the user asks who is working, who is on the floor, or for a roster.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const reg = await window.cth.hiveRegistry();
          const entries = Object.entries(obj(reg.agents));
          if (!entries.length) return t('tool.no_agents');
          const active = entries.filter(([, a]) => !obj(a).archived);
          const archived = entries.length - active.length;
          const godId = reg.godId;
          const godName = godId ? str(obj(obj(reg.agents)[godId]).name) || godId : null;
          const lines = active
            .filter(([id]) => id !== godId)
            .map(([, a]) => {
              const m = obj(a);
              const name = str(m.name) || t('tool.unnamed_agent');
              const role = str(m.role);
              const provider = str(m.provider) || 'claude';
              const status = str(m.status) || t('tool.unknown');
              return t('tool.roster_line', { name, role, provider, status });
            });
          const head = t('tool.fleet_head', {
            count: active.length,
            archived: archived ? t('tool.archived_agents', { count: archived }) : ''
          });
          const god = godName ? ` ${t('tool.is_god', { god: godName })}` : '';
          const roster = lines.length ? ` ${t('tool.active_workers', { list: lines.join('; ') })}` : '';
          return head + god + roster;
        }, t('tool.what_fleet'))
    }),

    // ── get_tasks ─────────────────────────────────────────────────────────
    tool({
      name: 'get_tasks',
      description:
        'The current task board: how many tasks are todo, in progress, blocked, and done, plus the titles and owners of the in-progress and blocked ones. Optionally filter by a single status. Call this when the user asks what the team is working on, what is blocked, or about progress.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'doing', 'blocked', 'done'],
            description: 'Optional. Restrict the answer to one status.'
          }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const filter = typeof a.status === 'string' ? a.status : null;
          const raw = await window.cth.hiveTasks();
          const list = Array.isArray(obj(raw).tasks) ? (obj(raw).tasks as unknown[]) : [];
          if (!list.length) return t('tool.board_empty');
          const tasks = list.map(obj);
          const by = (s: string): Record<string, unknown>[] => tasks.filter((c) => str(c.status) === s);
          const counts = t('tool.counts', {
            todo: by('todo').length,
            doing: by('doing').length,
            blocked: by('blocked').length,
            done: by('done').length
          });
          const describe = (c: Record<string, unknown>): string => {
            const who = str(c.assignee);
            return `"${clip(str(c.title) || str(c.id) || t('tool.untitled'), 90)}"${who ? ` (${who})` : ''}`;
          };
          if (filter) {
            const sel = by(filter);
            if (!sel.length) return t('tool.nothing_that_status', { filter, counts });
            return t('tool.filtered_tasks', { count: sel.length, filter, list: sel.slice(0, 12).map(describe).join('; ') });
          }
          const doing = by('doing');
          const blocked = by('blocked');
          const detail = [
            doing.length ? t('tool.doing_detail', { list: doing.slice(0, 8).map(describe).join('; ') }) : '',
            blocked.length ? t('tool.blocked_detail', { list: blocked.slice(0, 8).map(describe).join('; ') }) : ''
          ]
            .filter(Boolean)
            .join(' ');
          return t('tool.board_summary', { count: tasks.length, counts, detail });
        }, t('tool.what_board'))
    }),

    // ── get_cost ──────────────────────────────────────────────────────────
    tool({
      name: 'get_cost',
      description:
        'How much the hive is USING this session: total tokens across all agents, plus the top users. Reported in tokens (no dollar figures). Call this when the user asks about usage or token consumption.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const snap = await window.cth.telemetrySnapshot();
          const usage = Array.isArray(snap.usage) ? snap.usage : [];
          if (!usage.length) return t('tool.no_usage');
          let totIn = 0;
          let totOut = 0;
          const perAgent = new Map<string, number>();
          for (const s of usage) {
            const m = obj(s);
            const inTok = typeof m.input === 'number' ? m.input : 0;
            const outTok = typeof m.output === 'number' ? m.output : 0;
            totIn += inTok;
            totOut += outTok;
            const id = str(m.agentId) || t('tool.unknown');
            perAgent.set(id, (perAgent.get(id) ?? 0) + inTok + outTok);
          }
          const top = [...perAgent.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([id, tok]) => t('tool.top_user', { who: id, tokens: tokens(tok) }));
          return t('tool.cost_summary', {
            input: tokens(totIn),
            output: tokens(totOut),
            agents: perAgent.size,
            top: top.length ? t('tool.top_users', { list: top.join(', ') }) : ''
          });
        }, t('tool.what_usage'))
    }),

    // ── get_triggers ──────────────────────────────────────────────────────
    tool({
      name: 'get_triggers',
      description:
        'The triggers that fire the hive without a human typing. Today this reports the schedules: the recurring missions the hive runs on a timer, with their labels, cadence, recipient, and when each last fired. The other trigger types — webhooks and inbound organization messages — are configured elsewhere and are not listed here. Call this when the user asks about triggers, schedules, recurring jobs, heartbeats, or automations.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const missions = await window.cth.listMissions();
          const list = Array.isArray(missions) ? missions : [];
          if (!list.length) return t('tool.no_schedules');
          const enabled = list.filter((m) => obj(m).enabled);
          if (!enabled.length) return t('tool.schedules_all_disabled', { count: list.length });
          const lines = enabled.slice(0, 8).map((m) => {
            const o = obj(m);
            const label = str(o.label) || t('tool.a_mission');
            const to = str(o.to);
            const last = o.lastFiredAt ? t('tool.last_fired', { when: ago(o.lastFiredAt) }) : t('tool.not_fired');
            return `${label} ${every(o.intervalMs)}${to ? t('tool.to', { who: to }) : ''}${last}`;
          });
          return t('tool.active_schedules', { count: enabled.length, list: lines.join('; ') });
        }, t('tool.what_schedules'))
    }),

    // ── get_config ────────────────────────────────────────────────────────
    tool({
      name: 'get_config',
      description:
        'The non-sensitive hive settings: autonomy mode, the default model and god engine, budget caps, worker limits, the circuit breaker, and which features are on. Never returns secrets or API keys. Call this when the user asks how the hive is configured, what the limits or budgets are, or whether a feature is enabled.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const c = await window.cth.getConfig();
          // Hand-picked NON-SENSITIVE allowlist. Never iterate the object — it
          // carries groqApiKey, slack/webhook tokens, and signing secrets. Read
          // through obj() so the renderer's HarnessConfig mirror can lag the main
          // one (it is hand-mirrored across three files) without breaking us.
          const cc = obj(c);
          const parts: string[] = [];
          parts.push(`Autonomy mode is ${c.autoMode ? 'on' : 'off'}.`);
          if (c.defaultModel) parts.push(`The default model is ${c.defaultModel}.`);
          if (c.godProvider || c.godModel)
            parts.push(`The god orchestrator runs ${[c.godProvider, c.godModel].filter(Boolean).join(' ')}.`);
          if (typeof cc.maxConcurrentWorkers === 'number')
            parts.push(`Up to ${plural(cc.maxConcurrentWorkers, 'worker')} run concurrently.`);
          // De-monetized: report only the token cap (no dollar cap), and avoid
          // money words. The $ runaway guard still exists + fires; it just isn't spoken.
          if (typeof c.costCapTokens === 'number' && c.costCapTokens > 0)
            parts.push(`Token cap: ${tokens(c.costCapTokens)} tokens.`);
          const breakerOn = obj(c.circuitBreaker).enabled;
          parts.push(`The circuit breaker is ${breakerOn ? 'enabled' : 'off'}.`);
          parts.push(`Desktop notifications are ${c.notifications ? 'on' : 'off'}.`);
          const features = [
            c.slackEnabled && 'Slack',
            c.webhookEnabled && 'webhooks',
            c.freeflowEnabled && 'Free Flow voice',
            c.realtimeVoiceEnabled && 'realtime voice (this session)',
            c.semanticMemory && 'semantic memory',
            obj(c.knowledgeGraph).enabled && 'the knowledge graph'
          ].filter(Boolean);
          if (features.length) parts.push(`Enabled features: ${features.join(', ')}.`);
          return parts.join(' ');
        }, 'configuration')
    }),

    // ── get_memory ────────────────────────────────────────────────────────
    tool({
      name: 'get_memory',
      description:
        "Read the team's memory. You can ALWAYS answer with this — it never dead-ends. Pass a query to search everything the hive has learned; pass an agentId to read ONE agent's notes (works for any agent, active OR archived); pass BOTH to search within that one agent's notes; pass neither for memory status. Semantic search is used when available, otherwise a direct text search across every agent's memory file. Call this whenever the user asks what the team learned, remembered, decided, or noted.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Optional. What to search for across the team's memory." },
          agentId: { type: 'string', description: "Optional. An agent id to read or scope the search to — any agent, active or archived." }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const query = str(a.query).trim();
          const agentId = str(a.agentId).trim();

          // Direct text fallback across every agent's memory.md (INCLUDING archived
          // agents), the board, and tasks — works with or without the semantic
          // memory CLI, so a query can never dead-end. Optionally narrow to one agent.
          const textFallback = async (q: string, onlyAgent?: string): Promise<string> => {
            const res = await window.cth.textSearch(q);
            if (!res.ok || !res.results.length) return '';
            let hits = res.results;
            if (onlyAgent) hits = hits.filter((r) => r.source.startsWith(`${onlyAgent}/`) || r.source === onlyAgent);
            if (!hits.length) return '';
            const bySource = new Map<string, string[]>();
            for (const r of hits.slice(0, 14)) {
              const who = r.source.replace(/\/memory\.md$/, '');
              if (!bySource.has(who)) bySource.set(who, []);
              bySource.get(who)!.push(r.excerpt);
            }
            const lines = [...bySource.entries()].slice(0, 6).map(([who, ex]) => t('tool.noted', { who, what: ex.slice(0, 2).join('; ') }));
            return t('tool.team_notes', { list: lines.join('. ') });
          };

          // query + agentId → search WITHIN one agent (semantic wing first, then text).
          if (query && agentId) {
            const res = await window.cth.searchMemory(query, agentId);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query, agentId);
            if (tf) return clip(tf, 1600);
            const mem = await window.cth.hiveMemory(agentId);
            const ql = query.toLowerCase();
            const matched = mem.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes(ql)).slice(0, 8);
            if (matched.length) return clip(t('tool.from_agent_memory', { who: agentId, what: matched.join(' ') }), 1600);
            return mem.trim()
              ? t('tool.nothing_about', { who: agentId, query })
              : t('tool.no_memory_yet', { who: agentId });
          }

          // query alone → semantic across the whole palace, then text fallback across all agents.
          if (query) {
            const res = await window.cth.searchMemory(query);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query);
            if (tf) return clip(tf, 1600);
            return t('tool.searched_nothing', { query });
          }

          // agentId alone → read that agent's notes directly (any agent, active OR archived).
          if (agentId) {
            const mem = await window.cth.hiveMemory(agentId);
            return mem.trim() ? clip(mem.trim(), 1600) : t('tool.no_memory_yet', { who: agentId });
          }

          // neither → status, but make clear search always works.
          const status = await window.cth.memoryStatus();
          const sem = status.active
            ? t('tool.mem_active')
            : status.available
            ? t('tool.mem_idle')
            : t('tool.mem_offline');
          return `${sem}${t('tool.mem_always_search')}`;
        }, 'memory')
    }),

    // ── get_activity ──────────────────────────────────────────────────────
    tool({
      name: 'get_activity',
      description:
        'The most recent hive activity log: spawns, archives, messages, and other lifecycle events, newest first. Call this when the user asks what just happened, for recent activity, or for a play-by-play.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Optional. How many recent events to summarize (default 12, max 40).' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 12;
          const log = await window.cth.hiveLog(want);
          const list = Array.isArray(log) ? log : [];
          if (!list.length) return t('tool.no_activity');
          const lines = list
            .slice(-want)
            .reverse()
            .map((e) => {
              const o = obj(e);
              const kind = str(o.kind) || str(o.event) || t('tool.event');
              const who = str(o.agentId) || str(o.name) || str(o.from);
              const when = ago(o.ts);
              return `${kind}${who ? t('tool.by', { who }) : ''} ${when}`;
            });
          return t('tool.most_recent_activity', { list: lines.join('; ') });
        }, t('tool.what_activity'))
    }),

    // ── get_messages ──────────────────────────────────────────────────────
    tool({
      name: 'get_messages',
      description:
        "Read the actual CONTENT of hive messages — what agents have said to each other in their inboxes and outboxes, not just that an event happened. Use this when the user wants to know what a message SAID, what someone asked or reported, or to catch up on the latest traffic. Pass an agentId to focus on one agent's mailbox, pass a messageId to read one specific message in full, or pass neither for the most recent messages across the whole floor. Secrets and keys are always stripped before you see them, so quote bodies freely.",
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: "Optional. Focus on one agent's inbox and outbox (id or, if you have it, the exact id)." },
          messageId: { type: 'string', description: 'Optional. Read one specific message in full by its id.' },
          limit: { type: 'number', description: 'Optional. How many recent messages to summarize (default 8, max 40).' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const agentId = str(a.agentId).trim();
          const messageId = str(a.messageId).trim();
          const limit = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 8;

          // Speak one message's body relative to a perspective. from→to + subject + body.
          // The SUBJECT and BODY are somebody's words — never translated, only
          // the frame around them is.
          const speakOne = (m: { from: string; to: string; subject: string; body: string; created_at: string; requires_reply: boolean }, full: boolean): string => {
            const subj = str(m.subject).trim();
            const body = despan(str(m.body)).trim();
            const head = t('tool.msg_head', {
              from: str(m.from) || t('tool.someone'),
              to: str(m.to) || t('tool.someone'),
              subject: subj ? t('tool.msg_about', { subject: clip(subj, 80) }) : '',
              when: ago(Date.parse(m.created_at))
            });
            if (!body) return t('tool.msg_no_body', { head });
            return `${head}: ${clip(body, full ? 700 : 220)}${m.requires_reply ? t('tool.msg_reply_wanted') : ''}`;
          };

          if (messageId) {
            const found = await window.cth.hiveMessages({ id: messageId });
            if (!found.length) return t('tool.no_message_id', { id: messageId });
            return t('tool.that_message', { what: speakOne(found[0], true) });
          }

          const msgs = await window.cth.hiveMessages(agentId ? { agentId, limit } : { limit });
          if (!msgs.length) {
            return agentId
              ? t('tool.mailbox_empty', { who: agentId })
              : t('tool.no_messages_yet');
          }
          const scope = agentId ? t('tool.scope_agent', { who: agentId }) : t('tool.scope_floor');
          const lines = msgs.slice(0, limit).map((m) => speakOne(m, false));
          return t('tool.recent_messages', { count: lines.length, scope, list: lines.join('. ') });
        }, t('tool.what_messages'))
    }),

    // ── get_agent_detail ──────────────────────────────────────────────────
    tool({
      name: 'get_agent_detail',
      description:
        'Everything known about ONE agent: name, role, the engine and model it runs, its working directory, whether it is active or archived, its live status, how full its context window is, how many tokens it has used, its circuit-breaker state, what it last did, and whether it has recorded memory. Call this when the user asks about a specific agent — where it is working, which directory it is in, how it is doing, or for its full status. Accepts an id or a name.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agent id or friendly name to look up (e.g. "kevin-mqpbq43v" or "Kevin").' }
        },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = str(a.agentId).trim().toLowerCase();
          if (!want) return t('tool.which_agent');
          const dir = await window.cth.hiveAgentDirectory();
          const list = Array.isArray(dir.agents) ? dir.agents : [];
          const e =
            list.find((x) => x.id.toLowerCase() === want) ??
            list.find((x) => x.name.toLowerCase() === want) ??
            list.find((x) => x.id.toLowerCase().startsWith(want) || x.name.toLowerCase().startsWith(want));
          if (!e) return t('tool.no_agent_match', { ref: str(a.agentId) });
          const parts: string[] = [];
          const role = e.role ? `, the ${e.role},` : '';
          const where = e.archived
            ? 'archived — its terminal is closed, but its working directory and memory are still here'
            : `active and ${e.status}`;
          parts.push(`${e.name}${role} runs on ${e.provider}${e.model ? ` with model ${e.model}` : ''}, ${where}.`);
          if (e.cwd)
            parts.push(
              `Working directory: ${e.cwd}${e.cwdValid === false ? ', which is not a valid directory — spawning there would fail' : ''}.`
            );
          if (typeof e.contextPct === 'number') parts.push(`Its context window is ${e.contextPct} percent full.`);
          else if (typeof e.contextTokens === 'number') parts.push(`It is carrying ${tokens(e.contextTokens)} tokens of context.`);
          if (e.tokens) parts.push(`It has used ${tokens(e.tokens)} tokens so far.`);
          parts.push(`Circuit breaker: ${e.breaker}.`);
          if (e.lastTool) parts.push(`Last tool was ${e.lastTool}${typeof e.lastActiveSecAgo === 'number' ? `, ${ago(Date.now() - e.lastActiveSecAgo * 1000)}` : ''}.`);
          if (e.inboxBacklog) parts.push(`${plural(e.inboxBacklog, 'message')} waiting in its inbox.`);
          parts.push(e.hasMemory ? "It has recorded memory — ask me to read it." : 'It has not recorded much memory yet.');
          return parts.join(' ');
        }, 'agent detail')
    }),

    // ── list_agents ───────────────────────────────────────────────────────
    tool({
      name: 'list_agents',
      description:
        'The FULL roster, including archived (inactive) agents: each one\'s name, engine, active-or-archived state, working directory, context fill, and breaker state. Use this to enumerate EVERYONE (including inactive agents), or to answer "where is X working", "who is archived", or "who is near their context limit". For live workers only, get_fleet_status is lighter.',
      parameters: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean', description: 'Default true. Set false to list only active agents.' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const includeArchived = a.includeArchived !== false;
          const dir = await window.cth.hiveAgentDirectory();
          const all = Array.isArray(dir.agents) ? dir.agents : [];
          if (!all.length) return t('tool.no_agents');
          const active = all.filter((e) => !e.archived);
          const archived = all.filter((e) => e.archived);
          const near = active
            .filter((e) => typeof e.contextPct === 'number' && e.contextPct >= 70)
            .map((e) => `${e.name} at ${e.contextPct} percent`);
          const describe = (e: typeof all[number]): string =>
            `${e.name} on ${e.provider}${e.cwd ? ` in ${shortDir(e.cwd)}` : ''}${
              typeof e.contextPct === 'number' ? `, context ${e.contextPct} percent` : ''
            }`;
          const parts: string[] = [];
          parts.push(
            `${plural(active.length, 'active agent')}${archived.length ? ` and ${plural(archived.length, 'archived agent')}` : ''}.`
          );
          if (active.length) parts.push(`Active: ${active.slice(0, 12).map(describe).join('; ')}.`);
          if (includeArchived && archived.length)
            parts.push(
              `Archived: ${archived
                .slice(0, 12)
                .map((e) => `${e.name}${e.cwd ? ` (last in ${shortDir(e.cwd)})` : ''}`)
                .join('; ')}.`
            );
          if (near.length) parts.push(`Near their context limit: ${near.join(', ')}.`);
          return parts.join(' ');
        }, 'agent roster')
    }),

    // ── get_board ─────────────────────────────────────────────────────────
    tool({
      name: 'get_board',
      description:
        'The hive plan narrative — the human-readable board the orchestrator keeps in prose (the current plan, priorities, and notes). Call this when the user asks about the plan, the strategy, the roadmap, or what the board says.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const board = await window.cth.hiveBoard();
          const text = despan(board || '');
          if (!text) return t('tool.board_empty_now');
          return clip(text, 1800);
        }, 'board')
    }),

    // ── get_floor_state (v0.3.4) ──────────────────────────────────────────
    tool({
      name: 'get_floor_state',
      description:
        'The LIVE floor in one call: every active agent with its current status, context fill, breaker state and inbox backlog, plus in-flight tasks. Returns compact JSON plus a one-line spoken summary. Prefer this for "what is everyone doing" style questions.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const dir = await window.cth.hiveAgentDirectory();
          const tasksRaw = (await window.cth.hiveTasks()) as { tasks?: unknown } | null;
          const tasks = Array.isArray(tasksRaw?.tasks) ? (tasksRaw!.tasks as unknown[]).map(obj) : [];
          const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : [])
            .map(obj)
            .filter((a) => !a.archived)
            .map((a) => ({
              name: str(a.name) || str(a.id),
              status: str(a.status) || 'unknown',
              engine: str(a.provider) || undefined,
              contextPct: typeof a.contextPct === 'number' ? a.contextPct : undefined,
              breaker: str(a.breaker) && str(a.breaker) !== 'healthy' ? str(a.breaker) : undefined,
              inbox: typeof a.inboxBacklog === 'number' && a.inboxBacklog > 0 ? a.inboxBacklog : undefined
            }));
          const doing = tasks.filter((t) => str(t.status) === 'doing').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const blocked = tasks.filter((t) => str(t.status) === 'blocked').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const summary = `${plural(rows.length, 'agent')} on the floor, ${doing.length} in progress, ${blocked.length} blocked.`;
          // Flagged JSON per the Realtime prompting guidance: precise fields the
          // model can quote verbatim, with the spoken line separate.
          return `${summary} DATA: ${JSON.stringify({ agents: rows, doing, blocked })}`;
        }, 'floor state')
    }),

    // ── get_app_info (v0.3.4) ─────────────────────────────────────────────
    tool({
      name: 'get_app_info',
      description:
        'About the Munder Difflin app itself: the running version and the latest release notes (changelog). Use for "what version is this" or "what is new in this release".',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const info = await window.cth.appInfo();
          const notes = despan(info.changelog || '');
          // The release notes themselves are ENGLISH on purpose: they are a
          // verbatim document shipped with the build, and translating a
          // changelog would mean shipping a second, drifting one.
          return t('tool.app_version', { version: info.version }) + ' ' +
            (notes ? t('tool.release_notes', { notes: clip(notes, 1600) }) : t('tool.no_notes'));
        }, t('tool.what_app'))
    })
  ];
}

/**
 * A short, preloaded orientation Michael can open the session with — the hive
 * size, who god is, and how many tasks are in flight — so the first answer is
 * grounded without a tool round-trip. Best-effort: returns '' if reads fail, so
 * the caller can safely concatenate it onto the agent instructions.
 */
export async function realtimeSessionSummary(): Promise<string> {
  try {
    // v0.3.4: a COMPACT PER-AGENT TABLE, not just counts — most "what's
    // happening" questions should be answerable from this alone, with zero
    // tool round-trips. Injected as the FIRST CONVERSATION ITEM (not into the
    // instructions), so the cached prompt prefix stays byte-stable.
    const [dir, tasksRaw] = await Promise.all([
      window.cth.hiveAgentDirectory(),
      window.cth.hiveTasks()
    ]);
    const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : []).map(obj).filter((a) => !a.archived);
    const godRow = rows.find((a) => a.isGod === true);
    const lines = rows.slice(0, 20).map((a) => {
      const bits = [
        `${str(a.name) || str(a.id)} is ${str(a.status) || 'in an unknown state'}`,
        str(a.provider) ? `on ${str(a.provider)}` : '',
        typeof a.contextPct === 'number' ? `context ${Math.round(a.contextPct as number)} percent full` : '',
        str(a.breaker) && str(a.breaker) !== 'healthy' ? `breaker ${str(a.breaker)}` : '',
        typeof a.inboxBacklog === 'number' && (a.inboxBacklog as number) > 0 ? `${a.inboxBacklog} unread` : ''
      ].filter(Boolean);
      return bits.join(', ');
    });
    const list = Array.isArray(obj(tasksRaw).tasks) ? (obj(tasksRaw).tasks as unknown[]).map(obj) : [];
    const doing = list.filter((t) => str(t.status) === 'doing');
    const blocked = list.filter((t) => str(t.status) === 'blocked');
    const taskLine = [
      doing.length
        ? `In progress: ${doing.slice(0, 5).map((t) => `"${str(t.title)}"${str(t.assignee) ? ` with ${str(t.assignee)}` : ''}`).join('; ')}.`
        : 'Nothing is in progress on the board.',
      blocked.length ? `Blocked: ${blocked.slice(0, 4).map((t) => `"${str(t.title)}"`).join('; ')}.` : ''
    ].filter(Boolean).join(' ');
    return (
      `Floor at connect — ${plural(rows.length, 'agent')} active` +
      `${godRow ? `, ${str(godRow.name)} orchestrating alongside you` : ''}. ` +
      `Per agent: ${lines.join(' | ') || 'none'}. ` +
      taskLine +
      ` You will also receive short "(Floor update: …)" notes as things change mid-call — trust those over this snapshot.` +
      ` You share the floor with god (the typing orchestrator); the board is the single source of truth.`
    );
  } catch {
    return '';
  }
}

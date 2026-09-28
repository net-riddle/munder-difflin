/**
 * Realtime Michael — WHAT gets said, expressed as data instead of English prose.
 *
 * WHY THIS EXISTS
 *
 * Every `spoken` string in realtimeActions.ts used to be a literal English
 * sentence assembled in MAIN. That is unfixable from main: the language the user
 * picked lives in the RENDERER's localStorage, and main has no channel to it. So
 * a user running the whole app in Italian got an Italian interface and an English
 * orchestrator, which is worse than either — the voice is the one channel with no
 * visual context to disambiguate it.
 *
 * So main returns a MESSAGE KEY plus its variables, and the renderer turns that
 * into a sentence with the i18next instance it already holds. This module owns
 * both halves of that contract:
 *
 *   - {@link VoicePhrase}: the key + the data, which is what main now produces
 *   - {@link renderVoicePhrase}: the resolver, which is what the renderer calls
 *
 * THE KEY IS THE CONTRACT. A key that has no translation renders as the English
 * text, never as a bare key string: a wrong key should be a missing translation
 * in a language you can read, not `voice.dispatch.no_objective` spoken aloud.
 * Every key therefore carries its English text beside it, and that text is also
 * the source of truth the locale files are checked against.
 *
 * Pure + dependency-free (no electron, no main-only imports) so main, the
 * renderer, and the tests can all import it — the same reason realtimePricing.ts
 * and realtimeVoice.ts live in shared.
 */

/** Variables a phrase may interpolate. A closed set on purpose: a voice
 *  sentence is built from a name, a task title, a setting key and a number, and
 *  anything else is a sign the message is being misused. */
export interface VoiceVars {
  /** Agent display name, or a task/setting identifier. */
  who?: string;
  /** A card title, or a chunk of what the user said. */
  what?: string;
  /** A task id or schedule label. */
  ref?: string;
  /** A config key, e.g. `freeflowEnabled`. */
  key?: string;
  /** A number, already formatted for speech. */
  value?: string;
  /** A number bound, already formatted. */
  bound?: string;
  /** A tool name, e.g. `Bash`. */
  tool?: string;
  /** The verb the user asked for. */
  verb?: string;
  /** A status name, e.g. `doing`. */
  status?: string;
  /** A boolean rendered as words. */
  onoff?: string;
  /** A list of candidate titles, already joined. */
  list?: string;
  /** An error message from a lower layer. */
  reason?: string;
  /** A job title, for the hire path. */
  role?: string;
  /** The word that must be said to authorize a destructive op. */
  confirmWord?: string;
  /** The setting's PREVIOUS value, for the change echo-back. */
  was?: string;
  /**
   * A nested phrase, written as `{{some.key}}`. The renderer resolves it as a
   * phrase in its own right, so a sentence can hold a whole clause in another
   * position without main concatenating English into the middle of it.
   */
  note?: string;
  /** A nested phrase — see {@link VoiceVars.note}. */
  consequence?: string;
  /** A nested phrase — see {@link VoiceVars.note}. */
  now?: string;
}

/** A message to say, as data. */
export interface VoicePhrase {
  /** A dotted key under `voice.`, e.g. `dispatch.no_objective`. */
  key: string;
  vars?: VoiceVars;
}

/**
 * Every phrase the voice can say, with its English text.
 *
 * Two jobs, and the second is the one people forget: this table is the
 * translation SOURCE. `test/voice-phrase-i18n.test.cjs` reads the locale files
 * and fails if a key here has no counterpart in a language — because a missing
 * key fails silently at runtime (i18next falls back), and the only symptom is one
 * sentence in the wrong language that nobody reports.
 *
 * Keep the English here EXACTLY as it reads today, punctuation included. Some
 * languages need a different order or a different ending, which is what the
 * locale file is for; the English is the fallback when one is missing.
 */
export const VOICE_PHRASES: Record<string, string> = {
  // ── ping ──
  'ping.done': 'Pinged {{who}}.',

  // ── dispatch ──
  'dispatch.no_objective': 'What should I dispatch? I need an objective.',
  'dispatch.done': 'Dispatched to {{who}}: {{what}}.',
  'dispatch.all_forbidden': '{{verb}} on all agents at once is voice-forbidden. Do it agent by agent, or use the UI.',
  'dispatch.god_forbidden': '{{verb}} on the god orchestrator is voice-forbidden. That has to be done in the UI.',

  // ── steer ──
  'steer.no_text': 'What guidance should I steer them with?',
  'steer.done': 'Steering {{who}}: {{what}}.',

  // ── tasks ──
  'task.no_title': 'What should the task be titled?',
  // Two shapes rather than one sentence with an optional fragment: an
  // "{{assignee}}" var that main fills with `, assigned to X` would put English
  // back in main, which is the thing this whole module exists to remove. The
  // sentence STRUCTURE belongs to the locale file, so it gets its own key.
  'task.created': 'Created task "{{what}}".',
  'task.created_assigned': 'Created task "{{what}}", assigned to {{who}}.',
  'assign.needs_both': 'I need both a task and who to assign it to.',
  'task.ambiguous': 'Which one — {{list}}?',
  'task.not_found': 'I couldn\'t find a task matching "{{ref}}".',
  'assign.done': 'Assigned "{{what}}" to {{who}}.',
  'update.no_ref': 'Which task should I update?',
  'update.bad_status': '"{{status}}" isn\'t a valid status.',
  'update.done': 'Updated "{{what}}".',
  'update.done_status': 'Updated "{{what}}" to {{status}}.',
  'delete.no_ref': 'Which task should I delete?',
  'delete.done': 'Deleted the task "{{what}}". Recreate it any time if that was wrong.',

  // ── worker control ──
  'resume.done': 'Resumed {{who}} — tools flow again.',
  'kill.done': 'Killed {{who}}.',
  'kill.failed': 'Couldn\'t kill {{who}}: {{reason}}.',
  'pause.done': 'Paused {{who}}.',
  'halt.done': 'Halted {{who}}.',
  'archive.done': 'Archived {{who}} — off the floor, history kept. Say unarchive to bring them back.',
  'archive.failed': 'Couldn\'t archive {{who}}: {{reason}}.',
  'clear.queued': 'Queued a context clear for {{who}} — it lands the moment they\'re idle.',
  'clear.no_command': '{{who}} runs on {{tool}}, which has no context-clear command I can type. Clear it from their terminal.',
  'delivery.paused': 'Paused automatic delivery to {{who}} — queued messages will wait.',
  'delivery.resumed': 'Resumed automatic delivery to {{who}}.',
  'delivery.no_raw': 'Should I pause or resume message delivery?',
  'gate.no_tool': 'Which tool should I gate? Give me its exact name, like Bash or WebFetch.',
  'gate.done_on': 'Gated the {{tool}} tool for {{who}}.',
  'gate.done_off': 'Un-gated the {{tool}} tool for {{who}}.',
  'unknown.verb': 'I don\'t know how to {{verb}}.',
  'unarchive.done': 'Brought {{who}} back from the archive.',
  'unarchive.failed': 'Couldn\'t unarchive {{who}}: {{reason}}.',
  // A bare "yes" is NOT acceptance — this sentence is the one that stops an
  // accidental kill, so its wording is part of the safety surface.
  'confirm.refused': 'I won\'t {{verb}} {{who}} on that — for safety I need you to say "confirm" or "{{confirmWord}}", not just yes. Say it clearly, or say cancel.',

  // ── hire ──
  'hire.done': 'Hired {{who}}.',
  'hire.failed': 'Couldn\'t hire {{who}}: {{reason}}.',
  'hire.no_cwd': 'I need a working directory to hire into — none is configured.',

  // ── schedules ──
  'schedule.none': 'There are no scheduled missions to edit.',
  'schedule.not_found': 'I couldn\'t find a schedule matching "{{ref}}".',
  'schedule.which': 'Which schedule should I change?',
  'schedule.needs_both': 'I need a name for the schedule and what it should tell the agent.',
  'schedule.deleted': 'Deleted the "{{what}}" schedule.',
  'schedule.enabled': 'Enabled the "{{what}}" schedule.',
  'schedule.disabled': 'Disabled the "{{what}}" schedule.',
  'schedule.created': 'Created the "{{what}}" schedule — every {{value}} minutes to {{who}}.',
  'confirm.schedule_action': 'You want to {{verb}} the "{{what}}" schedule. To go ahead, say "confirm" or "schedule". Say "cancel" to stop.',
  'confirm.schedule_new': 'You want a new schedule "{{what}}", every {{value}} minutes, messaging {{who}}. To create it, say "confirm" or "schedule". Say "cancel" to stop.',

  // ── settings ──
  'setting.which': 'Which setting should I change?',
  'setting.voice_forbidden': 'The "{{key}}" setting can\'t be changed by voice — use the Settings screen for that one.',
  'setting.need_onoff': 'Should {{key}} be on or off?',
  'setting.need_number': 'What number should {{key}} be?',
  'setting.below_min': '{{key}} can\'t go below {{bound}}.',
  'setting.above_max': '{{key}} can\'t go above {{bound}}.',
  'setting.need_value': 'What should {{key}} be set to?',
  'setting.must_be_one': '{{key}} must be one of: {{list}}.',
  'setting.unchanged': '{{key}} is already {{onoff}} — nothing to change.',
  'setting.applied': 'Done — {{key}} is now {{onoff}} (was {{was}}).',
  'confirm.setting': '{{key}} is {{was}}; you want it {{now}}. To change it, say "confirm" or "setting". Say "cancel" to stop.',
  // 'on' / 'off' / 'unset' are interpolated into sentences, so they are words
  // and belong to the locale. Referenced from main as {{setting.state_on}}.
  'setting.state_on': 'on',
  'setting.state_off': 'off',
  'setting.state_unset': 'unset',

  // ── config / dispatch errors ──
  'hive.not_configured': 'The hive is not configured, so I can\'t take that action.',
  'action.unknown': 'I don\'t have an action called "{{verb}}".',
  'action.failed': 'That action failed: {{reason}}.',
  'agent.not_found': 'no agent was named',
  /** The reason text when a lower layer returned an empty error. */
  'error.unknown_reason': 'unknown error',

  // ── confirm / cancel ──
  'confirm.none_pending': 'There\'s nothing waiting to confirm.',
  // The confirm echo-back is the ENTIRE safety surface for a destructive op
  // (the human declined on-screen cards), so its structure is fixed and every
  // slot is a separate key: the consequence and the breaker note are real
  // variables, and translating them as fragments glued into an English sentence
  // would be the one place a mistranslation could hide a consequence.
  'confirm.destructive': 'You asked me to {{verb}} {{who}}{{note}}. {{consequence}} To go ahead, say "confirm" or "{{confirmWord}}". Say "cancel" to stop.',
  'confirm.consequence_clear': 'That wipes {{who}}\'s working memory of the current conversation.',
  'confirm.consequence_archive': 'That takes {{who}} off the floor (history kept).',
  'confirm.consequence_generic': 'That\'s destructive.',
  'confirm.note_halted': ' (note: already halted)',
  'confirm.note_paused': ' (note: already paused)',
  // The two "nothing" slots are SPACES, not empty strings. A phrase whose
  // interpolation yields "" is a TTS call with no text: the server either
  // errors or stays silent, and the user cannot tell which happened. A space
  // keeps the sentence well-formed and costs nothing when spoken.
  'confirm.note_none': ' ',
  'confirm.spawn': 'You want to hire a new {{tool}} agent{{role}}, named {{who}}. To hire, say "confirm" or "spawn". Say "cancel" to stop.',
  'confirm.spawn_role': ' as {{role}}',
  'confirm.spawn_no_role': ' ',
  'cancel.done': 'Cancelled the {{verb}}.',
  'cancel.nothing': 'Nothing to cancel.',
  // ── generated from the `rt` locale block (read-tools) ──
  'rt.ago.unknown': 'an unknown time ago',
  'rt.ago.now': 'just now',
  'rt.ago.seconds': '{{count}} seconds ago',
  'rt.ago.minutes': '{{count}} minutes ago',
  'rt.ago.hours': '{{count}} hours ago',
  'rt.ago.days': '{{count}} days ago',
  'rt.cadence.unknown': 'on an unknown cadence',
  'rt.cadence.under_minute': 'every minute or less',
  'rt.cadence.minutes': 'every {{count}} minutes',
  'rt.cadence.hours': 'every {{count}} hours',
  'rt.num.million': '{{value}} million',
  'rt.num.thousand': '{{value}} thousand',
  'rt.tool.none_found': 'I could not find any {{what}} right now.',
  'rt.tool.read_failed': 'I could not read the {{what}} just now ({{reason}}).',
  'rt.tool.no_agents': '蜂巢里还没有已注册的智能体。',
  'rt.tool.unnamed_agent': 'an unnamed agent',
  'rt.tool.unknown': '未知',
  'rt.tool.event': '事件',
  'rt.tool.untitled': '未命名',
  'rt.tool.what_fleet': '舰队状态',
  'rt.tool.what_board': '任务板',
  'rt.tool.what_usage': 'token 用量',
  'rt.tool.what_schedules': '定时任务',
  'rt.tool.what_activity': '活动日志',
  'rt.tool.what_messages': '消息',
  'rt.tool.what_app': '应用信息',
  'rt.tool.roster_line': '{{name}}{{role}} on {{provider}} ({{status}})',
  'rt.tool.fleet_head': 'There {{count}} agents active{{archived}}.',
  'rt.tool.archived_agents': ' and {{count}} archived',
  'rt.tool.is_god': '{{god}} 是调度者。',
  'rt.tool.active_workers': 'Active workers: {{list}}.',
  'rt.tool.board_empty': '任务板是空的。',
  'rt.tool.board_empty_now': '任务板现在是空的。',
  'rt.tool.counts': '{{todo}} to do, {{doing}} in progress, {{blocked}} blocked, and {{done}} done',
  'rt.tool.nothing_that_status': 'Nothing is {{filter}} right now. Overall: {{counts}}.',
  'rt.tool.filtered_tasks': '{{count}} tasks {{filter}}: {{list}}.',
  'rt.tool.doing_detail': 'In progress: {{list}}.',
  'rt.tool.blocked_detail': 'Blocked: {{list}}.',
  'rt.tool.board_summary': 'There are {{count}} tasks: {{counts}}.{{detail}}',
  'rt.tool.no_usage': '本次会话尚未记录任何 token 用量。',
  'rt.tool.top_user': '{{who}} at {{tokens}} tokens',
  'rt.tool.top_users': 'Top users: {{list}}.',
  'rt.tool.cost_summary': 'So far this session the hive has used {{input}} input and {{output}} output tokens across {{agents}} agents.{{top}}',
  'rt.tool.no_schedules': '没有配置任何定时任务。',
  'rt.tool.schedules_all_disabled': 'There are {{count}} scheduled missions, but all are disabled.',
  'rt.tool.a_mission': 'a mission',
  'rt.tool.last_fired': ', last fired {{when}}',
  'rt.tool.not_fired': ', not fired yet',
  'rt.tool.to': ' to {{who}}',
  'rt.tool.active_schedules': 'There are {{count}} active scheduled missions: {{list}}.',
  'rt.tool.noted': '{{who}} noted {{what}}',
  'rt.tool.team_notes': 'From the team\'s notes — {{list}}.',
  'rt.tool.from_agent_memory': 'From {{who}}\'s memory — {{what}}',
  'rt.tool.nothing_about': 'I read {{who}}\'s memory but found nothing about "{{query}}".',
  'rt.tool.no_memory_yet': '{{who}} has not recorded any memory yet.',
  'rt.tool.searched_nothing': 'I searched the team\'s memory but found nothing about "{{query}}".',
  'rt.tool.mem_active': 'Semantic memory is active',
  'rt.tool.mem_idle': 'Semantic memory is enabled but idle',
  'rt.tool.mem_offline': 'Semantic memory is offline',
  'rt.tool.mem_always_search': ' — but I can always text-search every agent\'s notes, active or archived. Ask me to search a topic, or name an agent to read their memory.',
  'rt.tool.no_activity': '还没有已记录的蜂巢活动。',
  'rt.tool.by': ' by {{who}}',
  'rt.tool.most_recent_activity': 'Most recent activity: {{list}}.',
  'rt.tool.msg_head': '{{from}} to {{to}}{{subject}} {{when}}',
  'rt.tool.someone': '某人',
  'rt.tool.msg_about': ' about "{{subject}}"',
  'rt.tool.msg_no_body': '{{head}}, with no body.',
  'rt.tool.msg_reply_wanted': ' (a reply was requested)',
  'rt.tool.no_message_id': 'I couldn\'t find a message with id {{id}}.',
  'rt.tool.that_message': 'That message — {{what}}.',
  'rt.tool.mailbox_empty': 'I don\'t see any messages in {{who}}\'s mailbox.',
  'rt.tool.no_messages_yet': '还没有可读的消息。',
  'rt.tool.scope_agent': '{{who}}\'s mailbox',
  'rt.tool.scope_floor': 'the floor',
  'rt.tool.recent_messages': '{{count}} recent messages from {{scope}}: {{list}}.',
  'rt.tool.which_agent': '告诉我你指的是哪个智能体。',
  'rt.tool.no_agent_match': 'I don\'t see an agent matching "{{ref}}".',
  'rt.tool.app_version': '这是 Munder Difflin 版本 {{version}}。',
  'rt.tool.release_notes': 'Latest release notes: {{notes}}',
  'rt.tool.no_notes': 'No release notes are bundled with this build.'
};

/**
 * Look up a key, and fall back to English.
 *
 * The `voice.<key>` indirection is where a locale file would put these. A key
 * with no translation yields the English text from {@link VOICE_PHRASES}, and a
 * key that does not exist at all yields its own dotted name — which is a bug
 * worth seeing in a log, and is why the test asserts every key is registered.
 */
export function renderVoicePhrase(
  t: (key: string, vars?: Record<string, unknown>) => string,
  phrase: VoicePhrase,
  depth = 0
): string {
  const fallback = VOICE_PHRASES[phrase.key];
  // A var whose value is `{{some.key}}` is a SLOT: the renderer resolves it as
  // a phrase in its own right. That is what lets one sentence frame hold a
  // variable consequence ("that wipes their memory" vs "that is destructive")
  // without main concatenating English fragments into the middle of it.
  const vars = resolveSlots(t, phrase.vars ?? {}, depth);  const rendered = t(`voice.${phrase.key}`, { ...(vars as Record<string, unknown>) }) as unknown;
  // i18next returns the key itself when a translation is missing. Detect that
  // and use the English table, so a missing translation is a wrong-language
  // sentence rather than a dotted identifier read aloud.
  if (typeof rendered === 'string' && rendered !== `voice.${phrase.key}` && rendered.trim()) {
    return rendered;
  }
  if (fallback === undefined) return phrase.key;
  return interpolate(fallback, vars);
}

/** How deep a slot may nest. A cycle in the slot table would otherwise recurse
 *  until the stack gives out, in a module whose whole job is to be boring. */
const MAX_SLOT_DEPTH = 3;

/** Replace every `{{key}}` var with that phrase's rendered text. A non-slot var
 *  (a real string, a number) is left alone. */
function resolveSlots(
  t: (key: string, vars?: Record<string, unknown>) => string,
  vars: VoiceVars,
  depth: number
): VoiceVars {
  if (depth >= MAX_SLOT_DEPTH) return vars;
  const out: VoiceVars = { ...vars };
  const rec = out as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(vars) as [string, string | undefined][]) {
    if (typeof value !== 'string') continue;
    const m = value.match(/^\{\{([\w.]+)\}\}$/);
    if (!m) continue;
    // The slot inherits the frame's variables, so "that wipes HER memory" can
    // name the agent even though the slot's own key carries no vars.
    rec[name] = renderVoicePhrase(t, { key: m[1], vars }, depth + 1);
  }
  return out;
}

/** `{{name}}` substitution, and only that. Deliberately not i18next: this runs
 *  in main (and in tests) with no instance, so it cannot depend on one. */
export function interpolate(template: string, vars: VoiceVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const v = (vars as Record<string, unknown>)[name];
    return v === undefined || v === null || v === '' ? whole : String(v);
  });
}

/**
 * Candidate titles for a "which one?" question, quoted and separated.
 *
 * The separator is a COMMA, not ", or " — an English conjunction baked into
 * main is an English conjunction spoken in every language. A locale that wants
 * a disjunction can build it in the sentence, and one that needs a different
 * separator gets a variable it can re-split.
 */
export function quotedList(titles: readonly string[]): string {
  return titles.map((t) => `"${t}"`).join(', ');
}

/**
 * The same, from card objects — what the action layer actually has. Kept
 * separate so this shared module never has to know the HiveTask type.
 */
export function quotedCardTitles(cards: readonly { title?: string }[]): string {
  return quotedList(cards.map((c) => (c.title ?? '').trim()));
}

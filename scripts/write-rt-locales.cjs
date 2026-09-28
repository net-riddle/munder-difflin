// Write the `rt` block of every locale, and verify the placeholder sets
// against English. Run: node scripts/write-rt-locales.cjs
//
// Every language carries EVERY key. A language that falls back to English
// without noticing is the failure this script exists to prevent: the resolver
// degrades silently, so the only symptom is a voice answering in the wrong
// language. It prints how many strings each locale leaves identical to
// English, and test/realtime-tools-i18n.test.cjs fails above 35%.
const fs = require('node:fs');
const path = require('node:path');
const LOCALES = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');

const T = {
  'en.json': {
    'ago.unknown': 'an unknown time ago',
    'ago.now': 'just now',
    'ago.seconds': '{{count}} seconds ago',
    'ago.minutes': '{{count}} minutes ago',
    'ago.hours': '{{count}} hours ago',
    'ago.days': '{{count}} days ago',
    'cadence.unknown': 'on an unknown cadence',
    'cadence.under_minute': 'every minute or less',
    'cadence.minutes': 'every {{count}} minutes',
    'cadence.hours': 'every {{count}} hours',
    'num.million': '{{value}} million',
    'num.thousand': '{{value}} thousand',

    'tool.none_found': 'I could not find any {{what}} right now.',
    'tool.read_failed': 'I could not read the {{what}} just now ({{reason}}).',
    'tool.no_agents': 'The hive has no registered agents yet.',
    'tool.unnamed_agent': 'an unnamed agent',
    'tool.unknown': 'unknown',
    'tool.event': 'event',
    'tool.untitled': 'untitled',
    'tool.what_fleet': 'fleet status',
    'tool.what_board': 'task board',
    'tool.what_usage': 'token usage',
    'tool.what_schedules': 'schedules',
    'tool.what_activity': 'activity log',
    'tool.what_messages': 'messages',
    'tool.what_app': 'app info',

    'tool.roster_line': '{{name}}{{role}} on {{provider}} ({{status}})',
    'tool.fleet_head': 'There {{count}} agents active{{archived}}.',
    'tool.archived_agents': ' and {{count}} archived',
    'tool.is_god': '{{god}} is the god orchestrator.',
    'tool.active_workers': 'Active workers: {{list}}.',

    'tool.board_empty': 'The task board is empty.',
    'tool.board_empty_now': 'The board is empty right now.',
    'tool.counts': '{{todo}} to do, {{doing}} in progress, {{blocked}} blocked, and {{done}} done',
    'tool.nothing_that_status': 'Nothing is {{filter}} right now. Overall: {{counts}}.',
    'tool.filtered_tasks': '{{count}} tasks {{filter}}: {{list}}.',
    'tool.doing_detail': 'In progress: {{list}}.',
    'tool.blocked_detail': 'Blocked: {{list}}.',
    'tool.board_summary': 'There are {{count}} tasks: {{counts}}.{{detail}}',

    'tool.no_usage': 'No token usage has been recorded this session yet.',
    'tool.top_user': '{{who}} at {{tokens}} tokens',
    'tool.top_users': 'Top users: {{list}}.',
    'tool.cost_summary': 'So far this session the hive has used {{input}} input and {{output}} output tokens across {{agents}} agents.{{top}}',

    'tool.no_schedules': 'There are no scheduled missions configured.',
    'tool.schedules_all_disabled': 'There are {{count}} scheduled missions, but all are disabled.',
    'tool.a_mission': 'a mission',
    'tool.last_fired': ', last fired {{when}}',
    'tool.not_fired': ', not fired yet',
    'tool.to': ' to {{who}}',
    'tool.active_schedules': 'There are {{count}} active scheduled missions: {{list}}.',

    'tool.noted': '{{who}} noted {{what}}',
    'tool.team_notes': "From the team's notes — {{list}}.",
    'tool.from_agent_memory': "From {{who}}'s memory — {{what}}",
    'tool.nothing_about': "I read {{who}}'s memory but found nothing about \"{{query}}\".",
    'tool.no_memory_yet': '{{who}} has not recorded any memory yet.',
    'tool.searched_nothing': 'I searched the team\'s memory but found nothing about "{{query}}".',
    'tool.mem_active': 'Semantic memory is active',
    'tool.mem_idle': 'Semantic memory is enabled but idle',
    'tool.mem_offline': 'Semantic memory is offline',
    'tool.mem_always_search': " — but I can always text-search every agent's notes, active or archived. Ask me to search a topic, or name an agent to read their memory.",

    'tool.no_activity': 'There is no recorded hive activity yet.',
    'tool.by': ' by {{who}}',
    'tool.most_recent_activity': 'Most recent activity: {{list}}.',

    'tool.msg_head': '{{from}} to {{to}}{{subject}} {{when}}',
    'tool.someone': 'someone',
    'tool.msg_about': ' about "{{subject}}"',
    'tool.msg_no_body': '{{head}}, with no body.',
    'tool.msg_reply_wanted': ' (a reply was requested)',
    'tool.no_message_id': 'I couldn\'t find a message with id {{id}}.',
    'tool.that_message': 'That message — {{what}}.',
    'tool.mailbox_empty': "I don't see any messages in {{who}}'s mailbox.",
    'tool.no_messages_yet': 'There are no hive messages to read yet.',
    'tool.scope_agent': "{{who}}'s mailbox",
    'tool.scope_floor': 'the floor',
    'tool.recent_messages': '{{count}} recent messages from {{scope}}: {{list}}.',

    'tool.which_agent': 'Tell me which agent you mean.',
    'tool.no_agent_match': 'I don\'t see an agent matching "{{ref}}".',

    'tool.app_version': 'This is Munder Difflin version {{version}}.',
    'tool.release_notes': 'Latest release notes: {{notes}}',
    'tool.no_notes': 'No release notes are bundled with this build.'
  },

  'it.json': {
    'ago.unknown': 'un tempo imprecisato fa',
    'ago.now': 'adesso',
    'ago.seconds': '{{count}} secondi fa',
    'ago.minutes': '{{count}} minuti fa',
    'ago.hours': '{{count}} ore fa',
    'ago.days': '{{count}} giorni fa',
    'cadence.unknown': 'con una cadenza imprecisata',
    'cadence.under_minute': 'ogni minuto o meno',
    'cadence.minutes': 'ogni {{count}} minuti',
    'cadence.hours': 'ogni {{count}} ore',
    'num.million': '{{value}} milioni',
    'num.thousand': '{{value}}mila',

    'tool.none_found': 'Non trovo nulla in {{what}} adesso.',
    'tool.read_failed': 'Non sono riuscito a leggere {{what}} adesso ({{reason}}).',
    'tool.no_agents': 'L\'alveare non ha ancora agenti registrati.',
    'tool.unnamed_agent': 'un agente senza nome',
    'tool.unknown': 'sconosciuto',
    'tool.event': 'evento',
    'tool.untitled': 'senza titolo',
    'tool.what_fleet': 'lo stato della flotta',
    'tool.what_board': 'la bacheca dei task',
    'tool.what_usage': 'il consumo di token',
    'tool.what_schedules': 'i programmi',
    'tool.what_activity': 'il registro attività',
    'tool.what_messages': 'i messaggi',
    'tool.what_app': 'le info dell\'app',

    'tool.roster_line': '{{name}}{{role}} su {{provider}} ({{status}})',
    'tool.fleet_head': 'Ci sono {{count}} agenti attivi{{archived}}.',
    'tool.archived_agents': ' e {{count}} archiviati',
    'tool.is_god': '{{god}} è l\'orchestratore.',
    'tool.active_workers': 'Worker attivi: {{list}}.',

    'tool.board_empty': 'La bacheca dei task è vuota.',
    'tool.board_empty_now': 'La bacheca è vuota adesso.',
    'tool.counts': '{{todo}} da fare, {{doing}} in corso, {{blocked}} bloccati e {{done}} finiti',
    'tool.nothing_that_status': 'Non c\'è niente in {{filter}} adesso. Complessivo: {{counts}}.',
    'tool.filtered_tasks': '{{count}} task in {{filter}}: {{list}}.',
    'tool.doing_detail': 'In corso: {{list}}.',
    'tool.blocked_detail': 'Bloccati: {{list}}.',
    'tool.board_summary': 'Ci sono {{count}} task: {{counts}}.{{detail}}',

    'tool.no_usage': 'In questa sessione non è ancora stato registrato alcun consumo di token.',
    'tool.top_user': '{{who}} a {{tokens}} token',
    'tool.top_users': 'I maggiori consumatori: {{list}}.',
    'tool.cost_summary': 'Finora in questa sessione l\'alveare ha usato {{input}} token in ingresso e {{output}} in uscita su {{agents}} agenti.{{top}}',

    'tool.no_schedules': 'Non ci sono missioni programmate configurate.',
    'tool.schedules_all_disabled': 'Ci sono {{count}} missioni programmate, ma sono tutte disattivate.',
    'tool.a_mission': 'una missione',
    'tool.last_fired': ', ultimo lancio {{when}}',
    'tool.not_fired': ', mai lanciata',
    'tool.to': ' verso {{who}}',
    'tool.active_schedules': 'Ci sono {{count}} missioni programmate attive: {{list}}.',

    'tool.noted': '{{who}} ha notato {{what}}',
    'tool.team_notes': 'Dalle note del team — {{list}}.',
    'tool.from_agent_memory': 'Dalla memoria di {{who}} — {{what}}',
    'tool.nothing_about': 'Ho letto la memoria di {{who}} ma non c\'è nulla su «{{query}}».',
    'tool.no_memory_yet': '{{who}} non ha ancora registrato memoria.',
    'tool.searched_nothing': 'Ho cercato nella memoria del team ma non c\'è nulla su «{{query}}».',
    'tool.mem_active': 'La memoria semantica è attiva',
    'tool.mem_idle': 'La memoria semantica è abilitata ma in pausa',
    'tool.mem_offline': 'La memoria semantica è spenta',
    'tool.mem_always_search': ' — ma posso sempre cercare testualmente nelle note di ogni agente, attivi o archiviati. Chiedimi di cercare un argomento, o indica un agente di cui leggere la memoria.',

    'tool.no_activity': 'Non c\'è ancora attività registrata nell\'alveare.',
    'tool.by': ' di {{who}}',
    'tool.most_recent_activity': 'Attività più recente: {{list}}.',

    'tool.msg_head': '{{from}} a {{to}}{{subject}} {{when}}',
    'tool.someone': 'qualcuno',
    'tool.msg_about': ' su «{{subject}}»',
    'tool.msg_no_body': '{{head}}, senza corpo.',
    'tool.msg_reply_wanted': ' (è stata richiesta una risposta)',
    'tool.no_message_id': 'Non trovo nessun messaggio con id {{id}}.',
    'tool.that_message': 'Quel messaggio — {{what}}.',
    'tool.mailbox_empty': 'Non vedo messaggi nella casella di {{who}}.',
    'tool.no_messages_yet': 'Non ci sono ancora messaggi da leggere.',
    'tool.scope_agent': 'la casella di {{who}}',
    'tool.scope_floor': 'il piano',
    'tool.recent_messages': '{{count}} messaggi recenti da {{scope}}: {{list}}.',

    'tool.which_agent': 'Dimmi quale agente intendi.',
    'tool.no_agent_match': 'Non vedo nessun agente che corrisponda a «{{ref}}».',

    'tool.app_version': 'Questa è Munder Difflin versione {{version}}.',
    'tool.release_notes': 'Ultime note di rilascio: {{notes}}',
    'tool.no_notes': 'Questa build non include note di rilascio.'
  },

  'ar.json': {
    'ago.unknown': 'في وقت غير معروف',
    'ago.now': 'الآن',
    'ago.seconds': 'قبل {{count}} ثانية',
    'ago.minutes': 'قبل {{count}} دقيقة',
    'ago.hours': 'قبل {{count}} ساعة',
    'ago.days': 'قبل {{count}} يومًا',
    'cadence.unknown': 'بإيقاع غير معروف',
    'cadence.under_minute': 'كل دقيقة أو أقل',
    'cadence.minutes': 'كل {{count}} دقيقة',
    'cadence.hours': 'كل {{count}} ساعة',
    'num.million': '{{value}} مليون',
    'num.thousand': '{{value}} ألف',

    'tool.none_found': 'لا أجد أي {{what}} الآن.',
    'tool.read_failed': 'تعذّرت قراءة {{what}} الآن ({{reason}}).',
    'tool.no_agents': 'لا يوجد وكلاء مسجَّلون في الخلية بعد.',
    'tool.unnamed_agent': 'وكيل بلا اسم',
    'tool.unknown': 'غير معروف',
    'tool.event': 'حدث',
    'tool.untitled': 'بلا عنوان',
    'tool.what_fleet': 'حالة الأسطول',
    'tool.what_board': 'لوحة المهام',
    'tool.what_usage': 'استهلاك الرموز',
    'tool.what_schedules': 'الجداول',
    'tool.what_activity': 'سجل النشاط',
    'tool.what_messages': 'الرسائل',
    'tool.what_app': 'معلومات التطبيق',

    'tool.roster_line': '{{name}}{{role}} على {{provider}} ({{status}})',
    'tool.fleet_head': 'هناك {{count}} وكلاء نشطون{{archived}}.',
    'tool.archived_agents': ' و{{count}} مؤرشفين',
    'tool.is_god': '{{god}} هو منسّق العمل.',
    'tool.active_workers': 'العمال النشطون: {{list}}.',

    'tool.board_empty': 'لوحة المهام فارغة.',
    'tool.board_empty_now': 'اللوحة فارغة الآن.',
    'tool.counts': '{{todo}} قادمة، {{doing}} قيد التنفيذ، {{blocked}} متعثرة، و{{done}} منجزة',
    'tool.nothing_that_status': 'لا شيء في حالة {{filter}} الآن. الإجمالي: {{counts}}.',
    'tool.filtered_tasks': '{{count}} مهمة في حالة {{filter}}: {{list}}.',
    'tool.doing_detail': 'قيد التنفيذ: {{list}}.',
    'tool.blocked_detail': 'متعثرة: {{list}}.',
    'tool.board_summary': 'هناك {{count}} مهمة: {{counts}}.{{detail}}',

    'tool.no_usage': 'لم يُسجَّل أي استهلاك للرموز في هذه الجلسة بعد.',
    'tool.top_user': '{{who}} عند {{tokens}} رمزًا',
    'tool.top_users': 'الأكثر استهلاكًا: {{list}}.',
    'tool.cost_summary': 'حتى الآن استخدمت الخلية في هذه الجلسة {{input}} رمزًا للدخل و{{output}} رمزًا للخرج عبر {{agents}} وكيلًا.{{top}}',

    'tool.no_schedules': 'لا توجد مهام مجدولة مُعدَّة.',
    'tool.schedules_all_disabled': 'هناك {{count}} مهمة مجدولة، لكنها كلها معطَّلة.',
    'tool.a_mission': 'مهمة',
    'tool.last_fired': '، آخر تشغيل {{when}}',
    'tool.not_fired': '، لم تُشغَّل بعد',
    'tool.to': ' إلى {{who}}',
    'tool.active_schedules': 'هناك {{count}} مهمة مجدولة نشطة: {{list}}.',

    'tool.noted': 'لاحظ {{who}} {{what}}',
    'tool.team_notes': 'من ملاحظات الفريق — {{list}}.',
    'tool.from_agent_memory': 'من ذاكرة {{who}} — {{what}}',
    'tool.nothing_about': 'قرأت ذاكرة {{who}} ولم أجد شيئًا عن «{{query}}».',
    'tool.no_memory_yet': 'لم يسجّل {{who}} أي ذاكرة بعد.',
    'tool.searched_nothing': 'بحثت في ذاكرة الفريق ولم أجد شيئًا عن «{{query}}».',
    'tool.mem_active': 'الذاكرة الدلالية مُفعّلة',
    'tool.mem_idle': 'الذاكرة الدلالية مُفعّلة لكن في خمول',
    'tool.mem_offline': 'الذاكرة الدلالية متوقفة',
    'tool.mem_always_search': ' — لكن يمكنني دائمًا البحث نصيًا في ملاحظات كل وكيل، نشطًا كان أو مؤرشفًا. اسألني عن موضوع، أو سمِّ وكيلًا لقراءة ذاكرته.',

    'tool.no_activity': 'لا يوجد نشاط مسجَّل في الخلية بعد.',
    'tool.by': ' بواسطة {{who}}',
    'tool.most_recent_activity': 'أحدث النشاط: {{list}}.',

    'tool.msg_head': '{{from}} إلى {{to}}{{subject}} {{when}}',
    'tool.someone': 'شخص ما',
    'tool.msg_about': ' بشأن «{{subject}}»',
    'tool.msg_no_body': '{{head}}، بلا نص.',
    'tool.msg_reply_wanted': ' (طُلب ردّ)',
    'tool.no_message_id': 'لم أجد رسالة بالمعرّف {{id}}.',
    'tool.that_message': 'تلك الرسالة — {{what}}.',
    'tool.mailbox_empty': 'لا أرى رسائل في صندوق {{who}}.',
    'tool.no_messages_yet': 'لا توجد رسائل في الخلية لقراءتها بعد.',
    'tool.scope_agent': 'صندوق {{who}}',
    'tool.scope_floor': 'الطابق',
    'tool.recent_messages': '{{count}} رسالة حديثة من {{scope}}: {{list}}.',

    'tool.which_agent': 'أخبرني عن أي وكيل تقصد.',
    'tool.no_agent_match': 'لا أرى وكيلًا يطابق «{{ref}}».',

    'tool.app_version': 'هذا هو Munder Difflin بالإصدار {{version}}.',
    'tool.release_notes': 'آخر ملاحظات الإصدار: {{notes}}',
    'tool.no_notes': 'لا تتضمن هذه النسخة ملاحظات إصدار.'
  },

  'zh-CN.json': {
    'ago.unknown': '在某个不确定的时间',
    'ago.now': '刚刚',
    'ago.seconds': '{{count}} 秒前',
    'ago.minutes': '{{count}} 分钟前',
    'ago.hours': '{{count}} 小时前',
    'ago.days': '{{count}} 天前',
    'cadence.unknown': '按不确定的频率',
    'cadence.under_minute': '每分钟或更短',
    'cadence.minutes': '每 {{count}} 分钟',
    'cadence.hours': '每 {{count}} 小时',
    'num.million': '{{value}} 百万',
    'num.thousand': '{{value}} 千',

    'tool.none_found': '现在找不到任何{{what}}。',
    'tool.read_failed': '刚才无法读取{{what}}（{{reason}}）。',
    'tool.no_agents': '蜂巢里还没有已注册的智能体。',
    'tool.unnamed_agent': '一个未命名的智能体',
    'tool.unknown': '未知',
    'tool.event': '事件',
    'tool.untitled': '未命名',
    'tool.what_fleet': '舰队状态',
    'tool.what_board': '任务板',
    'tool.what_usage': 'token 用量',
    'tool.what_schedules': '定时任务',
    'tool.what_activity': '活动日志',
    'tool.what_messages': '消息',
    'tool.what_app': '应用信息',

    'tool.roster_line': '{{name}}{{role}}，运行在 {{provider}}（{{status}}）',
    'tool.fleet_head': '当前有 {{count}} 个活跃智能体{{archived}}。',
    'tool.archived_agents': '，以及 {{count}} 个已归档',
    'tool.is_god': '{{god}} 是调度者。',
    'tool.active_workers': '活跃成员：{{list}}。',

    'tool.board_empty': '任务板是空的。',
    'tool.board_empty_now': '任务板现在是空的。',
    'tool.counts': '{{todo}} 待办，{{doing}} 进行中，{{blocked}} 受阻，{{done}} 已完成',
    'tool.nothing_that_status': '现在没有状态为{{filter}}的任务。总计：{{counts}}。',
    'tool.filtered_tasks': '{{count}} 个任务处于{{filter}}：{{list}}。',
    'tool.doing_detail': '进行中：{{list}}。',
    'tool.blocked_detail': '受阻：{{list}}。',
    'tool.board_summary': '共有 {{count}} 个任务：{{counts}}.{{detail}}',

    'tool.no_usage': '本次会话尚未记录任何 token 用量。',
    'tool.top_user': '{{who}} 用了 {{tokens}} 个 token',
    'tool.top_users': '用量最高：{{list}}。',
    'tool.cost_summary': '本次会话到目前为止，蜂巢共用了 {{input}} 个输入 token 和 {{output}} 个输出 token，涉及 {{agents}} 个智能体。{{top}}',

    'tool.no_schedules': '没有配置任何定时任务。',
    'tool.schedules_all_disabled': '有 {{count}} 个定时任务，但全部处于停用状态。',
    'tool.a_mission': '一个任务',
    'tool.last_fired': '，上次触发于{{when}}',
    'tool.not_fired': '，尚未触发',
    'tool.to': '，发给 {{who}}',
    'tool.active_schedules': '有 {{count}} 个启用的定时任务：{{list}}。',

    'tool.noted': '{{who}} 记下了 {{what}}',
    'tool.team_notes': '来自团队的笔记 —— {{list}}。',
    'tool.from_agent_memory': '来自 {{who}} 的记忆 —— {{what}}',
    'tool.nothing_about': '我读了 {{who}} 的记忆，但没找到关于「{{query}}」的内容。',
    'tool.no_memory_yet': '{{who}} 还没有记录任何记忆。',
    'tool.searched_nothing': '我搜索了团队的记忆，但没找到关于「{{query}}」的内容。',
    'tool.mem_active': '语义记忆已启用',
    'tool.mem_idle': '语义记忆已启用但处于空闲',
    'tool.mem_offline': '语义记忆已停用',
    'tool.mem_always_search': ' —— 不过我总能按文本搜索每个智能体的笔记，无论启用还是归档。让我搜索某个话题，或者指定一个智能体来读它的记忆。',

    'tool.no_activity': '还没有已记录的蜂巢活动。',
    'tool.by': '，由 {{who}}',
    'tool.most_recent_activity': '最近的活动：{{list}}。',

    'tool.msg_head': '{{from}} 发给 {{to}}{{subject}} {{when}}',
    'tool.someone': '某人',
    'tool.msg_about': '，关于「{{subject}}」',
    'tool.msg_no_body': '{{head}}，没有正文。',
    'tool.msg_reply_wanted': '（要求回复）',
    'tool.no_message_id': '找不到 id 为 {{id}} 的消息。',
    'tool.that_message': '那条消息 —— {{what}}。',
    'tool.mailbox_empty': '在 {{who}} 的信箱里看不到任何消息。',
    'tool.no_messages_yet': '还没有可读的消息。',
    'tool.scope_agent': '{{who}} 的信箱',
    'tool.scope_floor': '整个楼层',
    'tool.recent_messages': '来自{{scope}}的 {{count}} 条近期消息：{{list}}。',

    'tool.which_agent': '告诉我你指的是哪个智能体。',
    'tool.no_agent_match': '看不到匹配「{{ref}}」的智能体。',

    'tool.app_version': '这是 Munder Difflin 版本 {{version}}。',
    'tool.release_notes': '最新发布说明：{{notes}}',
    'tool.no_notes': '此构建未附带发布说明。'
  }
};

const ph = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
const keys = Object.keys(T['en.json']);
const problems = [];

for (const file of Object.keys(T)) {
  const table = T[file];
  const missing = keys.filter((k) => !(k in table) || table[k] === null || table[k] === undefined);
  if (missing.length) { problems.push(`${file} manca ${missing.length}: ${missing.slice(0, 6).join(', ')}`); continue; }
  for (const [k, v] of Object.entries(table)) {
    if (ph(v) !== ph(T['en.json'][k])) problems.push(`${file}.${k}: en=[${ph(T['en.json'][k])}] got=[${ph(v)}]`);
  }
  const p = path.join(LOCALES, file);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.rt = {};
  for (const k of keys) j.rt[k] = table[k];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  const same = keys.filter((k) => table[k] === T['en.json'][k]).length;
  const pct = Math.round((same / keys.length) * 100);
  // English is English by definition; only the OTHER locales are checked.
  if (file !== 'en.json' && pct > 35) {
    problems.push(`${file}: ${pct}% delle stringhe sono identiche all'inglese`);
  }
  console.log(file, '->', keys.length, 'chiavi rt,', pct + "% identiche all'inglese");
}

if (problems.length) {
  console.log('\nPROBLEMI:');
  for (const x of problems) console.log(' -', x);
  process.exit(1);
}
console.log('\nOK: placeholder coerenti e traduzioni reali in tutte le lingue.');

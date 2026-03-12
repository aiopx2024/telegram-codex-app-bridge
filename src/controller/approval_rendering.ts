import { t } from '../i18n.js';
import type {
  AppLocale,
  PendingApprovalRecord,
  PendingUserInputQuestion,
  PendingUserInputRecord,
} from '../types.js';

export type ApprovalAction = 'accept' | 'session' | 'deny';
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export function buildApprovalKeyboard(
  locale: AppLocale,
  localId: string,
  detailsOpen = false,
): InlineKeyboard {
  return [
    [
      { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
      { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
      { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
    ],
    [{
      text: t(locale, detailsOpen ? 'button_back' : 'button_details'),
      callback_data: `approval:${localId}:${detailsOpen ? 'back' : 'details'}`,
    }],
  ];
}

export function renderPendingUserInputStage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): {
  html: string;
  keyboard: InlineKeyboard;
  messageKind: 'question' | 'review';
  questionIndex: number;
} {
  if (isPendingUserInputReview(record)) {
    return {
      ...renderPendingUserInputReviewMessage(locale, record),
      messageKind: 'review',
      questionIndex: Math.max(0, record.questions.length - 1),
    };
  }
  const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
  return {
    ...renderPendingUserInputMessage(locale, record, currentQuestion),
    messageKind: 'question',
    questionIndex: record.currentQuestionIndex,
  };
}

export function renderPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
): { html: string; keyboard: InlineKeyboard } {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  const lines = [
    t(locale, 'input_requested'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question?.header || 'Question')} (${progress})</b>`,
    escapeTelegramHtml(question?.question || ''),
  ];
  const optionLines = (question?.options ?? [])
    .filter((option) => option.label.trim())
    .map((option, index) => {
      const recommendedPrefix = index === 0 ? `${escapeTelegramHtml(t(locale, 'input_recommended'))}: ` : '';
      return `${index + 1}. ${recommendedPrefix}${escapeTelegramHtml(option.label)}${option.description ? ` - ${escapeTelegramHtml(option.description)}` : ''}`;
    });
  if (optionLines.length > 0) {
    lines.push(`<blockquote expandable>${optionLines.join('\n')}</blockquote>`);
  }
  if (record.awaitingFreeText) {
    lines.push(t(locale, 'input_reply_only'));
  } else if (optionLines.length > 0) {
    lines.push(question?.isOther ? t(locale, 'input_select_or_other') : t(locale, 'input_select_only'));
  } else {
    lines.push(t(locale, 'input_reply_only'));
  }
  lines.push(record.currentQuestionIndex > 0 ? t(locale, 'input_question_actions_back_cancel') : t(locale, 'input_question_actions_cancel'));
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: buildPendingUserInputKeyboard(locale, record, question, record.awaitingFreeText),
  };
}

export function renderPendingUserInputReviewMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): { html: string; keyboard: InlineKeyboard } {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_review_title'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    t(locale, 'input_review_prompt'),
  ];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    const answer = record.answers[question.id] ?? [];
    lines.push(`<b>${index + 1}. ${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ') || t(locale, 'empty')) }));
  }
  return {
    html: lines.join('\n'),
    keyboard: buildPendingUserInputReviewKeyboard(locale, record),
  };
}

export function renderAnsweredPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion,
  answer: string[],
): string {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question.header)} (${progress})</b>`,
    escapeTelegramHtml(question.question),
    t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }),
  ].filter(Boolean).join('\n');
}

export function renderResolvedPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  answers: Record<string, string[]>,
): string {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ];
  for (const question of record.questions) {
    const answer = answers[question.id];
    if (!answer || answer.length === 0) {
      continue;
    }
    lines.push(`<b>${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }));
  }
  return lines.join('\n');
}

export function renderCancelledPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): string {
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_cancelled'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ].join('\n');
}

export function buildPendingUserInputResponse(answers: Record<string, string[]>): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [questionId, { answers: value }]),
  );
}

export function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: truncateInline(record.command, 120) }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  if (decision) {
    const decisionKey = decision === 'accept'
      ? 'approval_decision_accept'
      : decision === 'session'
        ? 'approval_decision_session'
        : 'approval_decision_deny';
    lines.push(t(locale, 'line_decision', { value: t(locale, decisionKey) }));
  }
  return lines.join('\n');
}

export function renderApprovalDetailsMessage(locale: AppLocale, record: PendingApprovalRecord): string {
  const lines = [
    t(locale, 'approval_details_title'),
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  const paths = Array.isArray(record.details?.paths)
    ? record.details.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (paths.length > 0) {
    lines.push(t(locale, 'line_paths', { value: truncateInline(paths.join(', '), 160) }));
  }
  const counts = formatApprovalChangeCounts(locale, record.details?.counts);
  if (counts) {
    lines.push(t(locale, 'approval_detail_counts', { value: counts }));
  }
  return lines.join('\n');
}

export function deriveApprovalDetails(
  kind: PendingApprovalRecord['kind'],
  params: any,
): Pick<PendingApprovalRecord, 'summary' | 'riskLevel' | 'details'> {
  if (kind === 'command') {
    const commandText = typeof params?.command === 'string'
      ? params.command
      : Array.isArray(params?.command)
        ? params.command.map((part: unknown) => String(part)).join(' ')
        : null;
    return {
      summary: commandText ? truncateInline(commandText, 120) : 'Run a command in the workspace',
      riskLevel: inferCommandApprovalRisk(commandText),
      details: {
        command: commandText,
        cwd: typeof params?.cwd === 'string' ? params.cwd : null,
        parsedCmd: Array.isArray(params?.parsedCmd) ? params.parsedCmd : [],
      },
    };
  }

  const changes = normalizeFileChangeApprovalDetails(params);
  return {
    summary: changes.summary,
    riskLevel: inferFileChangeApprovalRisk(changes.paths, changes.counts),
    details: {
      paths: changes.paths,
      counts: changes.counts,
    },
  };
}

export function mapApprovalDecision(action: ApprovalAction): unknown {
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
}

export function isPendingUserInputReview(record: PendingUserInputRecord): boolean {
  return record.currentQuestionIndex >= record.questions.length;
}

export function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}

function buildPendingInputNavigationRow(
  locale: AppLocale,
  localId: string,
  currentQuestionIndex: number,
): Array<{ text: string; callback_data: string }> {
  const row = [{ text: t(locale, 'button_cancel'), callback_data: `input:${localId}:cancel` }];
  if (currentQuestionIndex > 0) {
    row.unshift({ text: t(locale, 'button_back'), callback_data: `input:${localId}:back` });
  }
  return row;
}

function buildPendingUserInputReviewKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
): InlineKeyboard {
  const rows: InlineKeyboard = [[
    { text: t(locale, 'button_submit'), callback_data: `input:${record.localId}:submit` },
    { text: t(locale, 'button_cancel'), callback_data: `input:${record.localId}:cancel` },
  ]];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    rows.push([{
      text: truncateInline(`${t(locale, 'input_review_edit')}: ${question.header}`, 32),
      callback_data: `input:${record.localId}:edit:${index}`,
    }]);
  }
  return rows;
}

function buildPendingUserInputKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
  awaitingFreeText: boolean,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (question && !awaitingFreeText && question.options && question.options.length > 0) {
    rows.push(...question.options.map((option, index) => [{
      text: truncateInline(
        index === 0
          ? `${t(locale, 'button_recommended')}: ${option.label}`
          : option.label,
        32,
      ),
      callback_data: `input:${record.localId}:option:${index}`,
    }]));
  }
  if (question?.isOther) {
    rows.push([{ text: t(locale, 'button_other'), callback_data: `input:${record.localId}:other` }]);
  }
  rows.push(buildPendingInputNavigationRow(locale, record.localId, record.currentQuestionIndex));
  return rows;
}

function normalizeFileChangeApprovalDetails(params: any): {
  paths: string[];
  counts: { create: number; update: number; delete: number };
  summary: string;
} {
  const rawChanges = Array.isArray(params?.changes)
    ? params.changes
    : Array.isArray(params?.edits)
      ? params.edits
      : [];
  const normalized = (rawChanges as any[])
    .map((entry: any) => ({
      path: extractApprovalPath(entry),
      kind: typeof entry?.kind === 'string'
        ? entry.kind
        : typeof entry?.type === 'string'
          ? entry.type
          : typeof entry?.changeType === 'string'
            ? entry.changeType
            : 'update',
    }))
    .filter((entry: { path: string | null }) => Boolean(entry.path));
  const paths = normalized
    .map((entry: { path: string | null }) => entry.path!)
    .filter((path: string, index: number, values: string[]) => values.indexOf(path) === index);
  const counts = {
    create: normalized.filter((entry: { kind: string }) => /^(create|add|new)$/i.test(entry.kind)).length,
    update: normalized.filter((entry: { kind: string }) => !/^(create|add|new|delete|remove)$/i.test(entry.kind)).length,
    delete: normalized.filter((entry: { kind: string }) => /^(delete|remove)$/i.test(entry.kind)).length,
  };
  const summary = paths.length > 0
    ? truncateInline(`${paths.length} file(s): ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''}`, 120)
    : 'Review proposed file changes';
  return { paths, counts, summary };
}

function extractApprovalPath(entry: any): string | null {
  const candidates = [entry?.path, entry?.filePath, entry?.target, entry?.newPath, entry?.oldPath];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function inferCommandApprovalRisk(commandText: string | null): PendingApprovalRecord['riskLevel'] {
  const normalized = (commandText ?? '').toLowerCase();
  if (!normalized) {
    return 'medium';
  }
  if (/(^|\s)(sudo|rm\s+-rf|git\s+reset\s+--hard|mkfs|dd\s+if=|shutdown|reboot)(\s|$)/.test(normalized)) {
    return 'high';
  }
  if (/(^|\s)(curl|wget|npm\s+(install|update)|pnpm\s+(install|update)|yarn\s+(add|install)|chmod|chown|docker|kubectl|terraform)(\s|$)/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function inferFileChangeApprovalRisk(
  paths: string[],
  counts: { create: number; update: number; delete: number },
): PendingApprovalRecord['riskLevel'] {
  if (counts.delete > 0 || paths.some((path) => /(^|\/)(\.env|\.git|Dockerfile|docker-compose|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path))) {
    return 'high';
  }
  if (paths.length > 3 || counts.create > 0) {
    return 'medium';
  }
  return 'low';
}

function formatApprovalChangeCounts(locale: AppLocale, raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const counts = raw as { create?: unknown; update?: unknown; delete?: unknown };
  const parts: string[] = [];
  if (Number(counts.create || 0) > 0) {
    parts.push(locale === 'zh' ? `新增 ${Number(counts.create)} 个` : `${Number(counts.create)} create`);
  }
  if (Number(counts.update || 0) > 0) {
    parts.push(locale === 'zh' ? `修改 ${Number(counts.update)} 个` : `${Number(counts.update)} update`);
  }
  if (Number(counts.delete || 0) > 0) {
    parts.push(locale === 'zh' ? `删除 ${Number(counts.delete)} 个` : `${Number(counts.delete)} delete`);
  }
  return parts.length > 0 ? parts.join(locale === 'zh' ? '，' : ', ') : null;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

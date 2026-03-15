import { t } from '../i18n.js';
import type { AppLocale } from '../types.js';

export type TurnCompletionState =
  | 'completed'
  | 'interrupted'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_required'
  | 'failed';

export interface TurnCompletionInfo {
  state: TurnCompletionState;
  statusText: string | null;
  errorText: string | null;
}

const RATE_LIMIT_PATTERN = /\b429\b|too many requests|retry after|rate limit|rate[- ]limited|resource[_ -]?exhausted|model[_ -]?capacity[_ -]?exhausted|no capacity available|capacity unavailable/i;
const QUOTA_PATTERN = /insufficient[_ -]?quota|quota(?:\s+limit)?|usage limit|credit(?:s|\s+balance)?|out of credits|no credits|exhaust(?:ed|ion)|额度|限额|配额/i;
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|not authenticated|authentication required|login required|sign in|expired session|session expired|token expired|auth(?:entication)? failed|未登录|登录已过期|认证失败/i;
const INTERRUPTED_PATTERN = /interrupt|interrupted|cancel(?:led)?|aborted?|stopped by user|用户中断|已中断/i;
const FAILURE_STATUS_PATTERN = /fail(?:ed|ure)?|error|denied|declined|rejected|aborted?|cancel(?:led)?|interrupted/i;

export function classifyTurnCompletion(params: any): TurnCompletionInfo {
  const statusText = firstText([
    params?.status,
    params?.state,
    params?.turn?.status,
    params?.turn?.state,
    params?.result?.status,
    params?.result?.state,
  ]);
  const errorText = firstText([
    params?.error,
    params?.errorMessage,
    params?.message,
    params?.turn?.error,
    params?.turn?.errorMessage,
    params?.result?.error,
    params?.result?.errorMessage,
  ]);
  const haystack = `${statusText ?? ''}\n${errorText ?? ''}`.trim();

  if (INTERRUPTED_PATTERN.test(haystack)) {
    return { state: 'interrupted', statusText, errorText };
  }
  if (RATE_LIMIT_PATTERN.test(haystack)) {
    return { state: 'rate_limited', statusText, errorText };
  }
  if (QUOTA_PATTERN.test(haystack)) {
    return { state: 'quota_exhausted', statusText, errorText };
  }
  if (AUTH_PATTERN.test(haystack)) {
    return { state: 'auth_required', statusText, errorText };
  }
  if (errorText || (statusText && FAILURE_STATUS_PATTERN.test(statusText))) {
    return { state: 'failed', statusText, errorText };
  }
  return { state: 'completed', statusText, errorText };
}

export function resolveTurnCompletion(
  completion: Pick<TurnCompletionInfo, 'state' | 'statusText' | 'errorText'>,
  interruptRequested: boolean,
): TurnCompletionInfo {
  if (completion.state === 'completed' && interruptRequested) {
    return {
      state: 'interrupted',
      statusText: completion.statusText,
      errorText: completion.errorText,
    };
  }
  return {
    state: completion.state,
    statusText: completion.statusText,
    errorText: completion.errorText,
  };
}

export function formatTurnCompletionText(
  locale: AppLocale,
  completion: TurnCompletionInfo,
  variant: 'plain' | 'see_reply_below' | 'partial_output',
): string {
  switch (completion.state) {
    case 'completed':
      return t(locale, variant === 'see_reply_below' ? 'completed_see_reply_below' : 'completed');
    case 'interrupted':
      return t(locale, variant === 'partial_output' ? 'interrupted_partial_output' : variant === 'see_reply_below'
        ? 'interrupted_see_reply_below'
        : 'interrupted');
    case 'rate_limited':
      if (variant === 'see_reply_below') {
        return t(locale, 'rate_limited_see_reply_below');
      }
      if (variant === 'partial_output') {
        return t(locale, 'rate_limited_partial_output');
      }
      return completion.errorText
        ? t(locale, 'rate_limited_with_error', { error: completion.errorText })
        : t(locale, 'rate_limited');
    case 'quota_exhausted':
      return t(
        locale,
        variant === 'see_reply_below'
          ? 'quota_exhausted_see_reply_below'
          : variant === 'partial_output'
            ? 'quota_exhausted_partial_output'
            : 'quota_exhausted',
      );
    case 'auth_required':
      return t(
        locale,
        variant === 'see_reply_below'
          ? 'auth_required_see_reply_below'
          : variant === 'partial_output'
            ? 'auth_required_partial_output'
            : 'auth_required',
      );
    case 'failed':
      if (variant === 'see_reply_below') {
        return t(locale, 'failed_see_reply_below');
      }
      if (variant === 'partial_output') {
        return t(locale, 'failed_partial_output');
      }
      return completion.errorText
        ? t(locale, 'failed_with_error', { error: completion.errorText })
        : t(locale, 'failed');
    default:
      return t(locale, 'failed');
  }
}

function firstText(values: unknown[]): string | null {
  for (const value of values) {
    const text = coerceText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function coerceText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => coerceText(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (parts.length > 0) {
      return parts.join(' ');
    }
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of ['message', 'text', 'reason', 'error', 'status', 'value']) {
    if (key in value) {
      const nested = coerceText((value as Record<string, unknown>)[key]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

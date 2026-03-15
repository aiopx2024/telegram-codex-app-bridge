import type { CollaborationModeValue, GeminiApprovalModeValue } from '../types.js';

export function normalizeRequestedCollaborationMode(value: string): CollaborationModeValue | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'default') {
    return null;
  }
  if (normalized === 'plan') {
    return 'plan';
  }
  return null;
}

export function normalizeRequestedGeminiApprovalMode(value: string): GeminiApprovalModeValue | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized || normalized === 'default') {
    return null;
  }
  if (normalized === 'auto_edit' || normalized === 'yolo' || normalized === 'plan') {
    return normalized;
  }
  return null;
}

export function inferTelegramChatType(chatId: string): string {
  return String(chatId).startsWith('-') ? 'supergroup' : 'private';
}

export function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}

export function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}

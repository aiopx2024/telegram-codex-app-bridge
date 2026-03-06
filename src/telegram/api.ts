export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

const BASE_URL = 'https://api.telegram.org';

export async function callTelegramApi<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  const response = await fetch(`${BASE_URL}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<TelegramApiResult<T>>;
}

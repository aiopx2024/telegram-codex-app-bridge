export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const rawName = parts.shift();
  if (!rawName) return null;
  const name = (rawName.slice(1).split('@', 1)[0] ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: parts };
}

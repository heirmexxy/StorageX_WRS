// One place that calls the AI model, so every agent uses the same key, model and error handling.
import { config } from '../config';

export type ModelCall = (system: string, content: unknown[]) => Promise<{ text: string; tin: number; tout: number }>;

export const callAnthropic: ModelCall = async (system, content) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(90_000),
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.aiModel, max_tokens: 1200, system, messages: [{ role: 'user', content }] }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
  return { text: (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''), tin: j.usage?.input_tokens || 0, tout: j.usage?.output_tokens || 0 };
};

export const defaultModel = (): ModelCall | null => (config.anthropicKey ? callAnthropic : null);

export function jsonFrom(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in the answer');
  return JSON.parse(m[0]);
}

export const imagePart = (mime: string, data: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } });

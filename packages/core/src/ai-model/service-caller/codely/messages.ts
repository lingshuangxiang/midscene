import type { ConversationMessage, ModelCallMessages } from '../types';

export type ACPContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const supportedMime = /^image\/(png|jpeg|webp|gif|avif)$/;

function imageContent(bytes: Buffer, mimeType: string): ACPContent {
  if (
    !supportedMime.test(mimeType) ||
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES
  ) {
    throw new Error(
      'Codely requires a PNG/JPEG/WebP/GIF/AVIF image of at most 20 MiB',
    );
  }
  return { type: 'image', mimeType, data: bytes.toString('base64') };
}

async function loadImage(
  url: string,
  signal: AbortSignal,
): Promise<ACPContent> {
  signal.throwIfAborted();
  if (url.startsWith('data:')) {
    const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      url,
    );
    if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error('Invalid or oversized Codely image data URL');
    }
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2])
      throw new Error('Invalid image base64');
    return imageContent(bytes, match[1]);
  }
  if (/^https?:\/\//.test(url)) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Failed to load Codely image (HTTP ${response.status})`);
    const mimeType =
      response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!supportedMime.test(mimeType)) {
      await response.body.cancel();
      throw new Error('Unsupported Codely HTTP image content type');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES)
          throw new Error('Codely image exceeds 20 MiB');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return imageContent(Buffer.concat(chunks), mimeType);
  }
  const fsModule = 'node:fs/promises';
  const pathModule = 'node:path';
  const urlModule = 'node:url';
  const [{ readFile, stat }, path, { fileURLToPath }] = await Promise.all([
    import(fsModule),
    import(pathModule),
    import(urlModule),
  ]);
  const file = url.startsWith('file://') ? fileURLToPath(url) : url;
  const extension = path.extname(file).toLowerCase();
  const mimeType = (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.avif': 'image/avif',
    } as Record<string, string>
  )[extension];
  if (!mimeType) throw new Error('Unsupported local Codely image extension');
  if ((await stat(file)).size > MAX_IMAGE_BYTES)
    throw new Error('Codely image exceeds 20 MiB');
  return imageContent(await readFile(file, { signal }), mimeType);
}

export function normalizeCodelyMessages(messages: ModelCallMessages) {
  const conversation: ConversationMessage[] = messages.map((entry) => {
    if ('role' in entry) return entry;
    if (entry.type === 'input-message') return entry.message;
    if (entry.output.type !== 'chat-completion')
      throw new Error(
        'Cannot replay Responses output in a Codely conversation',
      );
    return { role: 'assistant', content: entry.output.rawValue.content ?? '' };
  });
  const systemPrompt = conversation
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n'),
    )
    .join('\n\n');
  const turns = conversation.filter((message) => message.role !== 'system');
  if (!turns.length)
    throw new Error('Codely model call requires a user message');
  return { systemPrompt: systemPrompt || 'You are an AI assistant.', turns };
}

export async function buildCodelyPrompt(
  turns: ReturnType<typeof normalizeCodelyMessages>['turns'],
  signal: AbortSignal,
): Promise<ACPContent[]> {
  const prompt: ACPContent[] = [];
  for (const message of turns) {
    if (turns.length > 1)
      prompt.push({ type: 'text', text: `[${message.role.toUpperCase()}]` });
    for (const part of typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content) {
      signal.throwIfAborted();
      prompt.push(
        part.type === 'image'
          ? await loadImage(part.url, signal)
          : { type: 'text', text: part.text },
      );
    }
  }
  return prompt;
}

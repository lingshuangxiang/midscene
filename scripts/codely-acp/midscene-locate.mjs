import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const sourceRoot = new URL(
  '../../packages/core/src/ai-model/',
  import.meta.url,
);
const sourceFiles = [
  'shared/json.ts',
  'shared/model-locate-result/types.ts',
  'shared/model-locate-result/prompt-spec.ts',
  'shared/model-locate-result/result-field.ts',
  'shared/model-locate-result/parse.ts',
  'shared/model-locate-result/pixel-mapper.ts',
  'shared/model-locate-result/validation.ts',
  'shared/model-locate-result/factory.ts',
  'model-adapter/default-locate-protocol.ts',
  'prompt/locate/grounding-rules.ts',
  'prompt/locate/element-system-prompt.ts',
];

// This isolated experiment has no installed workspace dependencies. Execute
// the small, local TS source graph after removing types/import/export syntax;
// do not copy or rewrite Midscene's prompt strings or coordinate algorithms.
// The two external dependencies are supplied explicitly: preferred language
// and a fail-closed JSON-repair function. Valid JSON/fences use the real parser.
export async function buildMidsceneLocate(target, language = 'Chinese') {
  const sources = [];
  const modules = [];
  for (const file of sourceFiles) {
    const source = await readFile(new URL(file, sourceRoot), 'utf8');
    sources.push({
      file,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    modules.push(
      stripTypeScriptTypes(source)
        .replace(/^import\s[\s\S]*?;\s*/gm, '')
        .replace(/^export\s+(?=(?:const|function|class)\b)/gm, ''),
    );
  }
  const runtime = new Function(
    'getPreferredLanguage',
    'jsonrepair',
    `${modules.join('\n')}\nreturn { createDefaultElementProtocol, createLocateResultCodec, buildElementLocateSystemPrompt, parseModelResponseJson };`,
  )(
    () => language,
    () => {
      throw new Error('JSON repair disabled in standalone probe');
    },
  );
  // Same contract as resolveLocate's default format; this does not assert
  // that the opaque codely-vl alias belongs to any particular model family.
  const format = {
    coordinates: { shape: 'bbox', order: 'xy', normalizedBy: 1000 },
  };
  const codec = runtime.createLocateResultCodec(format);
  const protocol = runtime.createDefaultElementProtocol({
    jsonParser: runtime.parseModelResponseJson,
  });
  return {
    sources,
    format,
    systemPrompt: runtime.buildElementLocateSystemPrompt({
      systemPromptIntroduction: protocol.systemPromptIntroduction,
      responseInstructions: protocol.buildResponseInstructions(
        codec.promptSpec,
      ),
    }),
    userPrompt: protocol.buildUserPrompt(target),
    parseResponse(content, size) {
      const parsed = protocol.parseRawResponse(content, codec.promptSpec);
      if (parsed.kind !== 'located' || parsed.error) {
        throw new Error(parsed.error || 'Target not found');
      }
      if (
        !Array.isArray(parsed.target) ||
        parsed.target.length !== 4 ||
        !parsed.target.every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
      ) {
        throw new Error('Expected four finite numeric bbox values');
      }
      const result = codec.toPixelResult(parsed.target, { preparedSize: size });
      return { rawTarget: parsed.target, ...result };
    },
  };
}

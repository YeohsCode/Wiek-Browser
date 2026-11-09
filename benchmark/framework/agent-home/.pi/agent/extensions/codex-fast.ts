// Register `openai-codex-fast` by reusing the built-in `openai-codex`
// implementation and ChatGPT authentication while injecting service_tier="priority".
// Choose `openai-codex-fast/<id>` for this tier and `openai-codex/<id>` for default.
//
// Pi does not expose service_tier through CLI or settings, and its provider-request
// hook does not run for Codex. The stream therefore receives options.serviceTier.
// Registration only reads the built-in model catalog; the stream resolves tokens
// through the primary modelRegistry path so OAuth refresh remains shared.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	streamOpenAICodexResponses,
	getModels,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const FAST_PROVIDER = "openai-codex-fast";
const FAST_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);

// Capture the primary authentication registry at session start because streamSimple has no context.
let modelRegistry: { getApiKeyAndHeaders(model: unknown): Promise<{ apiKey?: string; headers?: Record<string, string> }> } | null = null;

function canonicalErrorMessage(modelId: string, errorMessage: string, aborted: boolean) {
	return {
		role: "assistant" as const,
		content: [],
		api: CODEX_API,
		provider: CODEX_PROVIDER,
		model: modelId,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

export default function (pi: ExtensionAPI) {
	const codexModels: any[] = getModels(CODEX_PROVIDER);
	const fastModels = codexModels.filter((m) => FAST_MODEL_IDS.has(m.id));
	const baseUrl = fastModels.find((m) => m.baseUrl)?.baseUrl;
	// Do not register a partial provider when the built-in Codex catalog is unavailable.
	if (fastModels.length === 0 || !baseUrl) return;

	pi.on("session_start", (_event: any, ctx: any) => {
		modelRegistry = ctx.modelRegistry;
	});

	pi.registerProvider(FAST_PROVIDER, {
		name: "OpenAI Codex Fast",
		baseUrl,
		apiKey: "__reuses_openai_codex_auth__", // Placeholder; modelRegistry resolves the real token.
		api: CODEX_API,
		models: fastModels.map((m) => ({
			id: m.id,
			name: m.name,
			baseUrl: m.baseUrl,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(m.compat ? { compat: m.compat } : {}),
		})),
		streamSimple: (model: any, context: any, options: any) => {
			const outer = createAssistantMessageEventStream();
			const codexModel = codexModels.find((m) => m.id === model.id);
			const registry = modelRegistry;
			if (!codexModel || !registry) {
				const reason = !codexModel ? `underlying openai-codex model not found: ${model.id}` : "openai-codex-fast: model registry unavailable";
				outer.push({ type: "error", reason: "error", error: canonicalErrorMessage(model.id, reason, false) as any });
				outer.end(canonicalErrorMessage(model.id, reason, false) as any);
				return outer;
			}
			void (async () => {
				try {
					const auth = await registry.getApiKeyAndHeaders(codexModel);
					const inner = streamOpenAICodexResponses(codexModel, context, {
						...options,
						apiKey: auth.apiKey,
						headers: { ...(options?.headers ?? {}), ...(auth.headers ?? {}) },
						serviceTier: "priority",
					});
					for await (const event of inner) outer.push(event);
					outer.end();
				} catch (error) {
					const aborted = Boolean(options?.signal?.aborted);
					const msg = canonicalErrorMessage(model.id, error instanceof Error ? error.message : String(error), aborted);
					outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: msg as any });
					outer.end(msg as any);
				}
			})();
			return outer;
		},
	});
}

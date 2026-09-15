/**
 * LiteLLM-inspired local complexity classifier for combo routing.
 * Scores the last real user ask across independent, configurable dimensions.
 */

export const COMPLEXITY_TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

const DEFAULT_CODE_KEYWORDS = [
  "function", "class", "def", "const", "let", "var", "import", "export", "return", "async", "await",
  "try", "catch", "exception", "error", "debug", "api", "endpoint", "request", "response", "database",
  "sql", "query", "schema", "algorithm", "implement", "refactor", "optimize", "python", "javascript",
  "typescript", "java", "rust", "golang", "react", "vue", "angular", "node", "docker", "kubernetes",
  "git", "commit", "merge", "branch", "pull request",
];
const DEFAULT_REASONING_KEYWORDS = [
  "step by step", "think through", "let's think", "reason through", "analyze this", "break down",
  "explain your reasoning", "show your work", "chain of thought", "think carefully", "consider all", "evaluate",
  "pros and cons", "compare and contrast", "weigh the options", "logical", "deduce", "infer", "conclude",
];
const DEFAULT_TECHNICAL_KEYWORDS = [
  "architecture", "distributed", "scalable", "microservice", "machine learning", "neural network", "deep learning",
  "encryption", "authentication", "authorization", "performance", "latency", "throughput", "benchmark",
  "concurrency", "parallel", "threading", "memory", "cpu", "gpu", "optimization", "protocol", "tcp", "http",
  "grpc", "websocket", "container", "orchestration",
];
const DEFAULT_SIMPLE_KEYWORDS = [
  "what is", "what's", "define", "definition of", "who is", "who was", "when did", "when was", "where is",
  "where was", "how many", "how much", "yes or no", "true or false", "simple", "brief", "short", "quick",
  "hello", "hi", "hey", "thanks", "thank you", "goodbye", "bye", "okay",
];
const DEFAULT_WEIGHTS = {
  tokenCount: 0.10,
  codePresence: 0.30,
  reasoningMarkers: 0.25,
  technicalTerms: 0.25,
  simpleIndicators: 0.05,
  multiStepPatterns: 0.03,
  questionComplexity: 0.02,
};
const DEFAULT_BOUNDARIES = { simple_medium: 0.15, medium_complex: 0.35, complex_reasoning: 0.60 };
const DEFAULT_TOKEN_THRESHOLDS = { simple: 15, complex: 400 };
const DEFAULT_ESCALATION_KEYWORDS = ["9ROUTER ESCALATE", "LITELLM ESCALATE"];
const MULTI_STEP_PATTERNS = [
  /\bfirst\b[\s\S]*\bthen\b/i,
  /\b(?:step|phase)\s+\d+\b/i,
  /(?:^|\n)\s*\d+[.)]\s+/m,
];
const sessionPins = new Map();

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type !== "tool_result" && typeof part.text === "string")
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

export function extractLastUserAsk(body = {}) {
  if (typeof body.input === "string") return body.input.trim();
  const messages = body.messages || body.input || body.contents || body.request?.contents || [];
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = contentText(message.content ?? message.parts);
    if (text) return text;
  }
  return "";
}

function keywordMatches(text, keyword) {
  const normalized = String(keyword).trim().toLowerCase();
  if (!normalized) return false;
  if (/\s|[\u3400-\u9fff]/u.test(normalized)) return text.includes(normalized);
  return new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function keywordDimension(text, keywords, name, label, thresholds, scores) {
  const matches = keywords.filter((keyword) => keywordMatches(text, keyword));
  const [lowThreshold, highThreshold] = thresholds;
  const [noneScore, lowScore, highScore] = scores;
  if (matches.length < lowThreshold) return { name, score: noneScore, matches: [], signal: null };
  return {
    name,
    score: matches.length >= highThreshold ? highScore : lowScore,
    matches,
    signal: `${label} (${matches.slice(0, 3).join(", ")})`,
  };
}

function normalizedConfig(config = {}) {
  const configuredBoundaries = { ...DEFAULT_BOUNDARIES, ...(config.tierBoundaries || {}) };
  const boundaries = configuredBoundaries.simple_medium < configuredBoundaries.medium_complex
    && configuredBoundaries.medium_complex < configuredBoundaries.complex_reasoning
    ? configuredBoundaries
    : DEFAULT_BOUNDARIES;
  return {
    weights: { ...DEFAULT_WEIGHTS, ...(config.dimensionWeights || {}) },
    boundaries,
    tokenThresholds: { ...DEFAULT_TOKEN_THRESHOLDS, ...(config.tokenThresholds || {}) },
    codeKeywords: config.codeKeywords || DEFAULT_CODE_KEYWORDS,
    reasoningKeywords: config.reasoningKeywords || DEFAULT_REASONING_KEYWORDS,
    technicalKeywords: [...(config.technicalKeywords || DEFAULT_TECHNICAL_KEYWORDS), ...(config.customTechnicalKeywords || [])],
    simpleKeywords: config.simpleKeywords || DEFAULT_SIMPLE_KEYWORDS,
    escalationKeywords: config.escalationKeywords || DEFAULT_ESCALATION_KEYWORDS,
    keywordTierRules: Array.isArray(config.keywordTierRules) ? config.keywordTierRules : [],
  };
}

function nextTier(tier) {
  return COMPLEXITY_TIERS[Math.min(COMPLEXITY_TIERS.indexOf(tier) + 1, COMPLEXITY_TIERS.length - 1)];
}

function defaultModelIndexForTier(tier, modelCount) {
  const tierIndex = COMPLEXITY_TIERS.indexOf(tier);
  return Math.min(modelCount - 1, Math.ceil((tierIndex / (COMPLEXITY_TIERS.length - 1)) * (modelCount - 1)));
}

export function getDefaultTierModels(models) {
  if (!Array.isArray(models) || models.length === 0) return {};
  return Object.fromEntries(COMPLEXITY_TIERS.map((tier) => [tier, models[defaultModelIndexForTier(tier, models.length)]]));
}

function configuredTierModels(models, config) {
  const defaults = getDefaultTierModels(models);
  return Object.fromEntries(COMPLEXITY_TIERS.map((tier) => {
    const configured = config?.tiers?.[tier];
    const candidates = (Array.isArray(configured) ? configured : [configured || defaults[tier]])
      .filter((model) => models.includes(model));
    return [tier, candidates.length > 0 ? candidates : [defaults[tier]]];
  }));
}

function orderedModelsForTier(models, tier, tierModels) {
  const selectedTierIndex = COMPLEXITY_TIERS.indexOf(tier);
  const tierOrder = [
    ...COMPLEXITY_TIERS.slice(selectedTierIndex),
    ...COMPLEXITY_TIERS.slice(0, selectedTierIndex).reverse(),
  ];
  const ordered = tierOrder.flatMap((tierName) => tierModels[tierName]);
  return [...new Set([...ordered, ...models])];
}

function toolCallSignature(call) {
  const fn = call?.function || call;
  const name = fn?.name;
  if (!name) return null;
  const args = fn.arguments ?? fn.input ?? {};
  let normalizedArgs;
  try {
    normalizedArgs = typeof args === "string" ? JSON.stringify(JSON.parse(args)) : JSON.stringify(args);
  } catch {
    normalizedArgs = String(args);
  }
  return `${name}:${normalizedArgs}`;
}

function recentToolCallSignatures(body, windowSize) {
  const messages = body.messages || body.input || [];
  if (!Array.isArray(messages)) return [];
  const signatures = [];
  for (let index = messages.length - 1; index >= 0 && signatures.length < windowSize; index--) {
    const message = messages[index];
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "tool_use") : [];
    for (let callIndex = calls.length - 1; callIndex >= 0 && signatures.length < windowSize; callIndex--) {
      const signature = toolCallSignature(calls[callIndex]);
      if (signature) signatures.push(signature);
    }
  }
  return signatures;
}

export function detectStalledTask(body, config = {}) {
  if (config.stallEscalationEnabled === false) return false;
  const repeatThreshold = Math.max(2, Number(config.stallEscalationRepeatThreshold) || 3);
  const signatures = recentToolCallSignatures(body, Math.max(repeatThreshold, Number(config.stallEscalationWindow) || 8));
  if (signatures.length < repeatThreshold) return false;
  return signatures.filter((signature) => signature === signatures[0]).length >= repeatThreshold;
}

export function classifyRequestComplexity(body = {}, config = {}) {
  const resolved = normalizedConfig(config);
  const ask = extractLastUserAsk(body);
  const text = ask.toLowerCase();

  const overrides = resolved.keywordTierRules
    .map((rule) => ({ rule, match: (rule.keywords || []).find((keyword) => keywordMatches(text, keyword)) }))
    .filter(({ rule, match }) => match && COMPLEXITY_TIERS.includes(rule.tier));
  const override = overrides.length > 0
    ? overrides.sort((left, right) => COMPLEXITY_TIERS.indexOf(right.rule.tier) - COMPLEXITY_TIERS.indexOf(left.rule.tier))[0]
    : null;

  const estimatedTokens = Math.floor(ask.length / 4);
  const tokenScore = estimatedTokens < resolved.tokenThresholds.simple ? -1 : estimatedTokens > resolved.tokenThresholds.complex ? 1 : 0;
  const code = keywordDimension(text, resolved.codeKeywords, "codePresence", "code", [1, 2], [0, 0.5, 1]);
  const reasoning = keywordDimension(text, resolved.reasoningKeywords, "reasoningMarkers", "reasoning", [1, 2], [0, 0.7, 1]);
  const technical = keywordDimension(text, resolved.technicalKeywords, "technicalTerms", "technical", [2, 4], [0, 0.5, 1]);
  const simple = keywordDimension(text, resolved.simpleKeywords, "simpleIndicators", "simple", [1, 2], [0, -1, -1]);
  const multiStep = MULTI_STEP_PATTERNS.some((pattern) => pattern.test(ask)) ? 0.5 : 0;
  const questionComplexity = (ask.match(/\?/g) || []).length > 3 ? 0.5 : 0;
  const dimensions = [
    { name: "tokenCount", score: tokenScore, signal: tokenScore ? `${tokenScore < 0 ? "short" : "long"} (${estimatedTokens} tokens)` : null },
    code, reasoning, technical, simple,
    { name: "multiStepPatterns", score: multiStep, signal: multiStep ? "multi-step" : null },
    { name: "questionComplexity", score: questionComplexity, signal: questionComplexity ? "multiple questions" : null },
  ];
  const score = dimensions.reduce((total, dimension) => total + dimension.score * (resolved.weights[dimension.name] || 0), 0);
  let tier = override?.rule.tier || (score < resolved.boundaries.simple_medium ? "SIMPLE"
    : score < resolved.boundaries.medium_complex ? "MEDIUM"
      : score < resolved.boundaries.complex_reasoning ? "COMPLEX" : "REASONING");
  let cause = override ? "literal_keyword_match" : "heuristic_scorer";
  if (!override && reasoning.matches.length >= 2 && score >= resolved.boundaries.simple_medium) {
    tier = "REASONING";
    cause = "reasoning_override";
  }
  const escalationKeyword = resolved.escalationKeywords.find((keyword) => ask.includes(keyword));
  if (escalationKeyword) tier = nextTier(tier);
  const stalled = detectStalledTask(body, config);
  if (stalled) tier = nextTier(tier);

  return {
    tier,
    score: override ? null : score,
    cause,
    signals: [
      ...dimensions.map((dimension) => dimension.signal).filter(Boolean),
      ...(escalationKeyword ? ["escalation"] : []),
      ...(stalled ? ["stall_escalation"] : []),
    ],
    escalationKeyword: escalationKeyword || null,
    matchedKeyword: override?.match || null,
    ask,
  };
}

export function routeModelsByComplexity(models, body, config = {}) {
  if (!Array.isArray(models) || models.length <= 1) return { models, decision: classifyRequestComplexity(body, config) };
  const decision = classifyRequestComplexity(body, config);
  const tierModels = configuredTierModels(models, config);
  let orderedModels = orderedModelsForTier(models, decision.tier, tierModels);
  let selectedModel = orderedModels[0];
  const sessionId = body?.metadata?.session_id || body?.metadata?.sessionId || body?.session_id;
  if (config.sessionAffinity === true && sessionId) {
    const pinKey = `${config.routerName || "default"}:${sessionId}`;
    const existing = sessionPins.get(pinKey);
    const pinnedTierIndex = existing && existing.expiresAt > Date.now()
      ? COMPLEXITY_TIERS.indexOf(existing.tier)
      : -1;
    if (pinnedTierIndex >= COMPLEXITY_TIERS.indexOf(decision.tier) && models.includes(existing.model)) {
      selectedModel = existing.model;
      orderedModels = [selectedModel, ...orderedModels.filter((model) => model !== selectedModel)];
      decision.tier = existing.tier;
      decision.signals = [
        ...decision.signals,
        "session_pin",
      ];
    }
    sessionPins.set(pinKey, {
      model: selectedModel,
      tier: decision.tier,
      expiresAt: Date.now() + Math.max(1_000, Number(config.sessionAffinityTtlMs) || 3_600_000),
    });
  }
  return {
    models: orderedModels,
    decision: { ...decision, selectedModel, tierModels },
  };
}

export function resetComplexitySessionPins(routerName) {
  if (!routerName) {
    sessionPins.clear();
    return;
  }
  for (const key of sessionPins.keys()) {
    if (key.startsWith(`${routerName}:`)) sessionPins.delete(key);
  }
}

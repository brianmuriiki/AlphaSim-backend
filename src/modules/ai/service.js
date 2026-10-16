import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { User } from '../../models/User.js';
import { Alpha } from '../../models/Alpha.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { Simulation } from '../../models/Simulation.js';
import { AIInteraction } from '../../models/AIInteraction.js';
import { Datafield } from '../../models/Datafield.js';
import { Operator } from '../../models/Operator.js';
import { lintExpression } from '../../lib/linter.js';
import { decrypt } from '../../lib/crypto.js';
import { createSimulation, cancelSimulation } from '../simulations/service.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
async function resolveOpenRouterKey(userId) {
  if (userId) {
    const user = await User.findById(userId).select('+encryptedAiApiKey').lean();
    if (user?.encryptedAiApiKey) return decrypt(user.encryptedAiApiKey);
  }
  if (!env.OPENROUTER_API_KEY) throw new AppError(503, 'AI_NOT_CONFIGURED', 'Forge AI needs an OpenRouter API key. Add one in Settings or set OPENROUTER_API_KEY in the backend environment.');
  return env.OPENROUTER_API_KEY;
}
function normalizeUsage(usage = {}) {
  return { input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0, output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0 };
}
function openRouterTools() {
  return aiTools.map(({ name, description, input_schema }) => ({ type: 'function', function: { name, description, parameters: input_schema } }));
}
async function openRouterCompletion(body, userId) {
  const apiKey = await resolveOpenRouterKey(userId);
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': env.OPENROUTER_SITE_URL, 'X-OpenRouter-Title': 'AlphaSim Forge AI' },
    body: JSON.stringify({ model: env.AI_MODEL, ...body }),
    signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    const upstream = await response.json().catch(() => ({}));
    const status = response.status === 429 ? 429 : 502;
    throw new AppError(status, response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_ERROR', upstream.error?.message ?? 'OpenRouter could not complete this request');
  }
  return response;
}
function parseCompletion(response) {
  const message = response.choices?.[0]?.message;
  if (!message) throw new AppError(502, 'AI_INVALID_RESPONSE', 'OpenRouter returned an empty response');
  return { message, usage: normalizeUsage(response.usage), model: response.model ?? env.AI_MODEL };
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
  return '';
}
function parseJsonObject(content) {
  const text = contentText(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { /* Free model may wrap JSON in a short explanation. */ }
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { /* Try the next object boundary. */ }
        break;
      }
    }
  }
  return null;
}
export async function prompt(name) { return fs.readFile(path.join(__dirname, '../../prompts', `${name}-v1.md`), 'utf8'); }

export async function buildContext(userId, { alphaId, simulationId, expression, settings, includeExpression = true, datafieldNames = [], attachments = [] } = {}) {
  let alpha; let currentExpression = expression ?? ''; let currentSettings = settings ?? {};
  if (alphaId) {
    alpha = await Alpha.findOne({ _id: alphaId, userId, deletedAt: null }).lean();
    if (!alpha) throw new AppError(404, 'NOT_FOUND', 'Alpha was not found');
    if (expression === undefined && !currentExpression && includeExpression) {
      const version = alpha.currentVersionId ? await AlphaVersion.findOne({ _id: alpha.currentVersionId, userId }).lean() : null;
      currentExpression = alpha.draft?.expression ?? version?.expression ?? '';
      currentSettings = alpha.draft?.settings ?? version?.settings ?? {};
    }
  }
  let run = null;
  if (simulationId) {
    run = await Simulation.findOne({ _id: simulationId, userId, ...(alphaId ? { alphaId } : {}) }).select('status result error').lean();
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Simulation was not found');
  }
  const identifiers = [...new Set([...(currentExpression.match(/\b[A-Za-z_][A-Za-z0-9_.]*\b/g) ?? []), ...datafieldNames].map((item) => item.toLowerCase()))];
  const [fields, operators] = await Promise.all([
    Datafield.find({ name: { $in: identifiers }, $or: [{ ownerUserId: null }, { ownerUserId: userId }] }).select('name description type').limit(20).lean(),
    Operator.find({ name: { $in: identifiers } }).select('name signature description').limit(30).lean()
  ]);
  return { alphaId: alpha?._id?.toString(), expression: currentExpression, settings: currentSettings, run, fields, operators, attachments: attachments.map(({ name, content }) => ({ name, content })) };
}

async function checkBudget(userId) {
  const user = await User.findById(userId).select('aiUsage').lean();
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  const now = new Date();
  if (!user.aiUsage?.resetAt || user.aiUsage.resetAt <= now) {
    const resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await User.updateOne({ _id: userId }, { $set: { 'aiUsage.monthlyTokens': 0, 'aiUsage.resetAt': resetAt } });
    return;
  }
  if ((user.aiUsage.monthlyTokens ?? 0) >= env.AI_MONTHLY_TOKEN_BUDGET) throw new AppError(429, 'AI_BUDGET_EXCEEDED', 'Monthly AI token budget has been reached');
}
async function recordUsage(userId, kind, usage, promptText, alphaId = null, outcome = 'completed', model = env.AI_MODEL) {
  const tokensIn = usage?.input_tokens ?? 0; const tokensOut = usage?.output_tokens ?? 0;
  const [, interaction] = await Promise.all([
    User.updateOne({ _id: userId }, { $inc: { 'aiUsage.monthlyTokens': tokensIn + tokensOut } }),
    AIInteraction.create({ userId, alphaId, kind, model, promptVersion: 'v1', promptHash: crypto.createHash('sha256').update(promptText).digest('hex'), tokensIn, tokensOut, outcome })
  ]);
  return interaction.id;
}

const aiTools = [
  { name: 'lint_expression', description: 'Check Fast Expression syntax and known operators/fields.', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'search_datafields', description: 'Find datafield names by keyword.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_operator_doc', description: 'Look up operator signatures and descriptions.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'update_alpha_draft', description: 'Update the current alpha editor draft after the user explicitly asks you to edit or apply a change. Always lint first.', input_schema: { type: 'object', properties: { expression: { type: 'string' }, settings: { type: 'object' } }, required: ['expression'] } },
  { name: 'save_alpha_version', description: 'Save the current expression as a version when the user asks to save or checkpoint it.', input_schema: { type: 'object', properties: { expression: { type: 'string' }, settings: { type: 'object' }, note: { type: 'string' } }, required: ['expression'] } },
  { name: 'run_alpha', description: 'Queue a real simulation through the connected BRAIN provider only when the user explicitly asks to run/test/simulate. Never claim it completed until results arrive.', input_schema: { type: 'object', properties: { expression: { type: 'string' }, settings: { type: 'object' } }, required: ['expression'] } },
  { name: 'cancel_run', description: 'Cancel an active simulation for the current alpha only when the user explicitly requests cancellation.', input_schema: { type: 'object', properties: { simulationId: { type: 'string' } }, required: ['simulationId'] } }
];
const settingsSchema = z.object({ region: z.string().max(40).default('USA'), universe: z.string().max(80).default('TOP3000'), delay: z.number().int().min(0).max(2).default(1), decay: z.number().min(0).max(100).default(0), neutralization: z.string().max(40).default('SUBINDUSTRY'), truncation: z.number().min(0).max(1).default(0.08), pasteurization: z.string().max(40).default('ON'), nanHandling: z.string().max(40).default('OFF'), language: z.string().max(40).default('FASTEXPR') }).strict();
async function runTool(userId, alphaId, currentSettings, tool) {
  if (tool.name === 'lint_expression') return lintExpression(String(tool.input.expression ?? ''), { ownerUserId: userId });
  if (tool.name === 'search_datafields') {
    const query = String(tool.input.query ?? '').slice(0, 64).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Datafield.find({ name: { $regex: query, $options: 'i' }, $or: [{ ownerUserId: null }, { ownerUserId: userId }] }).select('name description type').limit(10).lean();
  }
  if (tool.name === 'get_operator_doc') return await Operator.findOne({ name: String(tool.input.name ?? '').toLowerCase() }).select('name category signature description examples').lean() ?? { error: 'Operator not found' };
  if (['update_alpha_draft', 'save_alpha_version', 'run_alpha', 'cancel_run'].includes(tool.name)) {
    if (!alphaId) return { error: 'Open an alpha in the workspace first.' };
    const alpha = await Alpha.findOne({ _id: alphaId, userId, deletedAt: null }).select('_id').lean();
    if (!alpha) return { error: 'The current alpha is unavailable.' };
    if (tool.name === 'cancel_run') {
      const simulationId = String(tool.input.simulationId ?? '');
      if (!/^[a-f\d]{24}$/i.test(simulationId)) return { error: 'Simulation id is invalid.' };
      const sim = await Simulation.findOne({ _id: simulationId, alphaId, userId }).select('_id').lean();
      if (!sim) return { error: 'Run not found for the current alpha.' };
      const cancelled = await cancelSimulation(userId, sim._id);
      return { action: { type: 'run_cancelled', simulationId: String(cancelled._id) } };
    }
    const expression = String(tool.input.expression ?? '').slice(0, 50000);
    let settings;
    try { settings = settingsSchema.parse({ ...currentSettings, ...(tool.input.settings && typeof tool.input.settings === 'object' && !Array.isArray(tool.input.settings) ? tool.input.settings : {}) }); }
    catch { return { error: 'Simulation settings are invalid; no change was applied.' }; }
    const lint = await lintExpression(expression, { ...settings, ownerUserId: userId });
    if (lint.errors.length) return { error: 'Expression failed validation; no change was applied.', errors: lint.errors };
    if (tool.name === 'update_alpha_draft') {
      await Alpha.updateOne({ _id: alphaId, userId, deletedAt: null }, { $set: { draft: { expression, settings } } });
      return { action: { type: 'draft_updated', alphaId: String(alphaId), expression, settings }, message: 'Draft updated and validated.' };
    }
    if (tool.name === 'save_alpha_version') {
      const version = await saveVersion(userId, alphaId, { expression, settings, source: 'ai', note: String(tool.input.note ?? 'Saved by Forge AI').slice(0, 500) });
      return { action: { type: 'version_saved', alphaId: String(alphaId), versionNumber: version.versionNumber }, message: `Saved version ${version.versionNumber}.` };
    }
    const simulation = await createSimulation(userId, { alphaId, expression, settings, source: 'ai' });
    return { action: { type: 'run_queued', alphaId: String(alphaId), simulationId: String(simulation._id), runNumber: simulation.runNumber }, message: `Run ${simulation.runNumber} was queued. Results will appear when the connected BRAIN provider finishes.` };
  }
  return { error: 'Tool unavailable' };
}

export async function streamChat(userId, { message, alphaId, simulationId, expression, settings, history = [], datafieldNames = [], attachments = [], includeExpression = true }, res) {
  await checkBudget(userId);
  await resolveOpenRouterKey(userId);
  const context = await buildContext(userId, { alphaId, simulationId, expression: includeExpression ? expression : '', settings, includeExpression, datafieldNames, attachments });
  const basePrompt = await prompt('chat');
  const system = `${basePrompt}\n\nWorkspace context (user-provided AlphaSim content):\n${JSON.stringify(context)}`;
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: message }];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let usedModel = env.AI_MODEL;
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    for (let turn = 0; turn < 4; turn += 1) {
      const response = await openRouterCompletion({ model: env.AI_MODEL, max_tokens: 1500, messages, tools: openRouterTools(), tool_choice: 'auto', stream: true, stream_options: { include_usage: true } }, userId);
      if (!response.body) throw new AppError(502, 'AI_INVALID_RESPONSE', 'OpenRouter returned no response stream');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      const toolCalls = [];
      let assistantText = '';
      let finishReason = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text) { assistantText += text; if (!res.destroyed) send({ t: text }); }
          for (const call of choice?.delta?.tool_calls ?? []) {
            const existing = toolCalls[call.index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (call.id) existing.id += call.id;
            if (call.function?.name) existing.function.name += call.function.name;
            if (call.function?.arguments) existing.function.arguments += call.function.arguments;
            toolCalls[call.index] = existing;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            const normalized = normalizeUsage(chunk.usage);
            usage.input_tokens += normalized.input_tokens; usage.output_tokens += normalized.output_tokens;
          }
          if (chunk.model) usedModel = chunk.model;
        }
      }
      messages.push({ role: 'assistant', content: assistantText || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      if (!toolCalls.length || finishReason !== 'tool_calls') break;
      const results = await Promise.all(toolCalls.map(async (call) => {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
        const result = await runTool(userId, alphaId, context.settings, { name: call.function.name, input });
        if (result.action && !res.destroyed) send({ action: result.action });
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      }));
      messages.push(...results);
    }
    await recordUsage(userId, 'chat', usage, system, alphaId, 'completed', usedModel);
    send({ done: true });
  } catch (error) {
    if (!res.destroyed) send({ error: { code: error.code ?? 'AI_ERROR', message: 'Forge AI could not complete this request' } });
  } finally { if (!res.destroyed) res.end(); }
}

async function requestStructured(userId, kind, instructions, input, alphaId) {
  await checkBudget(userId);
  const context = await buildContext(userId, input);
  const system = `${instructions}\n\nWorkspace context:\n${JSON.stringify(context)}`;
  // OpenRouter's free-model router can select providers without JSON-mode support.
  // Ask for JSON in the prompt and validate/repair it in the caller instead.
  const response = await openRouterCompletion({ max_tokens: 2200, messages: [{ role: 'system', content: system }, { role: 'user', content: input.message ?? `${kind} this expression.` }] }, userId);
  const completion = parseCompletion(await response.json());
  const text = contentText(completion.message.content);
  const interactionId = await recordUsage(userId, kind, completion.usage, system, alphaId, 'completed', completion.model);
  return { text, usage: completion.usage, context, interactionId };
}

export async function improve(userId, input) {
  const instructions = await prompt('improve');
  const response = await requestStructured(userId, 'improve', instructions, input, input.alphaId);
  let parsed = parseJsonObject(response.text);
  if (!parsed) {
    const repairPrompt = 'Return only one valid JSON object. Do not use markdown or add explanation. Required schema: {"suggestions":[{"title":"...","category":"...","impact":"...","rationale":"...","expression":"complete Fast Expression"}]}. If no valid expression can be produced, return {"suggestions":[]}. Keep expression strings syntactically valid.';
    const repairResponse = await openRouterCompletion({ max_tokens: 2200, messages: [{ role: 'system', content: repairPrompt }, { role: 'user', content: response.text.slice(0, 12000) }] }, userId);
    const repair = parseCompletion(await repairResponse.json());
    await recordUsage(userId, 'improve_format_retry', repair.usage, repairPrompt, input.alphaId, 'completed', repair.model);
    parsed = parseJsonObject(repair.message.content);
  }
  if (!parsed) throw new AppError(502, 'AI_INVALID_RESPONSE', 'The selected AI model did not return suggestions in a usable format. Try again or choose a different model.');
  const suggestions = [];
  if (!Array.isArray(parsed.suggestions)) return { suggestions: [], source: 'AI_SUGGESTION_ONLY', interactionId: response.interactionId };
  for (const item of parsed.suggestions.slice(0, 5)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.expression !== 'string') continue;
    let lint = await lintExpression(item.expression, { ...response.context.settings, ownerUserId: userId });
    if (lint.errors.length) {
      const repairPrompt = 'Repair the provided Fast Expression so it passes these validation errors. Return only the complete expression, with no markdown.';
      const repairResponse = await openRouterCompletion({ max_tokens: 1600, messages: [{ role: 'system', content: repairPrompt }, { role: 'user', content: JSON.stringify({ expression: item.expression, errors: lint.errors }) }] }, userId);
      const repair = parseCompletion(await repairResponse.json());
      await recordUsage(userId, 'improve_repair', repair.usage, repairPrompt, input.alphaId, 'completed', repair.model);
      const repaired = typeof repair.message.content === 'string' ? repair.message.content.trim() : '';
      if (!repaired) continue;
      lint = await lintExpression(repaired, { ...response.context.settings, ownerUserId: userId });
      if (lint.errors.length) continue;
      item.expression = repaired;
    }
    suggestions.push({ id: `s_${suggestions.length + 1}`, title: String(item.title ?? 'Suggestion').slice(0, 120), category: String(item.category ?? 'General').slice(0, 40), impact: String(item.impact ?? 'Unknown').slice(0, 30), rationale: String(item.rationale ?? '').slice(0, 1000), expression: item.expression });
  }
  return { suggestions, source: 'AI_SUGGESTION_ONLY', interactionId: response.interactionId };
}

export async function explain(userId, input) {
  const result = await requestStructured(userId, 'explain', 'Explain this Fast Expression in plain language. Do not claim performance.', input, input.alphaId);
  return { explanation: result.text, interactionId: result.interactionId };
}
export async function fix(userId, input) {
  const result = await requestStructured(userId, 'fix', 'Return JSON only: {"expression":"...","rationale":"..."}. Correct the supplied Fast Expression errors.', input, input.alphaId);
  try {
    const parsed = JSON.parse(result.text); const lint = await lintExpression(parsed.expression, { ...result.context.settings, ownerUserId: userId });
    if (lint.errors.length) throw new AppError(422, 'INVALID_EXPRESSION', 'AI repair did not pass validation', lint.errors);
    return { ...parsed, lint, source: 'AI_SUGGESTION_ONLY', interactionId: result.interactionId };
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'AI_INVALID_RESPONSE', 'Forge AI returned an invalid repair'); }
}
export async function generate(userId, input) {
  const result = await requestStructured(userId, 'generate', 'Generate up to three valid Fast Expression ideas from the request. Return JSON only: {"suggestions":[{"title":"...","rationale":"...","expression":"..."}]}. Do not claim performance.', input, input.alphaId);
  let parsed; try { parsed = JSON.parse(result.text); } catch { throw new AppError(502, 'AI_INVALID_RESPONSE', 'Forge AI returned invalid JSON'); }
  const suggestions = [];
  for (const item of (parsed.suggestions ?? []).slice(0, 3)) {
    if (typeof item.expression !== 'string') continue;
    const lint = await lintExpression(item.expression, { ...result.context.settings, ownerUserId: userId });
    if (!lint.errors.length) suggestions.push({ title: item.title, rationale: item.rationale, expression: item.expression, source: 'AI_SUGGESTION_ONLY' });
  }
  return { suggestions, interactionId: result.interactionId };
}

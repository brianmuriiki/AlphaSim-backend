import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { normalizeBrainResult } from './normalize.js';

export class BrainError extends Error {
  constructor(code, message = code, { retryable = false, retryAfterMs = 0, status = null, details = null } = {}) {
    super(message); this.name = 'BrainError'; this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.status = status; this.details = details;
  }
}

// The official adapter deliberately has no endpoint implementation until an authorized API contract exists.
// The local mock is isolated here and can never be enabled in production.
export class BrainClient {
  constructor(session) { this.session = session; this.baseUrl = env.MOCK_BRAIN_URL; }
  static async login(_email, _password) {
    if (env.BRAIN_MODE === 'official') throw new AppError(501, 'BRAIN_ADAPTER_UNAVAILABLE', 'No authorized official BRAIN API contract is configured');
    if (env.BRAIN_MODE === 'disabled') throw new AppError(503, 'BRAIN_DISABLED', 'BRAIN integration is disabled');
    let response;
    try { response = await fetch(`${env.MOCK_BRAIN_URL}/authentication`, { method: 'POST', signal: AbortSignal.timeout(5000) }); }
    catch { throw new AppError(503, 'MOCK_BRAIN_UNAVAILABLE', 'Local mock BRAIN service is unavailable. Start it with `npm run dev:mock-brain` or run `npm run dev`.'); }
    if (!response.ok) throw new AppError(503, 'MOCK_BRAIN_UNAVAILABLE', 'Local mock BRAIN service is unavailable');
    return { status: 'connected', cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  static async fromSession(session) {
    if (env.BRAIN_MODE === 'official') throw new BrainError('BRAIN_ADAPTER_UNAVAILABLE');
    if (env.BRAIN_MODE === 'disabled') throw new BrainError('BRAIN_DISABLED');
    if (!session?.startsWith('mock-session=')) throw new BrainError('SESSION_EXPIRED');
    return new BrainClient(session);
  }
  async request(url, options = {}) {
    let target;
    try { target = new URL(url, this.baseUrl); } catch { throw new BrainError('INVALID_PROGRESS_URL'); }
    if (target.origin !== new URL(this.baseUrl).origin) throw new BrainError('INVALID_PROGRESS_URL');
    let response;
    try { response = await fetch(target, { ...options, headers: { Cookie: this.session, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(30000) }); }
    catch (error) { throw new BrainError('BRAIN_UNAVAILABLE', error.message, { retryable: true }); }
    if (response.status === 401) throw new BrainError('SESSION_EXPIRED', 'Session expired', { status: 401 });
    if (response.status === 429) throw new BrainError('RATE_LIMITED', 'Provider rate limited the request', { retryable: true, retryAfterMs: Number(response.headers.get('retry-after') ?? 1) * 1000, status: 429 });
    if (response.status >= 500) throw new BrainError('BRAIN_UNAVAILABLE', 'Provider service unavailable', { retryable: true, status: response.status });
    if (!response.ok) throw new BrainError('BRAIN_REJECTED', 'Provider rejected the request', { status: response.status, details: await response.json().catch(() => null) });
    return response;
  }
  async getCatalog() {
    if (env.BRAIN_MODE !== 'mock') throw new BrainError('BRAIN_ADAPTER_UNAVAILABLE');
    const [fieldsResponse, operatorsResponse] = await Promise.all([
      this.request(`${this.baseUrl}/catalog/datafields`),
      this.request(`${this.baseUrl}/catalog/operators`)
    ]);
    const [fields, operators] = await Promise.all([fieldsResponse.json(), operatorsResponse.json()]);
    if (!Array.isArray(fields.items) || !Array.isArray(operators.items)) throw new BrainError('BRAIN_PROTOCOL_ERROR', 'Provider returned an invalid catalog');
    return { datafields: fields.items, operators: operators.items };
  }
  async runSimulation({ expression, settings, progressUrl, onSubmitted = () => {}, onProgress = () => {}, isCancelled = async () => false }) {
    if (env.BRAIN_MODE !== 'mock') throw new BrainError('BRAIN_ADAPTER_UNAVAILABLE');
    if (!progressUrl) {
      const created = await this.request(`${this.baseUrl}/simulations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression, settings }) });
      const location = created.headers.get('location');
      if (!location) throw new BrainError('BRAIN_PROTOCOL_ERROR', 'Mock provider did not return a progress URL');
      progressUrl = new URL(location, this.baseUrl).href;
      await onSubmitted(progressUrl);
    }
    const started = Date.now(); let done;
    while (Date.now() - started < env.BRAIN_MAX_WAIT_MS) {
      if (await isCancelled()) throw new BrainError('CANCELLED');
      const response = await this.request(progressUrl);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        onProgress();
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 30000)));
        continue;
      }
      done = await response.json(); break;
    }
    if (!done?.alpha) throw new BrainError('TIMEOUT', 'No result was returned before timeout');
    const [alphaRes, pnlRes] = await Promise.all([this.request(`${this.baseUrl}/alphas/${encodeURIComponent(done.alpha)}`), this.request(`${this.baseUrl}/alphas/${encodeURIComponent(done.alpha)}/recordsets/pnl`)]);
    const [alpha, pnl] = await Promise.all([alphaRes.json(), pnlRes.json()]);
    return { brainAlphaId: done.alpha, raw: { provider: 'local-mock', alpha, pnl }, result: normalizeBrainResult(alpha, pnl) };
  }
}

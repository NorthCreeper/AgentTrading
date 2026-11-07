// A registered, bounded delayed update. Learning changes predictions, never orders.
export const adaptiveProtocol = Object.freeze({
  version: 'p3-adaptive-calibration-v1',
  shape: 'sigmoid(logit(raw-up-midpoint)+b0+b1*clip(logit(raw-up-midpoint),-3,3))',
  initialParams: Object.freeze([0, 0]),
  learningRate: .02,
  decay: .005,
  logitFeatureLimit: 3,
  correctionBudget: .35,
  gradient: 'verified-y-minus-stored-forecast-q',
  updateOrder: 'available-unseen-labels-by-observedAt-then-slug',
  anchorMs: 120000,
  windowMs: 5000,
  staleMs: 3000,
  diagnosticOnly: true,
  changesTradingRules: false,
});

const finite = Number.isFinite;
const validProbability = p => finite(p) && p > 0 && p < 1;

function validateParams(params) {
  if (!Array.isArray(params) || params.length !== 2 || !params.every(finite) ||
      Math.abs(params[0]) + adaptiveProtocol.logitFeatureLimit * Math.abs(params[1]) >
        adaptiveProtocol.correctionBudget + 1e-12)
    throw Error('Invalid or unbounded adaptive parameters');
}

export function predictAdaptive(marketProbability, params = adaptiveProtocol.initialParams) {
  if (!validProbability(marketProbability)) throw Error('Invalid market probability');
  validateParams(params);
  const logit = Math.log(marketProbability) - Math.log1p(-marketProbability);
  const z = Math.max(-adaptiveProtocol.logitFeatureLimit, Math.min(adaptiveProtocol.logitFeatureLimit, logit));
  const adjusted = logit + params[0] + params[1] * z;
  const e = Math.exp(-Math.abs(adjusted));
  // Retain the exact market prior for the initial model, including its precision.
  const q = params[0] === 0 && params[1] === 0 ? marketProbability :
    adjusted >= 0 ? 1 / (1 + e) : e / (1 + e);
  if (!validProbability(q)) throw Error('Adaptive probability is outside representable bounds');
  return { q, z, marketProbability, params: [...params] };
}

export function updateAdaptive(params, { q, z, y } = {}) {
  validateParams(params);
  if (!validProbability(q) || !finite(z) || Math.abs(z) > adaptiveProtocol.logitFeatureLimit ||
      ![0, 1].includes(y)) throw Error('Invalid delayed adaptive label or forecast');
  const residual = y - q;
  const next = params.map((b, i) => b * (1 - adaptiveProtocol.decay) +
    adaptiveProtocol.learningRate * residual * (i === 0 ? 1 : z));
  const norm = Math.abs(next[0]) + adaptiveProtocol.logitFeatureLimit * Math.abs(next[1]);
  if (norm > adaptiveProtocol.correctionBudget) {
    const scale = adaptiveProtocol.correctionBudget / norm;
    return next.map(b => b * scale);
  }
  return next;
}

export { adaptiveProtocol as protocol, predictAdaptive as predict, updateAdaptive as update };

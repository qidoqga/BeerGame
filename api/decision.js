/**
 * BeerBot API endpoint (/api/decision)
 *
 * Deployment target: Vercel Functions (no framework)
 *
 * Deterministic, stateless: uses only request JSON (incl. weeks history).
 *
 * Algorithm: "BullwhipBreaker" (v1.0.0)
 * - Demand forecasting via simple exponential smoothing (SES)
 * - Inventory + supply-line (pipeline) adjustment (Sterman-style anchoring/adjustment)
 * - Mild order smoothing to damp oscillations
 */

const META = {
  student_email: "jolepl@taltech.ee",
  algorithm_name: "BullwhipBreaker",
  version: "v1.0.0",
  supports: { blackbox: true, glassbox: true },
};

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];

// Controller parameters tuned for stability; upstream reacts more slowly.
const PARAMS = {
  retailer:   { alphaF: 0.35, Ti: 2.8, Tp: 5.5, betaO: 0.35, safetyWeeks: 1.1, maxOrder: 250 },
  wholesaler: { alphaF: 0.28, Ti: 3.3, Tp: 6.5, betaO: 0.30, safetyWeeks: 1.2, maxOrder: 250 },
  distributor:{ alphaF: 0.24, Ti: 3.8, Tp: 7.5, betaO: 0.28, safetyWeeks: 1.25, maxOrder: 250 },
  factory:    { alphaF: 0.20, Ti: 4.4, Tp: 8.5, betaO: 0.25, safetyWeeks: 1.3, maxOrder: 300 },
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function toNonNegInt(x) {
  if (!Number.isFinite(x)) return 0;
  const v = Math.round(x);
  return v < 0 ? 0 : v;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function ses(series, alpha) {
  // Simple exponential smoothing, initialized with first observation.
  if (!series.length) return 0;
  let f = series[0];
  for (let i = 1; i < series.length; i++) {
    f = alpha * series[i] + (1 - alpha) * f;
  }
  return f;
}

function safeGet(obj, path, fallback = 0) {
  // path: array of keys
  let cur = obj;
  for (const k of path) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
    else return fallback;
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : fallback;
}

function parseJsonBody(req) {
  // Vercel may give req.body as object, string, or Buffer.
  const b = req.body;
  if (!b) return {};
  if (typeof b === "object" && !Buffer.isBuffer(b)) return b;
  try {
    const s = Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function roleHistory(weeks, role) {
  const inv = [];
  const back = [];
  const incOrd = [];
  const arrShip = [];
  const myOrders = [];

  for (const w of weeks) {
    inv.push(toNonNegInt(safeGet(w, ["roles", role, "inventory"], 0)));
    back.push(toNonNegInt(safeGet(w, ["roles", role, "backlog"], 0)));
    incOrd.push(toNonNegInt(safeGet(w, ["roles", role, "incoming_orders"], 0)));
    arrShip.push(toNonNegInt(safeGet(w, ["roles", role, "arriving_shipments"], 0)));
    myOrders.push(toNonNegInt(safeGet(w, ["orders", role], 0)));
  }

  return { inv, back, incOrd, arrShip, myOrders };
}

function estimatePipeline({ arrShip, myOrders }, forecast, defaultLead = 4) {
  // Deterministic proxy for outstanding orders (supply line).
  // Start with a reasonable initial pipeline (equilibrium assumption).
  let pipe = Math.max(0, Math.round(defaultLead * forecast));
  for (let i = 0; i < arrShip.length; i++) {
    const received = arrShip[i];
    const ordered = myOrders[i] ?? 0;
    pipe = Math.max(0, pipe - received) + ordered;
  }
  return pipe;
}

function chooseSharedDemandSeries(weeks) {
  // For glassbox: use retailer incoming_orders as end-customer demand proxy.
  const series = [];
  for (const w of weeks) {
    series.push(toNonNegInt(safeGet(w, ["roles", "retailer", "incoming_orders"], 0)));
  }
  return series;
}

function computeOrderForRole({
  role,
  weeks,
  mode,
  sharedDemandSeries,
}) {
  const p = PARAMS[role];
  const h = roleHistory(weeks, role);

  // Demand signal
  const demandSeries = (mode === "glassbox") ? sharedDemandSeries : h.incOrd;
  const forecast = ses(demandSeries, p.alphaF);

  // Variability estimate (recent window)
  const recent = demandSeries.slice(Math.max(0, demandSeries.length - 8));
  const sigma = stdev(recent);

  // Current state from last week snapshot
  const invNow = h.inv.at(-1) ?? 0;
  const backNow = h.back.at(-1) ?? 0;
  const IL = invNow - backNow; // inventory level (can be negative)

  // Pipeline estimate uses only this role's shipments + its own order history
  const pipe = estimatePipeline(h, forecast, 4);

  // Infer an "effective" lead time from pipeline / forecast (bounded)
  const effLead = clamp(
    Math.round(pipe / Math.max(1, forecast)),
    1,
    8
  );

  // Targets
  const safetyStock = Math.max(0, Math.round(p.safetyWeeks * forecast + 1.5 * sigma));
  const desiredIL = safetyStock;                 // desired on-hand minus backlog
  const desiredPipe = Math.round(forecast * effLead);

  // Sterman-style anchoring & adjustment + expected demand
  const orderRaw =
    forecast +
    (desiredIL - IL) / p.Ti +
    (desiredPipe - pipe) / p.Tp;

  // Mild order smoothing (reduces amplification)
  const prevOrder = h.myOrders.at(-1) ?? 0;
  const orderSmoothed = (1 - p.betaO) * prevOrder + p.betaO * orderRaw;

  // Final safeguards
  const capped = clamp(orderSmoothed, 0, p.maxOrder);
  return toNonNegInt(capped);
}

function computeOrders(body) {
  const mode = (body && body.mode === "glassbox") ? "glassbox" : "blackbox";
  const weeks = Array.isArray(body?.weeks) ? body.weeks : [];
  if (!weeks.length) {
    // Fallback (spec says simulator will default to 10 if we error; we avoid error)
    return { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 };
  }

  const sharedDemandSeries = chooseSharedDemandSeries(weeks);

  const orders = {};
  for (const role of ROLES) {
    orders[role] = computeOrderForRole({ role, weeks, mode, sharedDemandSeries });
  }
  return orders;
}

module.exports = async (req, res) => {
  // Always return 200 with JSON to satisfy simulator robustness expectations.
  try {
    const body = parseJsonBody(req);

    if (body && body.handshake === true) {
      return res
        .status(200)
        .setHeader("Content-Type", "application/json")
        .end(
          JSON.stringify({
            ok: true,
            student_email: META.student_email,
            algorithm_name: META.algorithm_name,
            version: META.version,
            supports: META.supports,
            message: "BeerBot ready",
            // Optional documentation fields
            uses_llm: false,
            student_comment:
              "SES forecast + inventory/pipeline adjustment + order smoothing (deterministic)",
          })
        );
    }

    const orders = computeOrders(body);

    return res
      .status(200)
      .setHeader("Content-Type", "application/json")
      .end(JSON.stringify({ orders }));
  } catch (e) {
    // Fail-safe: valid JSON with default orders
    return res
      .status(200)
      .setHeader("Content-Type", "application/json")
      .end(
        JSON.stringify({
          orders: { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 },
          error: "handled_exception",
        })
      );
  }
};

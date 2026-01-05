/**
 * BeerBot API endpoint (/api/decision) - Improved controller
 * Algorithm: BullwhipBreakerPro (v1.2.0)
 *
 * Upgrades vs v1.1.0:
 * - Backlog clearance term (controlled drain)
 * - Better pipeline initialization using arriving_shipments (startup stability)
 * - Adaptive safety + smoothing based on recent backlog/inventory pressure
 * - Glassbox: slightly lower safety (cleaner signal)
 */

const META = {
  student_email: "jolepl@taltech.ee",
  algorithm_name: "BullwhipBreakerPro",
  version: "v1.2.0",
  supports: { blackbox: true, glassbox: true },
};

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];

const PARAMS = {
  retailer: {
    L: 4,
    alphaBase: 0.58, alphaMin: 0.22, alphaMax: 0.90, alphaK: 0.35,
    smooth: 0.18,
    safetyWeeks: 1.05, z: 1.0,
    clearWeeks: 2.2,
    clipWindow: 0, clipK: 0,
    maxOrder: 400,
  },
  wholesaler: {
    L: 4,
    alphaBase: 0.42, alphaMin: 0.16, alphaMax: 0.80, alphaK: 0.28,
    smooth: 0.28,
    safetyWeeks: 1.10, z: 1.1,
    clearWeeks: 3.0,
    clipWindow: 6, clipK: 2.3,
    maxOrder: 420,
  },
  distributor: {
    L: 4,
    alphaBase: 0.35, alphaMin: 0.13, alphaMax: 0.75, alphaK: 0.24,
    smooth: 0.33,
    safetyWeeks: 1.15, z: 1.15,
    clearWeeks: 3.6,
    clipWindow: 6, clipK: 2.2,
    maxOrder: 450,
  },
  factory: {
    L: 4,
    alphaBase: 0.30, alphaMin: 0.11, alphaMax: 0.70, alphaK: 0.22,
    smooth: 0.38,
    safetyWeeks: 1.20, z: 1.2,
    clearWeeks: 4.2,
    clipWindow: 6, clipK: 2.1,
    maxOrder: 520,
  },
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function toNonNegInt(x) {
  if (!Number.isFinite(x)) return 0;
  const v = Math.round(x);
  return v < 0 ? 0 : v;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}
function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function mad(arr) {
  if (!arr.length) return 0;
  const m = median(arr);
  const dev = arr.map(x => Math.abs(x - m));
  return median(dev);
}

function clipSeriesRolling(series, window = 6, k = 2.2) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    const start = Math.max(0, i - window);
    const hist = out.slice(start, i);
    if (hist.length < 3) { out.push(x); continue; }
    const m = median(hist);
    const mdev = mad(hist);
    const scale = mdev > 0 ? 1.4826 * mdev : stdev(hist);
    const lo = m - k * scale;
    const hi = m + k * scale;
    out.push(clamp(x, lo, hi));
  }
  return out;
}

function adaptiveSES(series, p) {
  if (!series.length) return 0;
  let f = series[0];
  for (let i = 1; i < series.length; i++) {
    const x = series[i];
    const err = x - f;
    const scale = Math.abs(f) + 1;
    const alpha = clamp(
        p.alphaBase + p.alphaK * (Math.abs(err) / scale),
        p.alphaMin,
        p.alphaMax
    );
    f = f + alpha * err;
  }
  return f;
}

function safeGet(obj, path, fallback = 0) {
  let cur = obj;
  for (const k of path) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
    else return fallback;
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : fallback;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  const cleaned = (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
  if (!cleaned) return {};
  return JSON.parse(cleaned);
}

function roleHistory(weeks, role) {
  const inv = [], back = [], incOrd = [], arrShip = [], myOrders = [];
  for (const w of weeks) {
    inv.push(toNonNegInt(safeGet(w, ["roles", role, "inventory"], 0)));
    back.push(toNonNegInt(safeGet(w, ["roles", role, "backlog"], 0)));
    incOrd.push(toNonNegInt(safeGet(w, ["roles", role, "incoming_orders"], 0)));
    arrShip.push(toNonNegInt(safeGet(w, ["roles", role, "arriving_shipments"], 0)));
    myOrders.push(toNonNegInt(safeGet(w, ["orders", role], 0)));
  }
  return { inv, back, incOrd, arrShip, myOrders };
}

function estimatePipeline(arrShip, myOrders, initRate, L) {
  // Better startup: initialize pipeline near steady-state L*initRate (initRate from arriving_shipments)
  let pipe = Math.max(0, Math.round(L * Math.max(1, initRate)));
  for (let i = 0; i < arrShip.length; i++) {
    pipe = Math.max(0, pipe - arrShip[i]) + (myOrders[i] ?? 0);
  }
  return pipe;
}

function chooseSharedDemandSeries(weeks) {
  const series = [];
  for (const w of weeks) {
    series.push(toNonNegInt(safeGet(w, ["roles", "retailer", "incoming_orders"], 0)));
  }
  return series;
}

function computeOrderForRole({ role, weeks, mode, sharedDemandSeries }) {
  const p0 = PARAMS[role];
  const h = roleHistory(weeks, role);

  // Demand signal
  let demandSeries = (mode === "glassbox") ? sharedDemandSeries : h.incOrd;

  // Blackbox upstream clipping
  if (mode === "blackbox" && p0.clipWindow && role !== "retailer") {
    demandSeries = clipSeriesRolling(demandSeries, p0.clipWindow, p0.clipK);
  }

  // Forecast
  const forecast = adaptiveSES(demandSeries, p0);

  // Recent stats
  const recent = demandSeries.slice(Math.max(0, demandSeries.length - 8));
  const sigma = stdev(recent);

  const invNow = h.inv.at(-1) ?? 0;
  const backNow = h.back.at(-1) ?? 0;
  const IL = invNow - backNow;

  // Pressure-based adaptation (deterministic)
  const recentInv = h.inv.slice(Math.max(0, h.inv.length - 6));
  const recentBack = h.back.slice(Math.max(0, h.back.length - 6));
  const avgInv = mean(recentInv);
  const avgBack = mean(recentBack);
  const pressure = (avgBack + 1) / (avgInv + 1); // >1 => backlog-heavy

  // Glassbox can run leaner (cleaner demand info)
  const glassLean = (mode === "glassbox") ? -0.12 : 0.0;

  // Adapt safety & smoothing
  let safetyWeeks = p0.safetyWeeks + glassLean;
  let smooth = p0.smooth;

  if (pressure > 1.5) {        // backlog pain
    safetyWeeks += 0.18;
    smooth = Math.max(0.10, smooth - 0.08);
  } else if (pressure < 0.7) { // inventory bloat
    safetyWeeks -= 0.10;
    smooth = Math.min(0.55, smooth + 0.06);
  }
  safetyWeeks = clamp(safetyWeeks, 0.80, 1.60);

  // Pipeline estimate with better init rate (use first arriving_shipments if available)
  const initRate = (h.arrShip[0] ?? demandSeries[0] ?? forecast ?? 1);
  const pipe = estimatePipeline(h.arrShip, h.myOrders, initRate, p0.L);

  // Inventory position
  const IP = IL + pipe;

  // Safety stock
  const safety = Math.max(
      0,
      Math.round(safetyWeeks * forecast + p0.z * sigma * Math.sqrt(p0.L + 1))
  );

  // Target inventory position
  const targetIP = Math.round((p0.L + 1) * forecast + safety);

  // Base-stock order
  let raw = Math.max(0, targetIP - IP);

  // Controlled backlog drain (extra push to clear backlog faster)
  // NOTE: backlog already reduces IP via IL, this just speeds recovery.
  const drain = Math.round(backNow / Math.max(1.5, p0.clearWeeks));
  raw += clamp(drain, 0, Math.round(2.0 * Math.max(1, forecast)));

  // Smooth orders
  const prevOrder = h.myOrders.at(-1) ?? 0;
  let order = (1 - smooth) * raw + smooth * prevOrder;

  // Rate limits (asymmetric)
  const maxUp = Math.max(12, Math.round((backNow > 0 ? 7 : 4.5) * Math.max(1, forecast)));
  const maxDown = Math.max(12, Math.round(2.6 * Math.max(1, forecast)));
  order = clamp(order, prevOrder - maxDown, prevOrder + maxUp);

  order = clamp(order, 0, p0.maxOrder);
  return toNonNegInt(order);
}

function computeOrders(body) {
  const mode = (body && body.mode === "glassbox") ? "glassbox" : "blackbox";
  const weeks = Array.isArray(body?.weeks) ? body.weeks : [];
  if (!weeks.length) return { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 };

  const sharedDemandSeries = chooseSharedDemandSeries(weeks);

  const orders = {};
  for (const role of ROLES) {
    orders[role] = computeOrderForRole({ role, weeks, mode, sharedDemandSeries });
  }
  return orders;
}

module.exports = async (req, res) => {
  try {
    const body = await readJson(req);

    if (body && body.handshake === true) {
      return res
          .status(200)
          .setHeader("Content-Type", "application/json")
          .end(JSON.stringify({
            ok: true,
            student_email: META.student_email,
            algorithm_name: META.algorithm_name,
            version: META.version,
            supports: META.supports,
            message: "BeerBot ready",
            uses_llm: false,
            student_comment:
                "Base-stock (inventory position) + adaptive SES + backlog drain + adaptive safety/smoothing + upstream clipping",
          }));
    }

    const orders = computeOrders(body);
    return res
        .status(200)
        .setHeader("Content-Type", "application/json")
        .end(JSON.stringify({ orders }));
  } catch {
    return res
        .status(200)
        .setHeader("Content-Type", "application/json")
        .end(JSON.stringify({
          orders: { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 },
          error: "handled_exception",
        }));
  }
};

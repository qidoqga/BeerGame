/**
 * BeerBot API endpoint (/api/decision) - Improved controller
 * Algorithm: BullwhipBreakerPlus (v1.1.0)
 *
 * Key ideas:
 * - Order-up-to policy using Inventory Position (IL + pipeline)
 * - Adaptive exponential smoothing forecast
 * - Upstream demand clipping in blackbox mode to damp bullwhip
 * - Mild order smoothing + rate limiting
 */

const META = {
  student_email: "jolepl@taltech.ee",
  algorithm_name: "BullwhipBreakerPlus",
  version: "v1.1.0",
  supports: { blackbox: true, glassbox: true },
};

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];

// Parameters: tuned for stability (upstream reacts more slowly)
const PARAMS = {
  retailer: {
    L: 4,
    alphaBase: 0.55, alphaMin: 0.20, alphaMax: 0.85, alphaK: 0.35,
    smooth: 0.20,
    safetyWeeks: 1.10, z: 1.0,
    clipWindow: 0, clipK: 0,
    maxOrder: 350
  },
  wholesaler: {
    L: 4,
    alphaBase: 0.40, alphaMin: 0.15, alphaMax: 0.75, alphaK: 0.25,
    smooth: 0.30,
    safetyWeeks: 1.15, z: 1.1,
    clipWindow: 6, clipK: 2.3,
    maxOrder: 350
  },
  distributor: {
    L: 4,
    alphaBase: 0.33, alphaMin: 0.12, alphaMax: 0.70, alphaK: 0.22,
    smooth: 0.35,
    safetyWeeks: 1.20, z: 1.15,
    clipWindow: 6, clipK: 2.2,
    maxOrder: 380
  },
  factory: {
    L: 4,
    alphaBase: 0.28, alphaMin: 0.10, alphaMax: 0.65, alphaK: 0.20,
    smooth: 0.40,
    safetyWeeks: 1.25, z: 1.2,
    clipWindow: 6, clipK: 2.1,
    maxOrder: 420
  },
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
  // Deterministic robust clipping to avoid reacting to spikes
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    const start = Math.max(0, i - window);
    const hist = out.slice(start, i); // use already-clipped history
    if (hist.length < 3) {
      out.push(x);
      continue;
    }
    const m = median(hist);
    const mdev = mad(hist);
    // convert MAD to sigma-ish scale if possible
    const scale = mdev > 0 ? 1.4826 * mdev : stdev(hist);
    const lo = m - k * scale;
    const hi = m + k * scale;
    out.push(clamp(x, lo, hi));
  }
  return out;
}

function adaptiveSES(series, p) {
  // Adaptive exponential smoothing: alpha increases when error is large
  if (!series.length) return 0;
  let f = series[0];
  for (let i = 1; i < series.length; i++) {
    const x = series[i];
    const err = x - f;
    const scale = Math.abs(f) + 1; // avoid division by 0
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

function estimatePipeline(arrShip, myOrders, forecast, L) {
  // Outstanding orders proxy: start from equilibrium L*forecast, then update.
  let pipe = Math.max(0, Math.round(L * forecast));
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
  const p = PARAMS[role];
  const h = roleHistory(weeks, role);

  // Demand signal
  let demandSeries = (mode === "glassbox") ? sharedDemandSeries : h.incOrd;

  // Clip upstream demand in BLACKBOX to avoid reacting to spikes caused by downstream bullwhip
  if (mode === "blackbox" && p.clipWindow && role !== "retailer") {
    demandSeries = clipSeriesRolling(demandSeries, p.clipWindow, p.clipK);
  }

  const forecast = adaptiveSES(demandSeries, p);

  // recent variability
  const recent = demandSeries.slice(Math.max(0, demandSeries.length - 8));
  const sigma = stdev(recent);

  const invNow = h.inv.at(-1) ?? 0;
  const backNow = h.back.at(-1) ?? 0;
  const IL = invNow - backNow;

  const pipe = estimatePipeline(h.arrShip, h.myOrders, forecast, p.L);

  // Inventory position (key for base-stock policy)
  const IP = IL + pipe;

  // Safety stock (weeks of demand + variability buffer)
  const safety = Math.max(
      0,
      Math.round(p.safetyWeeks * forecast + p.z * sigma * Math.sqrt(p.L + 1))
  );

  // Target inventory position for order-up-to policy
  const targetIP = Math.round((p.L + 1) * forecast + safety);

  // Raw order suggestion
  const raw = Math.max(0, targetIP - IP);

  // Mild smoothing to reduce oscillation
  const prevOrder = h.myOrders.at(-1) ?? 0;
  let order = (1 - p.smooth) * raw + p.smooth * prevOrder;

  // Rate limit: allow faster ramp-up than ramp-down (helps avoid whiplash)
  const maxUp = Math.max(10, Math.round((backNow > 0 ? 6 : 4) * Math.max(1, forecast)));
  const maxDown = Math.max(10, Math.round(2.5 * Math.max(1, forecast)));
  order = clamp(order, prevOrder - maxDown, prevOrder + maxUp);

  // Final caps
  order = clamp(order, 0, p.maxOrder);
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
          .end(
              JSON.stringify({
                ok: true,
                student_email: META.student_email,
                algorithm_name: META.algorithm_name,
                version: META.version,
                supports: META.supports,
                message: "BeerBot ready",
                uses_llm: false,
                student_comment:
                    "Order-up-to (inventory position) + adaptive SES + upstream demand clipping + smoothing",
              })
          );
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
        .end(
            JSON.stringify({
              orders: { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 },
              error: "handled_exception",
            })
        );
  }
};

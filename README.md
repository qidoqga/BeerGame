# BeerBot – BullwhipBreaker (BeerBot API v1.2)

This repo contains a **single Vercel Function** at `POST /api/decision` that implements the BeerBot API.

## 1) Configure your identity

Open `api/decision.js` and change:

```js
student_email: "firstname.lastname@taltech.ee"
```

> The simulator validates that `student_email` ends with `@taltech.ee`.

## 2) Deploy to Vercel (recommended)

### Option A — GitHub import (easiest)

1. Create a new GitHub repo and upload these files.
2. Go to Vercel → **Add New → Project** → import the repo.
3. Deploy.

Your endpoint will be:

```
https://<your-project>.vercel.app/api/decision
```

### Option B — Vercel CLI

```bash
npm i -g vercel
vercel
```

## 3) Test from terminal

### Handshake

```bash
curl -X POST https://<your-url>/api/decision \
  -H "Content-Type: application/json" \
  -d '{"handshake":true,"ping":"hello","seed":2025}'
```

### Weekly step (example)

```bash
curl -X POST https://<your-url>/api/decision \
  -H "Content-Type: application/json" \
  -d '{
    "mode":"blackbox",
    "week":1,
    "weeks_total":36,
    "seed":2025,
    "weeks":[
      {"week":1,
       "roles":{
         "retailer":{"inventory":12,"backlog":0,"incoming_orders":14,"arriving_shipments":8},
         "wholesaler":{"inventory":20,"backlog":0,"incoming_orders":10,"arriving_shipments":12},
         "distributor":{"inventory":25,"backlog":0,"incoming_orders":8,"arriving_shipments":10},
         "factory":{"inventory":30,"backlog":0,"incoming_orders":12,"arriving_shipments":15}
       },
       "orders":{"retailer":10,"wholesaler":10,"distributor":10,"factory":10}
      }
    ]
  }'
```

## Algorithm summary

- **Demand forecast**: simple exponential smoothing (SES).
- **Inventory + pipeline adjustment**: stabilize by accounting for both on-hand and the inferred supply line.
- **Order smoothing**: mild damping to reduce oscillations.

All outputs are **non-negative integers**, deterministic, and designed to run comfortably under the 3-second limit.

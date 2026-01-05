# BeerBot "BullwhipBreaker" – Algorithm rationale (Decision Science)

## System view
The Beer Distribution Game is a delayed-feedback system: each role sees local inventory and backlog, while shipments and information arrive with lags. Small demand changes can therefore create large oscillations (bullwhip effect) when decision makers overreact to local shortages or ignore the supply line.

## Decision rule (high-level)
Each role places a weekly replenishment order using a deterministic control policy inspired by classic system-dynamics analyses of the beer game.

1. **Forecast demand** using *simple exponential smoothing* (SES) over the observed incoming order stream.
2. **Estimate the supply line (pipeline)**, i.e., outstanding orders not yet received, using the bot's own order history and the role's arriving shipments.
3. Compute an **anchoring-and-adjustment order**:
   - Replace expected demand (the forecast)
   - Correct inventory discrepancy (inventory minus backlog) gradually
   - Correct pipeline discrepancy (desired supply line vs estimated pipeline) gradually
4. Apply **mild order smoothing** (blend toward the new target order) to reduce oscillations.

The policy is fully reproducible because it uses only the request JSON (including the complete `weeks[]` history) and contains no random components.

## Why this reduces bullwhip
- System-dynamics work on the beer game shows that a stabilizing order rule should include **(a) expected demand**, **(b) inventory adjustment**, and **(c) supply-line (pipeline) adjustment**. Underweighting the supply line is a well-known driver of instability.
- Operations-management research on bullwhip highlights that **order-up-to / base-stock policies** and **order smoothing** can reduce variance amplification, especially when combined with better demand signals or information sharing.
- In *glassbox* mode the bot uses retailer (end-customer) demand as a shared signal for all roles, aligning decisions across the chain.

## Parameters (intuition)
Upstream roles react more slowly (smaller forecast alpha, larger adjustment time constants) because they are exposed to more volatile order streams.

## References (for your PDF)
- Sterman, J.D. (1989). *Misperceptions of Feedback in Dynamic Decision Making*. Management Science.
- Sterman, J.D. (1987/1989 working papers). MIT DSpace materials on the beer game decision rule.
- Dejonckheere, J., Disney, S.M., Lambrecht, M.R., Towill, D.R. (2004). *The impact of information enrichment on the bullwhip effect...* European Journal of Operational Research.
- Oliva, R., Goncalves, P. (2007). *Behavioral Causes of the Bullwhip Effect*.
- Lin, J. (2016). Survey/analysis of APIOBPCS family of inventory control systems.

---

## Code appendix
Copy/paste `api/decision.js` here for Moodle submission.

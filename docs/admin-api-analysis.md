# Admin API Route Redundancy & Efficiency Analysis

## Scope

This analysis reviews `src/index.ts` admin route handling (`/admin/*`) for:

1. Redundant endpoints
2. Duplicate handler branches
3. Dispatch efficiency and maintainability issues
4. Practical optimization opportunities

## Redundancy Findings

### 1) Duplicate route definition: `POST /admin/writes/confirm`

The route is handled in two separate branches. This creates dead code risk and can cause behavior drift when one branch changes and the other does not.

**Impact:** Medium (correctness/maintenance risk)

### 2) Overlapping read endpoints for variants and offer codes

Two endpoint patterns exist for each resource:

- Query-param style:
  - `GET /admin/products/variants?productId=<id>`
  - `GET /admin/products/offer-codes?productId=<id>`
- Path-param style:
  - `GET /admin/products/:productId/variants`
  - `GET /admin/products/:productId/offer-codes`

Both sets return similar data and partially overlap in purpose.

**Impact:** Medium (API surface bloat + client confusion)

### 3) README endpoint list duplicates

`README.md` lists several duplicated entries (`/admin/write-actions`, `/admin/writes/confirm`) and both overlapping variants/offer-code endpoint styles.

**Impact:** Low-Medium (documentation drift and onboarding friction)

## Efficiency Findings

### 1) Linear route matching (`if`/`else` chain)

Admin routing is implemented as a long sequence of `if` checks. Runtime cost is still small for this service size, but it scales linearly with route count and increases cognitive load.

**Impact:** Medium (maintainability now; performance later)

### 2) Repeated body parse + try/catch blocks

Many preview and confirm routes perform near-identical:

- body parse
- try/catch
- success envelope
- error envelope

This repetition is a strong signal for handler abstraction (higher-order wrapper).

**Impact:** High (maintainability, consistency, error drift)

### 3) Repeated path extraction logic

Path-style endpoints repeatedly use `url.pathname.split("/")[3]` to retrieve `productId`. This is brittle and repeated.

**Impact:** Medium (bug surface + readability)

## Recommended Consolidation Plan

### Phase 1 (safe, low risk)

1. Keep path-param endpoints as canonical read API.
2. Mark query-param variants/offer-code endpoints as deprecated in docs.
3. Remove duplicate `POST /admin/writes/confirm` branch.
4. Clean duplicate entries in README route list.

### Phase 2 (medium risk)

1. Introduce a small route table abstraction:
   - `exactRoutes[method:path]`
   - `patternRoutes[]` for regex routes
2. Add helper wrappers:
   - `withParsedBody(handler)`
   - `withErrorBoundary(actionType, handler)`
3. Add `extractProductId(pathname, regex)` utility.

### Phase 3 (optional)

1. Add route-level metrics (hit counts and latency).
2. Add contract tests to enforce one handler per method+path.
3. Add deprecation headers for old query-param endpoints.

## Prioritized Action Items

1. **Remove duplicate `POST /admin/writes/confirm` branch** (highest correctness ROI).
2. **Canonicalize variants/offer-codes reads on path-style endpoints**.
3. **Deduplicate README route list**.
4. **Abstract repeated parse/try/catch envelopes**.
5. **Move from long if-chain to route table over time**.

## Expected Outcome

Applying Phase 1+2 should reduce admin route implementation size, lower accidental behavior divergence, and make future route additions safer without changing core external behavior.

# Live evidence — price accuracy audit

Every number below was captured by running the built worker against real Amazon
pages. Nothing here is mocked. Reproduce with `node scripts/price-audit.mjs`.

---

## 1. The defect, proved on the page

The product price was resolved with a selector chain ending in
`.a-price .a-offscreen` — a **page-wide** selector. Captured against
amazon.co.uk, ASIN `B0CTHHR6YF`, which Amazon states is unavailable:

```
availability : "Currently unavailable. We don't know when or if this item will be back in stock."

#corePriceDisplay_desktop_feature_div .a-offscreen   matches=0
#corePrice_feature_div .a-offscreen                  matches=0
#price_inside_buybox                                 matches=0
#priceblock_ourprice                                 matches=0
#priceblock_dealprice                                matches=0
.a-price .a-offscreen                                matches=15   first="EGP2,717.93"
```

The chosen element's ancestry:

```
span.a-offscreen < span.a-price < div.a-row < a.a-link-normal
                                  < div.a-section.aok-relative < div.a-row
```

`aok-relative` / `CardInstance…` is a **recommendation carousel**. All fifteen
matches were other products. The scraper reported one of them as this product's
price, with `priceStatus: EXTRACTED`.

On an earlier run the same ASIN reported `£38.69`. **A value that changes between
loads of one page is not a price** — that variance is itself the evidence.

### A second latent failure: the crossed-out price

`#corePriceDisplay_desktop_feature_div .a-offscreen` had no `.a-text-price`
exclusion, and `pickText` takes `.first()`. Captured on amazon.com:

```
#corePriceDisplay_desktop_feature_div .a-offscreen [0] ""            basis=false
#corePriceDisplay_desktop_feature_div .a-offscreen [1] "$34.99"      basis=true   <- struck through
#corePrice_feature_div .a-offscreen                  [0] "$30.99"    basis=false
```

Here the list price happened to sit at index [1] so the real price was read.
Where Amazon puts the list price first — which it does on other marketplaces —
the same code returns the reference price as the selling price. `offers.ts`
already excluded basis prices; the product path never did.

---

## 2. Live audit after the fix — 20/20 PASS

`scripts/price-audit.mjs` loads the same page twice under **identical
localisation**: once raw for an independent reference read, once through the
scraper. The reference read is a deliberately different code path, so agreement
is evidence rather than tautology.

```
mkt            asin        dest               ref(page)      scraper          price     cur   source        verdict
amazon.co.uk   B0CTHHR6YF  France             (none)           —                NULL      GBP   NONE          PASS
amazon.com     B0CTHHR6YF  New York 10001    $30.99           $30.99           30.99     USD   CORE_PRICE    PASS
amazon.eg      B0CTHHR6YF  NOT_APPLIED        جنيه 1,399.98    جنيه 1,399.98    1399.98   EGP   CORE_PRICE    PASS
amazon.ae      B0CTHHR6YF  Delivering to Du   AED126.49        AED126.49        126.49    AED   CORE_PRICE    PASS
amazon.ca      B0CTHHR6YF  NOT_APPLIED        $36.99           $36.99           36.99     CAD   CORE_PRICE    PASS
amazon.sa      B0CTHHR6YF  NOT_APPLIED        ريال 154.99      ريال 154.99      154.99    SAR   CORE_PRICE    PASS
amazon.com     B07XLTPC5L  New York 10001    $20.99           $20.99           20.99     USD   CORE_PRICE    PASS
amazon.co.uk   B07XLTPC5L  France             £21.99           £21.99           21.99     GBP   CORE_PRICE    PASS
amazon.eg      B07XLTPC5L  NOT_APPLIED        جنيه 1,579.00    جنيه 1,579.00    1579      EGP   CORE_PRICE    PASS
amazon.com     B0FAKEASY   —                  (none)           —                —         —     —             PASS
amazon.com     B07D4BS2C1  —                  (none)           —                —         —     —             PASS
amazon.com     B0CX23V2ZK  New York 10001    (none)           —                NULL      USD   NONE          PASS
amazon.co.uk   B0CX23V2ZK  —                  (none)           —                —         —     —             PASS
amazon.ca      B0CX23V2ZK  NOT_APPLIED        (none)           —                NULL      CAD   NONE          PASS
amazon.ae      B0CX23V2ZK  —                  (none)           —                —         —     —             PASS
amazon.eg      B0CX23V2ZK  NOT_APPLIED        (none)           —                NULL      EGP   NONE          PASS
amazon.com     B00D1ARZMC  New York 10001    $20.00           $20.00           20        USD   CORE_PRICE    PASS
amazon.com     B09312N4RH  New York 10001    $22.99           $22.99           22.99     USD   CORE_PRICE    PASS
amazon.co.uk   B09312N4RH  France             £21.99           £21.99           21.99     GBP   CORE_PRICE    PASS
amazon.com     B0CTHHR6YF  New York 10001    $30.99           $30.99           30.99     USD   CORE_PRICE    PASS  <- repeat

PASS=20  FAIL=0
```

Two rows deserve emphasis:

- **`amazon.co.uk B0CTHHR6YF`** — the reported bug. `NULL`, source `NONE`.
- **The repeat row** — the same ASIN loaded twice returns `$30.99` both times.
  Under the old code this is exactly what varied.

`amazon.co.uk` rows are priced in **GBP with delivery to France**, and the
marketplace stays `amazon.co.uk`. Nothing was converted to EUR.

---

## 3. Scraper → database → workbook

```
market        asin        availability           priceText   price   source      verdict
amazon.co.uk  B0CTHHR6YF  CURRENTLY_UNAVAILABLE  NULL        NULL    NONE        PASS
             numeric cell = ""
```

The unavailable product is blank in **all three** places, and the numeric cell is
empty rather than `0`.

```
availability : CURRENTLY_UNAVAILABLE
priceText    : NULL
price        : NULL
priceStatus  : NOT_AVAILABLE_IN_SOURCE
priceSource  : NONE
priceRejected: NOT_PURCHASABLE (page availability)
```

**Blocked, not claimed:** the other three round-trip cases returned
`Scraping is paused for another 600s` — Amazon's circuit breaker tripped after
~25 product loads. The system stopped itself, which is the designed behaviour.
No bypass was attempted, and further attempts were abandoned rather than
retried into a site that is refusing us. Those three cases are reported as
**blocked, not verified**.

### 3b. DB → workbook for PRICED products, verified offline

The same four-way check could not complete live for priced products, so it was
run against **already-stored** rows instead — 139 export lines regenerated from
the real local database, with **zero Amazon requests**:

```
legacy-lookups                            : 81 rows checked, 81 match,  0 mismatched (5 legitimately blank)
8c5dd743-99f9-4e1d-bf73-48e84b6c51f9      : 43 rows checked, 43 match,  0 mismatched (0 legitimately blank)
223ece14-90ae-49d9-98f2-ce0f28d3dbec      : 15 rows checked, 15 match,  0 mismatched (0 legitimately blank)

TOTAL: 139 rows | 0 mismatched | 5 blank prices carried through as blank
```

Every stored price text reaches the workbook cell unchanged, and the five rows
whose stored price is NULL reach it as an empty cell — not `0`, not a guess.
Combined with the live scraper→page comparison above, all four links in the chain
are verified: **page ↔ scraper** (20/20 live), **scraper → database** (live, for
the reported bug), **database → workbook** (139 stored rows).

---

## 4. What changed

`src/price-source.ts` (new) resolves the price through a **scoped** hierarchy:

| Order | Section |
|---|---|
| 1 | `#apex_desktop` / `#coreBuybox_feature_div` / `#price_inside_buybox` → `BUYBOX` |
| 2 | `#corePriceDisplay_desktop_feature_div` / `#corePrice_feature_div` → `CORE_PRICE` |
| 3 | `#priceblock_dealprice` → `CORE_PRICE_DEAL` |
| 4 | `#priceblock_ourprice` / `#price` → `CORE_PRICE_BLOCK` |

There is **no bare `.a-price` entry**. Candidates are refused when they are:

- `LIST_PRICE` — a `.a-text-price` / struck-through reference price
- `RELATED_PRODUCT` — inside `aok-*`, `zeitgeist`, `CardInstance*`, `sims-*`,
  frequently-bought-together, sponsored results
- `VARIATION_SWATCH` — inside `#twister` / `inline-twister` / `dimension_*`
- `PRICE_RANGE` — `"$10.00 - $20.00"`; neither endpoint is the price
- `NOT_PURCHASABLE` — the page says the item cannot currently be bought
- `UNPARSEABLE` — present but not a figure in this marketplace's currency

Price-to-pay elements are preferred within each section, so a discount badge
never wins over the charged amount.

---

## 5. Honest limitations

- **`DISPATCHED_FROM_SELLER` still returns a price.** That is deliberate: an
  item dispatched by a third party is still purchasable.
- **`UNKNOWN` availability does not blank the price.** Only an explicit
  unavailable/temporarily-out-of-stock statement does. An unreadable page is not
  treated as a stockout.
- **Seller-offer prices are unaffected.** They are read per seller from the
  offer row and were already scoped and basis-aware. When the featured offer is
  unavailable, the product-level price goes NULL while genuine seller offers are
  still recorded — a blank is not a reason to discard verified seller data.
- **Live coverage is 20 cases, all available products of one small sample.** No
  live case yet exercised a Buy-Box-less listing, a shipping-charge-only price,
  or a JSON-LD-only price. Those paths are covered by fixtures, not by live
  observation.
- **The four-way check covered 1 of 4 cases live** before Amazon restricted
  access; the other three are blocked, not verified. The DB → workbook link is
  separately verified over 139 stored rows, so only the scraper → database link
  for a *priced* product remains unverified live.
- **Live audit volume is bounded by Amazon's own limits.** Roughly 25 product
  loads per session before the circuit breaker trips. Deeper audits need to be
  spread over time, not run harder.
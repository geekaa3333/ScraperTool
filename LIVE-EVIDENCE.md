# Live evidence — marketplace localisation, page messages, variations

Captured against real Amazon pages by running the built worker, not by mocking.
ASINs and prices below are quoted exactly as Amazon displayed them.

---

## Task 1 — amazon.co.uk researches FRANCE, still priced in GBP

```
RESULT UK | marketplace=amazon.co.uk/GBP | deliveryCountry=FR | price="£38.69" GBP [VERIFIED_FROM_PAGE]
        note=Serving GBP as configured. Delivering to France.
RESULT US | marketplace=amazon.com/USD  | deliveryCountry=US | price="$30.99" USD [VERIFIED_FROM_PAGE]
        note=Serving USD as configured. Delivering to New York 10001.
RESULT AE | marketplace=amazon.ae/AED   | deliveryCountry=AE | price="AED126.49" AED [VERIFIED_FROM_PAGE]
        note=Serving AED as configured. Delivering to Dubai.
```

Amazon's own header read **`Deliver to France`**. The marketplace stayed
`amazon.co.uk`, the country stayed GB, and the price stayed GBP. Nothing became
EUR.

Four defects were found by running this, none by reasoning:

1. **The postcode field alone does nothing on amazon.co.uk.** Entering `75001` is
   accepted by the control and then discarded — the header keeps reading the
   previous country. The modal ships `#GLUXCountryList` (France / Germany /
   Ireland) and selecting `FR` is what actually moves the destination.
2. **Selecting the country already applies it.** Amazon closes the modal ~3 s
   later, so the postcode is optional; it is now best-effort.
3. **The header is stale until the page reloads.** amazon.com read
   `Deliver to Egypt` immediately after a correct New York postcode, and
   `New York 10001` only after a reload. Verifying at the point of application
   reported working destinations as broken.
4. **The two glow lines swap roles by marketplace.** On amazon.co.uk line1 is the
   label and line2 the place; on amazon.ae line1 is the place and line2 is the
   button (`Update location`). Reading a fixed line reported a button as a
   destination.

---

## Task 2 — the real message, not a generic error

amazon.co.uk, ASIN `B0CTHHR6YF`:

```
pageState         : PRODUCT
availability      : CURRENTLY_UNAVAILABLE
availabilityMsg   : "Currently unavailable. We don't know when or if this item will be back in stock."
priceStatus       : EXTRACTED   priceText="£38.69" price=38.69
```

amazon.com, same ASIN:

```
availability      : LIMITED_AVAILABILITY
availabilityMsg   : "Only 7 left in stock - order soon. …"
```

amazon.eg, same ASIN (Arabic, not translated):

```
availability      : IN_STOCK
availabilityMsg   : "متوفر توصيل مجاني غداً، 16 أكتوبر (3) جديد من جنيه1,395.00…"
```

Three defects found by running it:

- **Inline scripts were read as product text.** Amazon inlines an AOD loader
  *inside* `#availability`, so the message came back containing JavaScript
  source. Scripts and styles are now removed before any text is read.
- **`غير متوفر في المخزون` (in stock) was classified as unavailable.** The
  unavailability rule matched the `غير متوفر` prefix of the in-stock phrase.
  Fixed with a negative lookbehind.
- **Product detection never fired.** The classifier string-matched CSS selectors
  (`#productTitle`) against raw HTML, which contains `id="productTitle"` — so it
  could never match and every real product page looked like an unknown page.

---

## Task 3 — variations, kept separate and bounded

ASIN `B07XLTPC5L` (Gildan), inspected on amazon.com:

```
parent price=$20.99   offers=2
variationNote="Availability/Price Depends on Color (partial: not every Color was inspected)"
complete=false
  - asin=B07XLTPC5L  Color=Navy/Charcoal/Cardinal Red              price="$20.99"
  - asin=B0GYG88965  Color=Black/Navy/Metro Blue/White/Niagara..   price="$22.99"
  - asin=B0GYG1YY94  Color=Black/Odyssey Grey/Bone/Cream/White..   price="$20.99"
  - asin=B077ZJXCTS  Color=Black/Sport Grey/Charcoal               price="$20.99"
```

Each variation carries its **own** child ASIN, its **own** price, and a label
taken from the swatch. "Depends on Color" is written only because the prices
genuinely differed — it is a conclusion drawn from observations, not a caption.

Three defects found by running it:

1. **The old twister selectors no longer match.** Amazon now renders an "inline
   twister": `#tp-inline-twister-dim-values-container` with the dimension in the
   ancestor `inline-twister-expander-content-<name>`. Discovery returned zero
   options against the old `#dimension_*` markup. The legacy selectors are kept
   as a fallback because both markups coexist.
2. **Variation snapshots recorded the PARENT's price.** After selecting a colour
   the worker re-fetched the parent URL, so four rows carried identical prices —
   making a real price-per-colour difference invisible while appearing verified.
   The child URL is now fetched whenever Amazon states a different ASIN.
3. **Colour labels were walls of CSS.** A colour swatch's `li` contains a price
   card, so `textContent` began with an inlined stylesheet. Labels now come from
   the swatch image's `alt`, with CSS-looking text rejected outright.

A **shared-mutable-default** bug was also found: `EMPTY` in `page-state.ts` was a
module constant whose `selectionTypes` array was shared by reference, so reading
one product that said "Select a size" left `Size` in the array and every later
product reported itself size-dependent. Callbacks classify pages in sequence, so
this silently contaminated real output.

---

## Task 4 — page state

```
NONEXISTENT ASIN -> pageState=NOT_FOUND
                   reason=Amazon answered HTTP 404 for this product page.
```

Classification is evidence-gated:

| Situation | Classified as |
|---|---|
| HTTP 404 | `NOT_FOUND` |
| Explicit "page could not be found" text | `NOT_FOUND` |
| Amazon's dog page | `AMAZON_ERROR_PAGE` — **never** `NOT_FOUND` |
| CAPTCHA / verification | `ACCESS_RESTRICTED` — checked **first** |
| Anything else | `UNKNOWN` |

A dog image on a healthy product page is still `PRODUCT`. A CAPTCHA is checked
before any absence rule, so a restricted page is never reported as a deleted
product. Only `AMAZON_ERROR_PAGE` and `UNKNOWN` are retried; a confirmed 404 is
not.

---

## Excel workbook, reopened and read

`sheets: All Seller Results — 62 columns (62 declared), 3 rows`

```
ASIN                         = "B0GYG88965"
Requested ASIN               = "B07XLTPC5L"
Selected / Observed ASIN     = "B0GYG88965"
Availability Status          = "UNKNOWN"
Shipping / Dispatch Message  = "This item is dispatched from Amazon.com directly to you."
Price Warning                = "Price higher than typical"
Buying Options Status        = "See all buying options"
Price Missing Reason         = "NOT_AVAILABLE_IN_SOURCE"
Page Status                  = "NOT_FOUND"
Page Message                 = "Amazon answered HTTP 404 for this product page."
Extraction Status            = "NOT_FOUND"
Selected Color               = "Black/Navy/Metro Blue"
Variation Note               = "Observed variation Color=Black/Navy/Metro Blue."
Variations Complete          = "NO"
```

Requested and observed ASIN are separate columns, so a child's price can never be
read as the parent's. Formula-injection protection still holds: a title of
`=cmd|calc!A1` is stored as the text `'=cmd|calc!A1`, not as a formula.

---

## Re-running this

`scripts/live-marketplace-evidence.mjs` captures the Task 1 localisation run.
The Task 2–4 runs used the same worker through `scrapeProduct`; each one costs a
handful of requests against real Amazon and honours the 4000 ms limiter. Nothing
here bypasses a restriction: when the circuit breaker trips, exploration stops
and partial coverage is recorded as partial.
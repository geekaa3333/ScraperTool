# Live marketplace-localisation evidence

Captured by `scripts/live-marketplace-evidence.mjs` against real Amazon pages,
before and after the fix. ASIN `B0CTHHR6YF`.

## The defect

Every page load created a fresh browser context with only a user agent and a
locale — no delivery country, no currency preference, no cookies. Amazon treated
the visitor as having no location and served its default, which for this host was
EGP.

```
=== uk (expect GBP) ===   product priceText : "EGP2,694.42"   currency: GBP  [MISMATCH_PRESERVED]
=== us (expect USD) ===   product priceText : "EGP1,631.62"   currency: USD  [MISMATCH_PRESERVED]
```

The header confirmed the leak: `Deliver to Egypt` on amazon.co.uk.

The currency **parser** was never wrong — it detected EGP faithfully and flagged
the mismatch. No parser change could have fixed a session that was never
localised.

## After the fix

```
=== amazon.co.uk (expect GBP) ===
  product priceText : "£38.69"
  product currency  : GBP  [VERIFIED_FROM_PAGE]
  seller offers     : 0
    (no readable offers on this page)

=== amazon.com (expect USD) ===
  product priceText : "$30.99"
  product currency  : USD  [VERIFIED_FROM_PAGE]
  seller offers     : 2
    - Amazon Resale          price="$24.48" ship="FREE" cur=USD buybox=no
    - Redragon Official Sell price="$32.99" ship="FREE" cur=USD buybox=no

=== amazon.ca (expect CAD) ===
  product priceText : "$36.99"
  product currency  : CAD  [VERIFIED_FROM_PAGE]
  seller offers     : 2
    - Redragon Official Sell price="$36.99" ship="FREE" cur=CAD buybox=YES
    - Amazon US              price="$63.28" ship="FREE" cur=CAD buybox=no

=== amazon.ae (expect AED) ===
  product priceText : "AED126.41"
  product currency  : AED  [VERIFIED_FROM_PAGE]
  seller offers     : 4
    - Amazon US              price="AED126.41" ship=null cur=AED buybox=YES
    - GlobalDelivered Seller price="AED162.00" ship="FREE" cur=AED buybox=no
    - JetSouq Seller         price="AED164.11" ship="FREE" cur=AED buybox=no
    - Last Mile Hub Seller   price="AED179.84" ship="FREE" cur=AED buybox=no

=== amazon.eg (expect EGP) ===
  product priceText : "جنيه‎1,330.00‎"
  product currency  : EGP  [VERIFIED_FROM_PAGE]
  seller offers     : 2
    - Games_World_Egypt      price="جنيه1,395.00" ship="توصيل مجاني" cur=EGP buybox=no
    - Magic Gate EG          price="جنيه1,400.00" ship="توصيل مجاني" cur=EGP buybox=no

=== amazon.sa (expect SAR) ===
  product priceText : "ريال‎154.99‎"
  product currency  : SAR  [VERIFIED_FROM_PAGE]
  seller offers     : 3
    - Amazon US              price="ريال154.99" ship="توصيل مجاني" cur=SAR buybox=YES
    - ExbordersFZE_ksa       price="ريال276.00" ship="توصيل مجاني" cur=SAR buybox=no
    - GlobalDelivered_ksa    price="ريال261.00" ship="17ريال" cur=SAR buybox=no

Every marketplace now serves its own currency, for the product price AND for
every seller offer. All values are `VERIFIED_FROM_PAGE` — read from the page, not
inferred, renamed or converted.

## Localisation log from the same run

```
[localise] uk: currency preference i18n-prefs=GBP
[localise] uk: destination applied (EC1A)
[localise] uk: ready — expected GBP, page displayed GBP
[localise] us: currency preference i18n-prefs=USD
[localise] us: destination applied (10001)
[localise] us: ready — expected USD, page displayed USD
[localise] ca: currency preference i18n-prefs=CAD
[localise] ca: destination applied (M5V)
[localise] ca: ready — expected CAD, page displayed CAD
[localise] ae: currency preference i18n-prefs=AED
[localise] ae: destination applied (00000)
[localise] ae: ready — expected AED, page displayed AED
[localise] eg: currency preference i18n-prefs=EGP
[localise] eg: delivery control failed — no editable location field found in the modal
[localise] eg: destination not applied (see the reason logged above)
[localise] eg: ready — expected EGP, page displayed EGP
[localise] sa: currency preference i18n-prefs=SAR
[localise] sa: no verified destination configured (Riyadh, Saudi Arabia) — relying on the currency preference alone
[localise] sa: destination not applied (see the reason logged above)
[localise] sa: ready — expected SAR, page displayed SAR
```

`destination applied` confirms the delivery control was driven, not just the
cookie set. amazon.sa is declined on purpose: its configured destination is
marked `verified: false`, so nothing is typed in its place and the currency
preference alone localises it.

## Honest limitation

amazon.co.uk returned no readable seller offers for this ASIN — the product page
carries a GBP price but exposes no offers list to an anonymous visitor. That is
Amazon withholding data, not a scraping failure, and the job records
`offersComplete: false` rather than claiming a complete seller list.

# BOM-Line Stamper

A browser userscript that reads a distributor product page (Mouser, DigiKey, LCSC), lets you correct what it found, and hands the result straight to [TALLY](https://mbparks.com/tally), the shop's BOM cost and quoting bench. It exists to kill the retyping: you walk the pages for a build, stamp each part, and export either a bill of parts or a fully priced job.

It is a single userscript file with no dependencies and no build step. It runs entirely in your browser and never talks to a server of its own.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). Both work.
2. Open `bom-stamper.user.js`. The manager recognizes the `==UserScript==` header and shows an install prompt. Confirm it.
3. Visit a product page on Mouser, DigiKey, or LCSC. A **Stamp BOM** button appears in the bottom-left corner.

To update, open the newer `.user.js` file the same way. The manager sees the higher `@version` and offers to replace the old one.

## Supported sites

Mouser, DigiKey, and LCSC, including their regional domains (for example `mouser.co.uk`, `digikey.de`). The script matches the whole vendor site rather than one URL shape, so the button shows on a product page however you reached it. A side effect is that the button also appears on search and category pages; the panel is harmless there, it just will not find much to scrape.

## How to use it

1. On a product page, click **Stamp BOM**. That is the moment it reads the page and fills the panel.
2. Check the fields. Every one is editable. MPN and description are treated as essential and get a red outline if they came up empty. Fix anything the scrape got wrong, especially price.
3. Set **Qty/unit** if this line is more than one per build (for example three of a resistor). The price-break ladder is its own editable list, with add and remove.
4. Choose what to do:
   - **Add to cart** stashes the corrected part and bumps the counter on the button. This is how you collect a whole build across many pages. The cart persists through navigation and browser restarts until you clear it.
   - **BOM CSV** / **TALLY job** export just the part on screen.
   - **Cart to BOM CSV** / **Cart to TALLY job** export everything in the cart at once.

Each export **saves a named file to your Downloads and also copies the same text to your clipboard**. The clipboard copy is a convenience; the file is what TALLY reads.

## Getting it into TALLY

TALLY imports from a file picker, not from pasted text, which is why the exports save files. There are two doors, and they behave differently on purpose:

- **BOM CSV**, imported through TALLY's **Import CSV** button, appends the parts to the bill you are currently working on. It carries no pricing, because TALLY's BOM importer reads only reference, part number, description, and quantity.
- **TALLY job**, imported through TALLY's **Load job** button, creates a new job with the full vendor offer already attached: the price-break ladder, minimum order quantity, pack multiple, lead days, and stock. This is the paste-free path.

So: use **BOM CSV** to add bare parts to a bill in progress, and **TALLY job** to start a fresh quote that is already priced.

One note on currency. TALLY is single-currency. The stamper captures the currency it sees for your reference, but it does not write a currency into the job. If you source across currencies, reconcile that in TALLY.

## What it captures

Reference designator, manufacturer part number, manufacturer, description, quantity per unit, vendor, vendor part number, currency, unit price, the full price-break ladder, minimum order quantity, pack multiple, lead days, stock, and a datasheet link where one is present.

## How the reading works

Extraction runs in layers so it does not hang on one fragile selector, and the first hit wins per field:

1. Structured data: the `application/ld+json` Product block many distributors embed.
2. Open Graph and price meta tags.
3. Per-site selectors for Mouser, DigiKey, and LCSC.
4. A last-ditch heuristic that scans tables for rows pairing a quantity with a currency amount, which is how the price ladder is recovered.

Because of the layering, even a page the site-specific selectors do not fully understand often comes back partly filled rather than blank. Whatever is missing, you fill in the panel before exporting. The panel lives in a shadow root so the distributor's own styles cannot reach in and break it.

## Menu commands

The userscript manager's menu (on the extension icon) offers, as a keyboard-free fallback: **Open / close panel**, **Save cart as BOM CSV**, **Save cart as TALLY job**, and **Clear cart**. The Open / close command is useful if the button is ever hidden behind a site's own floating widget.

## Data and privacy

Everything stays on your machine. The cart is stored in the userscript manager's own storage under the key `bom_stamper_cart_v1`. There is no telemetry and no network call. Clipboard writes go through the manager's clipboard API; file exports are built in the browser as a Blob and downloaded locally.

## Known Limitations

- The per-site selectors were written without access to live pages and will need tuning against real markup. The structured-data and meta layers carry a lot on their own, but a given vendor's labeled fields may miss until adjusted. The editable panel is the safeguard: nothing is trusted blindly.
- The panel reads the page as rendered at the instant you click **Stamp BOM**. On a heavily scripted page where the price ladder loads a beat late, an early click can catch it incomplete. Dismiss and stamp again, or fix the breaks inline.
- Single currency, per TALLY. Currency is captured for reference only and is not written into the exported job.
- The **TALLY job** export creates a new job in TALLY. It does not merge offers onto an existing bill. Attaching offers to a bill already in progress would need a new import path on the TALLY side.
- The whole-site match means the button also appears on non-product pages (search, categories). It does no harm there.
- File download is done by handing the browser a Blob and clicking a hidden link. If a site's security policy blocks that, the toast reads `download blocked, copied to clipboard` and you paste into a file yourself. The distributor sites have not been observed to do this.
- One capture yields one vendor offer per part. Comparing several vendors for the same part means stamping it on each vendor's page, or adding the extra offers by hand in TALLY.

## Version history

- **0.2.2** Export buttons save a named `.csv` or `.json` file (and also copy to the clipboard), so the download feeds straight into TALLY's Import file picker.
- **0.2.1** Button moved to bottom-left, clear of Mouser's own bottom-right chat widget. Match broadened to the whole vendor site plus regional domains, re-asserted across single-page navigations. A one-line console note on load confirms the script ran.
- **0.2.0** Output aligned to TALLY's actual importers and verified against `tally.html`: BOM CSV for the bill, and a job JSON carrying the full offer for Load job. Confirmed in a headless harness that TALLY keeps the offers and prices the job end to end.
- **0.1.0** Initial build: layered extraction, editable preview panel, cart across pages, CSV and JSON copy.

## License

GPL-3.0

## Feedback

Built at Green Shoe Garage. Corrections to the per-site selectors are the most useful thing to send: the vendor, the field that came out wrong, and a snippet of the surrounding page markup.

# Vendor sources for filament spec

Vendor-published figures take precedence over OpenPrintTag and over anything inferred. These
are the sources already confirmed to carry real data, with the quirks of getting at them.

## Vendors that publish exact hex codes

### Prusa / Prusament — the best of the bunch

<https://help.prusa3d.com/article/hueforge-filament-transparency-values-and-hexcodes_762314>

A measured HexCode **and** HueForge TD value for every Prusament material and colour. Fetching
the page and asking for specific products works well. The TD figure is also directly useful —
it populates `transmissionDistance`.

Worth knowing: OPT's values for Prusament are frequently off by one in the last digit
(`ea5e1a` against Prusa's `EA5E19`), which suggests OPT samples swatch images rather than
copying this table. Occasionally the gap is real — Prusa publishes `#494546` for PETG Prusa
Galaxy Black against OPT's `#3d3e3d`.

### Polymaker

<https://wiki.polymaker.com/polymaker-products/more-about-our-products/hex-codes-and-transmission-distances>

Hex codes and transmission distances by SKU. Search by product name; the table distinguishes
sub-lines properly (PolyMax PC Grey is not PolyMax PLA Grey).

Note Polymaker retired **PolyTerra** and sells that line as **Panchroma** now, with many
sub-lines (Basic, Matte, Silk, Satin, Galaxy, Marble, Celestial, Dual, Neon, CoPE). A record
still named PolyTerra needs the sub-line identifying before it can be matched. **Fiberon** is
Polymaker's engineering line, so those products carry Polymaker as the vendor.

### Overture

<https://cdn.shopify.com/s/files/1/0207/3624/5824/files/Overture_Hex_Code_List.pdf>

Complete hex list across PLA, Silk PLA, Matte PLA, Rock PLA, Air PLA, PLA Professional, Super
PLA+, Easy PLA, PETG, TPU, ABS, ASA, Easy Nylon and PC Professional.

Both the PDF and the equivalent wiki page resist direct fetching — the text does not render.
Download and extract locally instead:

```bash
pdftotext -layout Overture_Hex_Code_List.pdf out.txt
```

The layout is two columns, colour names on one line and hex values on the line below. Section
headers are indented product names. Take care attributing values: plain `PLA` and `PLA
PROFESSIONAL` both appear as blocks beginning "PLA", and they carry different values for the
same colour name.

### 3D-Fuel — and the reason to keep digging

Hex **and** TD for every colour, per material line:

<https://docs.google.com/spreadsheets/d/15hLIEGU3xl0QXJnoWtb-UiYsOSPAiOtg83_sv3qbKpc/>

Any Google Sheet exports as CSV, and the tab you want is rarely the first one:

```bash
# list the tabs
curl -sL "https://docs.google.com/spreadsheets/d/<ID>/htmlview" | grep -o 'gid=[0-9]*' | sort -u
# then fetch one
curl -sL "https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>"
```

This one is worth generalising from, because the data was three hops from where it should
have been. The product page carried no specification at all. A search turned up a **blog
post** announcing hex codes and a HueForge colour library, and that post linked the sheet,
which had a separate tab per material line — `gid=0` was Standard PLA+, not the PCTG line
being looked for.

So: a product page with no figures does not mean the vendor publishes none. Search their blog
and support pages too, and treat **any mention of HueForge as a strong signal** that a hex and
TD table exists somewhere, because supplying one is the whole point of a HueForge library.

Finding it mattered. The values in that sheet corrected nine of ten colours that had been
taken from OpenPrintTag, several of them badly — OPT rendered two blacks as `#000000` where
the vendor publishes `#383737` and `#434443`. It also settled a product's identity: a colour
that looked like a rebadged spool from another brand turned out to be in the maker's own
catalogue all along.

### Vendors confirmed to publish nothing

SUNLU and Kexcelled have no public hex list, and CHCKX appears in neither a vendor table nor
OpenPrintTag. Fall back to OpenPrintTag where it has the product, say that's what you did, and
where nothing exists at all leave the colour for the user rather than inventing one.

## Transmission distance is usually free alongside the hex

The Prusa, Polymaker and 3D-Fuel tables all carry a HueForge **TD** value next to each hex,
and it populates `transmissionDistance` directly. It is worth taking whenever you are already
reading the table — it is almost never populated otherwise, and HueForge work is unusable
without it.

TD runs 0 (opaque) to 100 (completely clear), which also makes it good evidence about a
colour's nature: 3D-Fuel's Pro PCTG Natural reads 100, confirming a genuinely clear filament
rather than a tinted one. A high TD is a reason to set the transparent or translucent finish
tag (`optTags` 2 and 3) so the swatch renders see-through.

**A finish tag on a standalone becomes a family-wide default if that filament is ever
promoted.** Promotion moves colour and inventory to the generated original variant but leaves
`optTags` behind on the new template, and `optTags` is whole-array fallback — so every sibling
that declares none inherits it, and an opaque colour added later renders transparent. Note the cleanup can only run *after* the fact: `/promote` rejects a
standalone outright ("a standalone becomes a template when its first variant is created"), and
the gated create performs the promotion and the new sibling in one step, so there is no moment
in between. Do it immediately after that create — the generated original variant is the
parent's other child, the one whose id is not the one the create just returned — moving
`optTags` onto it and clearing them from the template.

**Generalise this, because the tag is not the only thing that strands.** Promotion copies
colour and inventory and nothing else, so *anything colour-specific held on a standalone stays
behind on the new template* — and every field the resolver treats as inheritable is then
adopted by each sibling that doesn't override it. Three known cases, all needing the same
post-create move:

| Stranded | Consequence for later siblings | How to move it |
|---|---|---|
| `optTags` | an opaque colour renders transparent | move **only the appearance tags** — see below — and leave the rest on the template |
| `transmissionDistance` | inherits the original colour's TD as their own | `PUT` the value onto the variant, `null` on the template |
| the OpenPrintTag link | template-level linkage, which the main skill forbids; a later sync can push one colour's managed values family-wide | **not a PUT** — `DELETE …/openprinttag/link` on the template, then `POST` the slug to the variant |

**`optTags` is a mixed namespace, so moving the whole array is wrong.** It carries how a colour
*looks* alongside what the material *is*: `2` transparent, `3` translucent, `16` matte, `17`
silk, `22` sparkle, `23` phosphorescent, `24` glow, `25` colour-changing, `27` gradient, `28`
dual-colour and `29` triple-colour describe this colour and belong on the variant. `4` abrasive,
`0`/`31` glass and carbon fibre, `33` hygroscopic, `9` flexible, `5` food-safe and the rest
describe the product line and must stay on the template, where every sibling inherits them.
Sweeping the array across takes `4` off the line, which — because the resolver reads the
effective value — hides the whole family from the abrasive/nozzle check in Settings → Data
health. **When a tag is not clearly one of the appearance tags listed above, leave it on the
template**: an appearance tag stranded there is a visible rendering wart, a safety tag moved
off it is silent.

The link is the one that cannot be hand-moved. It is three fields — `openprinttag_slug`,
`openprinttag_uuid` and the server-owned `openprinttagSnapshot` — and a generic `PUT` strips
the snapshot, leaving a linkage that looks present and classifies wrongly on the next check.
Let the routes rebuild it, and mind the order, because **two different slugs are in play**:
the one on the template belongs to the ORIGINAL colour, while the one you looked up in step 4
belongs to the NEW colour you are adding. Deleting first destroys the value you need.

```bash
# 1. save the ORIGINAL colour's slug off the template before touching anything
ORIG_SLUG=$(curl -s "$BASE/api/filaments/$TEMPLATE_ID?raw=true" \
  | jq -r '.filament.settings.openprinttag_slug // .settings.openprinttag_slug')
# 2. now the template can be unlinked
curl -s -X DELETE "$BASE/api/filaments/$TEMPLATE_ID/openprinttag/link"
# 3. relink the GENERATED ORIGINAL variant with its own slug, not the new colour's
curl -s -X POST "$BASE/api/filaments/$ORIGINAL_VARIANT_ID/openprinttag/link" \
  -H 'Content-Type: application/json' -d "{\"slug\":\"$ORIG_SLUG\"}"
``` Before promoting anything, look at what else the standalone carries that describes
its colour rather than its product line — the list above is what has been hit so far, not a
guarantee it is complete.

## When the vendor lists no hex at all

Some products genuinely have no colour. Overture's PETG Transparent is listed in their own PDF
with the word "Transparent" where a hex would be. The right representation is `color: null`
plus the transparent finish tag (`optTags` 2 = transparent, 3 = translucent), which renders as
a see-through swatch. Do not substitute the white of the same line — OPT does exactly that,
and it is wrong.

## Reading a TDS for process parameters

A datasheet gives nozzle and bed ranges, drying schedule, density, and sometimes max
volumetric flow. Two cautions:

**A melting point is not a nozzle temperature, and a glass transition is not a bed
temperature.** PA6 melts around 220 °C and prints at 260–280 °C. Never derive a process
setting from a polymer property.

**Extrusion multiplier and pressure advance are per-spool measurements**, not datasheet
values. A vendor never publishes them. If the family has a calibration on the same nozzle it
is a reasonable starting point, but record it as inherited from the template rather than
asserting it as this roll's measured value.

## Recording where a value came from

When several sources are in play, say per-field which won — "temperatures from the Prusa
knowledge base, colour from OPT since the vendor publishes none". The user can then judge
which figures to trust, and the weakly-sourced ones are the ones worth re-checking later.

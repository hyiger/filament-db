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

### Vendors confirmed to publish nothing

SUNLU and Kexcelled have no public hex list. Fall back to OpenPrintTag for those and say
that's what you did — the sourcing is weaker and the user should know which values rest on it.

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

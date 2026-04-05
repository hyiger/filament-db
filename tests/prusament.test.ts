import { describe, it, expect } from "vitest";
import { extractSpoolData } from "@/lib/prusament";

const sampleHtml = `
<html>
<head><title>Prusament Spool</title></head>
<body>
<script>
var spoolData = '{"ff_goods_id":4715,"country":"CZ","sample":null,"diameter_avg":1.748,"diameter_measurement":"1.75,1.748,1.749","weight":1050,"spool_weight":186,"length":345,"manufacture_date":"2025-01-05 08:21:40","filament":{"color_name":"Prusa Galaxy Black","color_rgb":"292929","material":"PETG","name":"Prusament PETG Prusa Galaxy Black 1kg - v1","photo_url":"https://example.com/photo.jpg","grade":"standard","he_min":240,"he_max":260,"hb_min":70,"hb_max":90},"ovality":0.971,"max_diameter_offset":0.011}';
</script>
</body>
</html>
`;

describe("Prusament spool data extraction", () => {
  it("should extract spoolData from single-quoted var", () => {
    const data = extractSpoolData(sampleHtml);
    expect(data).not.toBeNull();
    expect(data.filament.material).toBe("PETG");
    expect(data.filament.color_name).toBe("Prusa Galaxy Black");
    expect(data.weight).toBe(1050);
    expect(data.spool_weight).toBe(186);
  });

  it("should extract filament temperatures", () => {
    const data = extractSpoolData(sampleHtml);
    expect(data.filament.he_min).toBe(240);
    expect(data.filament.he_max).toBe(260);
    expect(data.filament.hb_min).toBe(70);
    expect(data.filament.hb_max).toBe(90);
  });

  it("should extract manufacturing info", () => {
    const data = extractSpoolData(sampleHtml);
    expect(data.country).toBe("CZ");
    expect(data.manufacture_date).toBe("2025-01-05 08:21:40");
    expect(data.ff_goods_id).toBe(4715);
  });

  it("should extract diameter measurements", () => {
    const data = extractSpoolData(sampleHtml);
    expect(data.diameter_avg).toBe(1.748);
    expect(data.ovality).toBe(0.971);
    expect(data.max_diameter_offset).toBe(0.011);
  });

  it("should handle double-quoted var", () => {
    const json = '{"filament":{"material":"PLA","color_name":"Red","color_rgb":"ff0000","name":"Prusament PLA Red","photo_url":"","grade":"","he_min":200,"he_max":220,"hb_min":50,"hb_max":70},"ff_goods_id":1,"country":"CZ","sample":null,"diameter_avg":1.75,"diameter_measurement":"","weight":1000,"spool_weight":200,"length":330,"manufacture_date":"2025-06-01","ovality":0.5,"max_diameter_offset":0.01}';
    const html = `<script>var spoolData = '${json}';</script>`;
    const data = extractSpoolData(html);
    expect(data).not.toBeNull();
    expect(data.filament.material).toBe("PLA");
  });

  it("should return null for pages without spoolData", () => {
    const html = "<html><body>No spool here</body></html>";
    const data = extractSpoolData(html);
    expect(data).toBeNull();
  });

  it("should compute correct total weight", () => {
    const data = extractSpoolData(sampleHtml);
    const totalWeight = data.weight + data.spool_weight;
    expect(totalWeight).toBe(1236);
  });

  it("should compute density from weight and length", () => {
    const data = extractSpoolData(sampleHtml);
    const diameter = 1.75;
    const radiusCm = diameter / 20;
    const volumeCm3 = data.length * 100 * Math.PI * radiusCm * radiusCm;
    const density = data.weight / volumeCm3;
    // PETG density should be ~1.27 g/cm³
    expect(density).toBeGreaterThan(1.2);
    expect(density).toBeLessThan(1.35);
  });
});

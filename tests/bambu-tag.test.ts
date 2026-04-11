import { describe, it, expect } from "vitest";
import { deriveBambuKeys, parseBambuBlocks, bambuToDecodedTag } from "../electron/bambu-tag";

describe("Bambu Tag Decoder", () => {
  describe("deriveBambuKeys", () => {
    it("derives 16 keys of 6 bytes each from a UID", () => {
      const uid = Buffer.from("AABBCCDD", "hex");
      const keys = deriveBambuKeys(uid);

      expect(keys).toHaveLength(16);
      keys.forEach((key) => expect(key).toHaveLength(6));
    });

    it("produces deterministic keys for a known UID", () => {
      const uid = Buffer.from("AABBCCDD", "hex");
      const keys = deriveBambuKeys(uid);

      // Verified against Node.js crypto.hkdfSync reference output
      expect(keys[0].toString("hex").toUpperCase()).toBe("C792D1FE6973");
      expect(keys[1].toString("hex").toUpperCase()).toBe("CEDCEAE708EE");
      expect(keys[15].toString("hex").toUpperCase()).toBe("CD804F289176");
    });

    it("produces different keys for different UIDs", () => {
      const keys1 = deriveBambuKeys(Buffer.from("AABBCCDD", "hex"));
      const keys2 = deriveBambuKeys(Buffer.from("11223344", "hex"));

      expect(keys1[0].toString("hex")).not.toBe(keys2[0].toString("hex"));
    });
  });

  describe("parseBambuBlocks", () => {
    function makeBlocks(): (Buffer | undefined)[] {
      const blocks: (Buffer | undefined)[] = [];
      for (let i = 0; i < 40; i++) blocks[i] = Buffer.alloc(16);
      return blocks;
    }

    it("parses material variant and ID from block 1", () => {
      const blocks = makeBlocks();
      blocks[1] = Buffer.alloc(16);
      blocks[1]!.write("A50-K0", 0, "ascii");
      blocks[1]!.write("GFA50", 8, "ascii");

      const data = parseBambuBlocks(blocks);
      expect(data.materialVariantId).toBe("A50-K0");
      expect(data.materialId).toBe("GFA50");
    });

    it("parses filament type from block 2", () => {
      const blocks = makeBlocks();
      blocks[2] = Buffer.alloc(16);
      blocks[2]!.write("PLA Basic", 0, "ascii");

      const data = parseBambuBlocks(blocks);
      expect(data.filamentType).toBe("PLA Basic");
    });

    it("parses detailed filament type from block 4", () => {
      const blocks = makeBlocks();
      blocks[4] = Buffer.alloc(16);
      blocks[4]!.write("PLA Matte", 0, "ascii");

      const data = parseBambuBlocks(blocks);
      expect(data.detailedFilamentType).toBe("PLA Matte");
    });

    it("parses color RGBA from block 5", () => {
      const blocks = makeBlocks();
      blocks[5] = Buffer.alloc(16);
      blocks[5]![0] = 0xff;
      blocks[5]![1] = 0x00;
      blocks[5]![2] = 0x00;
      blocks[5]![3] = 0xff;

      const data = parseBambuBlocks(blocks);
      expect(data.colorRGBA).toEqual([0xff, 0x00, 0x00, 0xff]);
    });

    it("parses spool weight as uint16 LE from block 5", () => {
      const blocks = makeBlocks();
      blocks[5] = Buffer.alloc(16);
      blocks[5]!.writeUInt16LE(1000, 4); // 0xE8 0x03

      const data = parseBambuBlocks(blocks);
      expect(data.spoolWeight).toBe(1000);
    });

    it("parses filament diameter as float32 LE from block 5", () => {
      const blocks = makeBlocks();
      blocks[5] = Buffer.alloc(16);
      blocks[5]!.writeFloatLE(1.75, 8);

      const data = parseBambuBlocks(blocks);
      expect(data.filamentDiameter).toBeCloseTo(1.75, 2);
    });

    it("parses temperatures from block 6", () => {
      const blocks = makeBlocks();
      blocks[6] = Buffer.alloc(16);
      blocks[6]!.writeUInt16LE(55, 0);  // drying temp
      blocks[6]!.writeUInt16LE(8, 2);   // drying time (hours)
      blocks[6]!.writeUInt16LE(1, 4);   // bed temp type
      blocks[6]!.writeUInt16LE(60, 6);  // bed temp
      blocks[6]!.writeUInt16LE(220, 8); // max hotend
      blocks[6]!.writeUInt16LE(190, 10);// min hotend

      const data = parseBambuBlocks(blocks);
      expect(data.dryingTemp).toBe(55);
      expect(data.dryingTime).toBe(8);
      expect(data.bedTempType).toBe(1);
      expect(data.bedTemp).toBe(60);
      expect(data.maxHotendTemp).toBe(220);
      expect(data.minHotendTemp).toBe(190);
    });

    it("parses tray UID from block 9", () => {
      const blocks = makeBlocks();
      blocks[9] = Buffer.alloc(16);
      blocks[9]!.write("TRAY12345678", 0, "ascii");

      const data = parseBambuBlocks(blocks);
      expect(data.trayUid).toBe("TRAY12345678");
    });

    it("parses spool width from block 10", () => {
      const blocks = makeBlocks();
      blocks[10] = Buffer.alloc(16);
      blocks[10]!.writeUInt16LE(6625, 4); // 66.25mm

      const data = parseBambuBlocks(blocks);
      expect(data.spoolWidth).toBeCloseTo(66.25, 2);
    });

    it("parses production date from block 12", () => {
      const blocks = makeBlocks();
      blocks[12] = Buffer.alloc(16);
      blocks[12]!.write("2024_11_15_08_30", 0, "ascii");

      const data = parseBambuBlocks(blocks);
      expect(data.productionDate).toBe("2024_11_15_08_30");
    });

    it("parses filament length from block 14", () => {
      const blocks = makeBlocks();
      blocks[14] = Buffer.alloc(16);
      blocks[14]!.writeUInt16LE(330, 4); // 330 meters

      const data = parseBambuBlocks(blocks);
      expect(data.filamentLength).toBe(330);
    });

    it("parses second color when format ID is 0x0002 and count >= 2", () => {
      const blocks = makeBlocks();
      blocks[16] = Buffer.alloc(16);
      blocks[16]!.writeUInt16LE(0x0002, 0);
      blocks[16]!.writeUInt16LE(2, 2);
      blocks[16]![4] = 0x00;
      blocks[16]![5] = 0xff;
      blocks[16]![6] = 0x00;
      blocks[16]![7] = 0xff;

      const data = parseBambuBlocks(blocks);
      expect(data.colorCount).toBe(2);
      expect(data.secondColorRGBA).toEqual([0x00, 0xff, 0x00, 0xff]);
    });

    it("returns null second color when format ID is 0", () => {
      const blocks = makeBlocks();
      const data = parseBambuBlocks(blocks);
      expect(data.secondColorRGBA).toBeNull();
    });

    it("handles missing blocks gracefully", () => {
      const blocks: (Buffer | undefined)[] = [];
      const data = parseBambuBlocks(blocks);

      expect(data.materialVariantId).toBe("");
      expect(data.filamentType).toBe("");
      expect(data.spoolWeight).toBe(0);
      expect(data.colorRGBA).toEqual([0, 0, 0, 0]);
    });
  });

  describe("bambuToDecodedTag", () => {
    function makeBambuData() {
      return parseBambuBlocks(buildFullBlocks());
    }

    function buildFullBlocks(): (Buffer | undefined)[] {
      const blocks: (Buffer | undefined)[] = [];
      for (let i = 0; i < 40; i++) blocks[i] = Buffer.alloc(16);

      blocks[1]!.write("A50-K0", 0, "ascii");
      blocks[1]!.write("GFA50", 8, "ascii");
      blocks[2]!.write("PLA Basic", 0, "ascii");
      blocks[4]!.write("PLA Matte", 0, "ascii");

      // Color: red
      blocks[5]![0] = 0xff; blocks[5]![1] = 0x00; blocks[5]![2] = 0x00; blocks[5]![3] = 0xff;
      blocks[5]!.writeUInt16LE(1000, 4);
      blocks[5]!.writeFloatLE(1.75, 8);

      blocks[6]!.writeUInt16LE(55, 0);   // drying temp
      blocks[6]!.writeUInt16LE(4, 2);    // drying time hours
      blocks[6]!.writeUInt16LE(1, 4);    // bed temp type
      blocks[6]!.writeUInt16LE(60, 6);   // bed temp
      blocks[6]!.writeUInt16LE(220, 8);  // max hotend
      blocks[6]!.writeUInt16LE(190, 10); // min hotend

      blocks[9]!.write("TRAY00ABC", 0, "ascii");
      blocks[12]!.write("2024_11_15_08_30", 0, "ascii");
      blocks[14]!.writeUInt16LE(330, 4);

      return blocks;
    }

    it("sets tagSource to bambu", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.tagSource).toBe("bambu");
    });

    it("sets brandName to Bambu Lab", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.brandName).toBe("Bambu Lab");
    });

    it("uses detailed filament type as materialName when available", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.materialName).toBe("PLA Matte");
    });

    it("falls back to filament type when detailed is empty", () => {
      const blocks = buildFullBlocks();
      blocks[4] = Buffer.alloc(16); // clear detailed type
      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.materialName).toBe("PLA Basic");
    });

    it("extracts material type from filament type prefix", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.materialType).toBe("PLA");
    });

    it("maps PETG filament type correctly", () => {
      const blocks = buildFullBlocks();
      blocks[2] = Buffer.alloc(16);
      blocks[2]!.write("PETG HF", 0, "ascii");
      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.materialType).toBe("PETG");
    });

    it("maps TPU filament type correctly", () => {
      const blocks = buildFullBlocks();
      blocks[2] = Buffer.alloc(16);
      blocks[2]!.write("TPU 95A", 0, "ascii");
      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.materialType).toBe("TPU");
    });

    it("maps PA6-CF to PA", () => {
      const blocks = buildFullBlocks();
      blocks[2] = Buffer.alloc(16);
      blocks[2]!.write("PA6-CF", 0, "ascii");
      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.materialType).toBe("PA");
    });

    it("falls back to raw string for unknown material types", () => {
      const blocks = buildFullBlocks();
      blocks[2] = Buffer.alloc(16);
      blocks[2]!.write("EXOTIC Blend", 0, "ascii");
      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.materialType).toBe("EXOTIC");
    });

    it("converts color RGBA to hex (dropping alpha)", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.color).toBe("#ff0000");
    });

    it("maps temperature fields", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.nozzleTemp).toBe(220);
      expect(result.nozzleTempMin).toBe(190);
      expect(result.bedTemp).toBe(60);
    });

    it("converts drying time from hours to minutes", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.dryingTime).toBe(240); // 4 hours × 60
    });

    it("maps weight, diameter, and other fields", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.weightGrams).toBe(1000);
      expect(result.diameter).toBeCloseTo(1.75, 2);
      expect(result.dryingTemperature).toBe(55);
      expect(result.spoolUid).toBe("TRAY00ABC");
      expect(result.materialAbbreviation).toBe("A50-K0");
    });

    it("maps Bambu-specific fields", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.productionDate).toBe("2024_11_15_08_30");
      expect(result.filamentLength).toBe(330);
    });

    it("omits zero values as undefined", () => {
      const blocks: (Buffer | undefined)[] = [];
      for (let i = 0; i < 40; i++) blocks[i] = Buffer.alloc(16);
      blocks[2]!.write("PLA Basic", 0, "ascii");

      const result = bambuToDecodedTag(parseBambuBlocks(blocks));
      expect(result.nozzleTemp).toBeUndefined();
      expect(result.bedTemp).toBeUndefined();
      expect(result.weightGrams).toBeUndefined();
      expect(result.dryingTemperature).toBeUndefined();
      expect(result.dryingTime).toBeUndefined();
      expect(result.filamentLength).toBeUndefined();
    });

    it("sets meta and main to empty objects", () => {
      const result = bambuToDecodedTag(makeBambuData());
      expect(result.meta).toEqual({});
      expect(result.main).toEqual({});
    });
  });
});

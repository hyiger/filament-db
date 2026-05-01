// Re-export from shared package — single source of truth
export {
  OPT_KEY,
  MATERIAL_CLASS,
  MATERIAL_TYPE,
  OPT_TAG,
  OPT_TAG_TO_NAME,
  encodeCBORUint,
  encodeCBORFloat16,
  encodeCBORFloat32,
  encodeCBORCompactNumber,
  decodeCBORFloat16,
  encodeCBORText,
  encodeCBORBytes,
  encodeCBORKey,
  parseHexColor,
  resolveMaterialType,
  deriveMaterialAbbreviation,
  generateOpenPrintTagBinary,
} from "@filament-db/shared/openprinttag/encoder";

export type { OpenPrintTagInput } from "@filament-db/shared/openprinttag/encoder";

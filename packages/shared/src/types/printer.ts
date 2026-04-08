import type { NozzleDetail } from "./nozzle";

/** Printer type definition (platform-agnostic, no Mongoose dependency) */
export interface PrinterDetail {
  _id: string;
  name: string;
  syncId?: string | null;
  manufacturer: string;
  printerModel: string;
  installedNozzles: NozzleDetail[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

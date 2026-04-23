/** Nozzle type definition (platform-agnostic, no Mongoose dependency) */
export interface NozzleDetail {
  _id: string;
  name: string;
  syncId?: string | null;
  diameter: number;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

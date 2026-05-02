/**
 * Atlas App Services data layer.
 *
 * Provides typed CRUD operations against MongoDB Atlas directly from the mobile app.
 * Uses the Realm Web SDK's MongoDB client for data access.
 *
 * All queries automatically filter soft-deleted documents (_deletedAt: null).
 */

import Realm from "realm";
import type { FilamentSummary, FilamentDetail } from "@filament-db/shared/types/filament";
import type { NozzleDetail } from "@filament-db/shared/types/nozzle";
import type { PrinterDetail } from "@filament-db/shared/types/printer";
import { resolveFilament } from "@filament-db/shared/logic/resolveFilament";
import { sanitizeFields } from "@filament-db/shared/logic/validation";

// Default database name — matches the existing web/desktop app
const DB_NAME = "filament-db";

/** Permissive doc shape for the Realm MongoDB driver. The Realm SDK
 * defaults `collection()` to bson `Document<unknown>`, which only
 * exposes `_id` and strips every other field. We don't model schemas
 * here — every read converts to a typed shape from @filament-db/shared
 * before being returned — so the loose index signature below is the
 * smallest change that lets the call sites compile. `_id` is required
 * to satisfy the bson Document constraint. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AtlasDoc = { [key: string]: any; _id: Realm.BSON.ObjectId };

/** Convert a string ID to a BSON ObjectId for Atlas queries. */
function oid(id: string): Realm.BSON.ObjectId {
  return new Realm.BSON.ObjectId(id);
}

class AtlasService {
  private app: Realm.App | null = null;
  private _db: Realm.Services.MongoDBDatabase | null = null;

  private get db() {
    if (!this._db) throw new Error("Not connected to Atlas. Call connect() first.");
    return this._db;
  }

  /** Typed access to a collection — narrows the default `Document<unknown>`
   * generic so reads and writes can use the AtlasDoc fields. */
  private col(name: string) {
    return this.db.collection<AtlasDoc>(name);
  }

  /**
   * Connect to Atlas App Services with an API key.
   * Must be called before any data operations.
   */
  async connect(appId: string, apiKey: string): Promise<void> {
    this.app = new Realm.App({ id: appId });
    const credentials = Realm.Credentials.apiKey(apiKey);
    await this.app.logIn(credentials);
    const mongo = this.app.currentUser!.mongoClient("mongodb-atlas");
    this._db = mongo.db(DB_NAME);
  }

  /** Disconnect and clear state. */
  disconnect(): void {
    if (this.app?.currentUser) {
      this.app.currentUser.logOut();
    }
    this.app = null;
    this._db = null;
  }

  get isConnected(): boolean {
    return this._db !== null && this.app?.currentUser !== null;
  }

  // ── Filaments ──────────────────────────────────────────────────────

  filaments = {
    list: async (filter?: { type?: string; vendor?: string; search?: string }): Promise<FilamentSummary[]> => {
      const query: Record<string, unknown> = { _deletedAt: null };
      if (filter?.type) query.type = filter.type;
      if (filter?.vendor) query.vendor = filter.vendor;
      if (filter?.search) {
        query.name = { $regex: filter.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      }

      const docs = await this.col("filaments").find(query, {
        sort: { vendor: 1, name: 1 },
        projection: {
          name: 1, vendor: 1, type: 1, color: 1, cost: 1, density: 1,
          parentId: 1, spools: 1, spoolWeight: 1, netFilamentWeight: 1,
          totalWeight: 1, "temperatures.nozzle": 1, "temperatures.bed": 1,
        },
      });

      return docs as unknown as FilamentSummary[];
    },

    get: async (id: string): Promise<FilamentDetail> => {
      const doc = await this.col("filaments").findOne({
        _id: oid(id),
        _deletedAt: null,
      });
      if (!doc) throw new Error(`Filament not found: ${id}`);

      // Resolve inheritance if this is a variant
      let resolved = doc;
      if (doc.parentId) {
        const parent = await this.col("filaments").findOne({
          _id: doc.parentId,
          _deletedAt: null,
        });
        if (parent) {
          resolved = resolveFilament(
            doc as Record<string, unknown>,
            parent as Record<string, unknown>,
          ) as unknown as AtlasDoc;
        }
      }

      // Populate compatible nozzles
      if (resolved.compatibleNozzles?.length) {
        const nozzleIds = resolved.compatibleNozzles.map((n: unknown) =>
          typeof n === "string" ? oid(n) : n
        );
        const nozzles = await this.col("nozzles").find({
          _id: { $in: nozzleIds },
          _deletedAt: null,
        });
        resolved.compatibleNozzles = nozzles;
      }

      // Populate calibration nozzles and printers
      if (resolved.calibrations?.length) {
        for (const cal of resolved.calibrations) {
          if (cal.nozzle) {
            const nozzle = await this.col("nozzles").findOne({
              _id: typeof cal.nozzle === "string" ? oid(cal.nozzle) : cal.nozzle,
            });
            if (nozzle) cal.nozzle = nozzle;
          }
          if (cal.printer) {
            const printer = await this.col("printers").findOne({
              _id: typeof cal.printer === "string" ? oid(cal.printer) : cal.printer,
            });
            if (printer) cal.printer = printer;
          }
        }
      }

      // Fetch variants if this is a parent
      if (!doc.parentId) {
        const variants = await this.col("filaments").find(
          { parentId: doc._id, _deletedAt: null },
          { projection: { name: 1, color: 1, cost: 1 } },
        );
        if (variants.length > 0) {
          resolved._variants = variants;
        }
      }

      return resolved as unknown as FilamentDetail;
    },

    create: async (data: Partial<FilamentDetail>): Promise<FilamentDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      const result = await this.col("filaments").insertOne({
        ...clean,
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return this.filaments.get(result.insertedId.toString());
    },

    update: async (id: string, data: Partial<FilamentDetail>): Promise<FilamentDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      await this.col("filaments").updateOne(
        { _id: oid(id) },
        { $set: { ...clean, updatedAt: new Date() } },
      );
      return this.filaments.get(id);
    },

    delete: async (id: string): Promise<void> => {
      // Check for variants
      const variantCount = await this.col("filaments").count({
        parentId: oid(id),
        _deletedAt: null,
      });
      if (variantCount > 0) {
        throw new Error(`Cannot delete: filament has ${variantCount} variant(s)`);
      }
      await this.col("filaments").updateOne(
        { _id: oid(id) },
        { $set: { _deletedAt: new Date() } },
      );
    },

    vendors: async (): Promise<string[]> => {
      const docs = (await this.col("filaments").aggregate([
        { $match: { _deletedAt: null } },
        { $group: { _id: "$vendor" } },
        { $sort: { _id: 1 } },
      ])) as { _id: string }[];
      return docs.map((d) => d._id).filter(Boolean);
    },

    types: async (): Promise<string[]> => {
      const docs = (await this.col("filaments").aggregate([
        { $match: { _deletedAt: null } },
        { $group: { _id: "$type" } },
        { $sort: { _id: 1 } },
      ])) as { _id: string }[];
      return docs.map((d) => d._id).filter(Boolean);
    },
  };

  // ── Spools ─────────────────────────────────────────────────────────

  spools = {
    add: async (filamentId: string, data: { label: string; totalWeight?: number | null }): Promise<void> => {
      await this.col("filaments").updateOne(
        { _id: oid(filamentId) },
        {
          $push: {
            spools: {
              _id: new Realm.BSON.ObjectId(),
              label: data.label,
              totalWeight: data.totalWeight ?? null,
              createdAt: new Date(),
            },
          },
          $set: { updatedAt: new Date() },
        },
      );
    },

    update: async (filamentId: string, spoolId: string, data: { label?: string; totalWeight?: number }): Promise<void> => {
      const setFields: Record<string, unknown> = { updatedAt: new Date() };
      if (data.label !== undefined) setFields["spools.$.label"] = data.label;
      if (data.totalWeight !== undefined) setFields["spools.$.totalWeight"] = data.totalWeight;

      await this.col("filaments").updateOne(
        { _id: oid(filamentId), "spools._id": oid(spoolId) },
        { $set: setFields },
      );
    },

    delete: async (filamentId: string, spoolId: string): Promise<void> => {
      await this.col("filaments").updateOne(
        { _id: oid(filamentId) },
        {
          $pull: { spools: { _id: oid(spoolId) } },
          $set: { updatedAt: new Date() },
        },
      );
    },
  };

  // ── Nozzles ────────────────────────────────────────────────────────

  nozzles = {
    list: async (filter?: { diameter?: number; type?: string }): Promise<NozzleDetail[]> => {
      const query: Record<string, unknown> = { _deletedAt: null };
      if (filter?.diameter) query.diameter = filter.diameter;
      if (filter?.type) query.type = filter.type;

      const docs = await this.col("nozzles").find(query, {
        sort: { diameter: 1, type: 1 },
      });
      return docs as unknown as NozzleDetail[];
    },

    get: async (id: string): Promise<NozzleDetail> => {
      const doc = await this.col("nozzles").findOne({
        _id: oid(id),
        _deletedAt: null,
      });
      if (!doc) throw new Error(`Nozzle not found: ${id}`);
      return doc as unknown as NozzleDetail;
    },

    create: async (data: Partial<NozzleDetail>): Promise<NozzleDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      const result = await this.col("nozzles").insertOne({
        ...clean,
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return this.nozzles.get(result.insertedId.toString());
    },

    update: async (id: string, data: Partial<NozzleDetail>): Promise<NozzleDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      await this.col("nozzles").updateOne(
        { _id: oid(id) },
        { $set: { ...clean, updatedAt: new Date() } },
      );
      return this.nozzles.get(id);
    },

    delete: async (id: string): Promise<void> => {
      // Referential integrity check
      const filamentRef = await this.col("filaments").count({
        _deletedAt: null,
        $or: [
          { compatibleNozzles: oid(id) },
          { "calibrations.nozzle": oid(id) },
        ],
      });
      if (filamentRef > 0) {
        throw new Error(`Cannot delete: nozzle is referenced by ${filamentRef} filament(s)`);
      }

      const printerRef = await this.col("printers").count({
        _deletedAt: null,
        installedNozzles: oid(id),
      });
      if (printerRef > 0) {
        throw new Error(`Cannot delete: nozzle is installed in ${printerRef} printer(s)`);
      }

      await this.col("nozzles").updateOne(
        { _id: oid(id) },
        { $set: { _deletedAt: new Date() } },
      );
    },
  };

  // ── Printers ───────────────────────────────────────────────────────

  printers = {
    list: async (filter?: { manufacturer?: string }): Promise<PrinterDetail[]> => {
      const query: Record<string, unknown> = { _deletedAt: null };
      if (filter?.manufacturer) query.manufacturer = filter.manufacturer;

      const docs = await this.col("printers").find(query, {
        sort: { manufacturer: 1, name: 1 },
      });

      // Populate installed nozzles
      for (const doc of docs) {
        if (doc.installedNozzles?.length) {
          const nozzles = await this.col("nozzles").find({
            _id: { $in: doc.installedNozzles },
            _deletedAt: null,
          });
          doc.installedNozzles = nozzles;
        }
      }

      return docs as unknown as PrinterDetail[];
    },

    get: async (id: string): Promise<PrinterDetail> => {
      const doc = await this.col("printers").findOne({
        _id: oid(id),
        _deletedAt: null,
      });
      if (!doc) throw new Error(`Printer not found: ${id}`);

      // Populate installed nozzles
      if (doc.installedNozzles?.length) {
        const nozzles = await this.col("nozzles").find({
          _id: { $in: doc.installedNozzles },
          _deletedAt: null,
        });
        doc.installedNozzles = nozzles;
      }

      return doc as unknown as PrinterDetail;
    },

    create: async (data: Partial<PrinterDetail>): Promise<PrinterDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      const result = await this.col("printers").insertOne({
        ...clean,
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return this.printers.get(result.insertedId.toString());
    },

    update: async (id: string, data: Partial<PrinterDetail>): Promise<PrinterDetail> => {
      const clean = sanitizeFields(data as Record<string, unknown>);
      await this.col("printers").updateOne(
        { _id: oid(id) },
        { $set: { ...clean, updatedAt: new Date() } },
      );
      return this.printers.get(id);
    },

    delete: async (id: string): Promise<void> => {
      // Referential integrity check
      const filamentRef = await this.col("filaments").count({
        _deletedAt: null,
        "calibrations.printer": oid(id),
      });
      if (filamentRef > 0) {
        throw new Error(`Cannot delete: printer is referenced by ${filamentRef} filament(s)`);
      }

      await this.col("printers").updateOne(
        { _id: oid(id) },
        { $set: { _deletedAt: new Date() } },
      );
    },
  };
}

/** Singleton Atlas service instance */
export const atlasService = new AtlasService();

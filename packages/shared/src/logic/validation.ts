/**
 * Shared validation and sanitization logic — platform-agnostic.
 *
 * Extracted from API routes for reuse in the mobile app.
 */

/** Fields that must be stripped before create/update operations */
const INTERNAL_FIELDS = [
  "_id",
  "_deletedAt",
  "createdAt",
  "updatedAt",
  "__v",
  "instanceId",
  "syncId",
];

/**
 * Strip internal fields from a document before create/update.
 * Returns a new object with internal fields removed.
 */
export function sanitizeFields<T extends Record<string, unknown>>(data: T): Partial<T> {
  const result = { ...data };
  for (const field of INTERNAL_FIELDS) {
    delete result[field];
  }
  return result;
}

/**
 * Validate that a parent assignment is valid.
 * Returns an error message if invalid, null if OK.
 */
export function validateParentAssignment(
  parentId: string | null | undefined,
  filamentId: string | null | undefined,
  parentHasParent: boolean,
): string | null {
  if (!parentId) return null;

  if (parentId === filamentId) {
    return "A filament cannot be its own parent";
  }

  if (parentHasParent) {
    return "Cannot use a variant as a parent (no nested inheritance)";
  }

  return null;
}

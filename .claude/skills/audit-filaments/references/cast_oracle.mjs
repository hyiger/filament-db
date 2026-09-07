/**
 * Ground truth for every cast the audit MIRRORS.
 *
 * `audit.py` reimplements Mongoose's cast/validate semantics in Python so that
 * it can run standalone against any deployment, with no repo checkout and no
 * node_modules. That portability is the point -- and it is also the whole
 * defect class this file exists to close: a hand-written mirror can silently
 * diverge from the thing it mirrors, and every such divergence is either a
 * FALSE POSITIVE (the audit tells the user to "fix" data the app stores and
 * casts happily) or an under-report.
 *
 * So the mirror stays, and this becomes the reference implementation it is
 * tested against. `selftest.py` generates a corpus, asks this script for the
 * real verdicts, and fails the suite on ANY disagreement. That converts
 * "the mirror might be wrong" from something a reviewer has to notice into a
 * build failure -- which is the only form of it that stays fixed.
 *
 * Usage:  node cast_oracle.mjs < batch.json > verdicts.json
 *   in :  [{"type":"String|Number|Date|ObjectId|Boolean","value":<any>,
 *           "opts":{"max":10080}}, ...]
 *   out:  [{"ok":true,"cast":<cast value>} | {"ok":false,"error":"..."} , ...]
 *
 * `value` may be wrapped as {"__undefined":true} to distinguish an absent key
 * from an explicit null, which JSON cannot otherwise express.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// the repo root is four levels up from .claude/skills/audit-filaments/references
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));

let mongoose;
try {
  mongoose = require('mongoose');
} catch {
  process.stdout.write(JSON.stringify({ unavailable: 'mongoose not resolvable' }));
  process.exit(0);
}

const TYPES = {
  String: String,
  Number: Number,
  Date: Date,
  Boolean: Boolean,
  ObjectId: mongoose.Schema.Types.ObjectId,
};

const batch = JSON.parse(readFileSync(0, 'utf8'));
const out = [];
let n = 0;

for (const item of batch) {
  const type = TYPES[item.type];
  if (!type) { out.push({ ok: false, error: `unknown type ${item.type}` }); continue; }
  const def = Object.assign({ type }, item.opts || {});
  let verdict;
  try {
    // A fresh model per item: a schema is immutable once compiled, and reusing
    // one would let a previous cast's state leak into the next verdict.
    const M = mongoose.model('O' + (n++), new mongoose.Schema({ v: def }));
    const value = (item.value && typeof item.value === 'object'
                   && item.value.__undefined) ? undefined : item.value;
    const doc = new M(value === undefined ? {} : { v: value });
    const err = doc.validateSync();
    verdict = err
      ? { ok: false, error: String(err.errors?.v?.message ?? err.message).slice(0, 200) }
      : { ok: true, cast: doc.v === undefined ? null : JSON.parse(JSON.stringify(doc.v ?? null)) };
  } catch (e) {
    // A cast that THROWS is still a rejection from the audit's point of view:
    // the restore fails either way.
    verdict = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
  out.push(verdict);
}

process.stdout.write(JSON.stringify({ mongoose: mongoose.version, verdicts: out }));

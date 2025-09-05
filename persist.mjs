/**
 * Build a parameterized INSERT for a root object using a whitelist of dot paths.
 *
 * @param {any} root
 * @param {string} table
 * @param {string[]} paths               Dot paths to extract (whitelist)
 * @param {{
 *   alias?: Record<string, string>,     // dotPath -> column name
 *   transform?: Record<string, (val:any, root:any) => any>, // optional value transforms
 *   extras?: Record<string, any>        // extra static columns to include
 * }} [opts]
 * @returns {{ sql: string, values: any[] }}
 */
export function buildInsertFromObject(root, table, paths, { alias = {}, transform = {}, extras = {} } = {}) {
  const qid = (id) => `\`${String(id).replace(/`/g, "``")}\``;

  const get = (obj, path) =>
    path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), obj);

  const toDb = (v) => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  };

  const cols = [];
  const qms = [];
  const vals = [];

  for (const p of paths) {
    let val = get(root, p);
    if (transform[p]) {
      try { val = transform[p](val, root); } catch { /* ignore */ }
    }
    cols.push(qid(alias[p] || p.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "")));
    qms.push("?");
    vals.push(toDb(val));
  }

  // add extra static columns (not from the object)
  for (const [k, v] of Object.entries(extras)) {
    cols.push(qid(k));
    qms.push("?");
    vals.push(toDb(v));
  }

  const sql = `INSERT INTO ${qid(table)} (${cols.join(", ")}) VALUES (${qms.join(", ")});`;
  return { sql, values: vals };
}

/**
 * Attach `.toInsertRow()` and `.save()` to any endpoint class.
 *
 * @template T
 * @param {T} Klass                           Class (e.g. returned by makeEndpointClass)
 * @param {{
 *   table: string,
 *   whitelist: string[],
 *   alias?: Record<string, string>,
 *   transform?: Record<string, (val:any, root:any) => any>,
 *   extras?: Record<string, any>,
 * }} cfg
 * @returns {T}                               Same class, for chaining/exports
 *
 * @example
 * attachPersistence(AdImpressionClient, {
 *   table: "site_ad_impressions",
 *   whitelist: ["url", "lastStatus", "headers.User-Agent"],
 * });
 */
export function attachPersistence(Klass, cfg) {
  // Keep config on the class for reference / overrides later
  Object.defineProperty(Klass, "persistence", {
    value: { ...cfg },
    writable: false,
    enumerable: false,
  });

  /**
   * Build an INSERT for this instance. You can override table/whitelist/etc. at call time.
   * @param {{ table?: string, whitelist?: string[], alias?: Object, transform?: Object, extras?: Object }} [opts]
   * @returns {{ sql: string, values: any[] }}
   */
  Klass.prototype.toInsertRow = function toInsertRow(opts = {}) {
    const conf = { ...Klass.persistence, ...opts };
    if (!conf.table) throw new Error(`${Klass.name}.toInsertRow: table is required`);
    if (!Array.isArray(conf.whitelist) || conf.whitelist.length === 0) {
      throw new Error(`${Klass.name}.toInsertRow: non-empty whitelist is required`);
    }
    return buildInsertFromObject(this, conf.table, conf.whitelist, {
      alias: conf.alias || {},
      transform: conf.transform || {},
      extras: conf.extras || {},
    });
  };

  /**
   * Save this instance via mysql2/promise `.execute()` (or pool.execute()).
   * @param {import("mysql2/promise").Connection|import("mysql2/promise").Pool} connection
   * @param {{ table?: string, whitelist?: string[], alias?: Object, transform?: Object, extras?: Object }} [opts]
   * @returns {Promise<import("mysql2/promise").ResultSetHeader>}
   */
  Klass.prototype.save = async function save(connection, opts) {
    if (!connection || typeof connection.execute !== "function") {
      throw new Error(`${Klass.name}.save: a mysql2/promise connection or pool with .execute() is required`);
    }
    const { sql, values } = this.toInsertRow(opts);
    const [result] = await connection.execute(sql, values);
    return result;
  };

  return Klass;
}
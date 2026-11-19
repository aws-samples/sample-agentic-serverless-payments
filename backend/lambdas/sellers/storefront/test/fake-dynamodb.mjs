/**
 * Minimal in-memory DynamoDB for the storefront unit tests.
 *
 * Patches DynamoDBDocumentClient.prototype.send so shared.mjs talks to an
 * in-process store instead of AWS. It implements just the surface the storefront
 * uses: Get/Put/Update/Delete/Scan/Query, condition expressions (comparisons,
 * attribute_exists / attribute_not_exists, AND / OR / NOT, parentheses), and
 * SET update expressions with `+` / `-`. A failed condition throws an error
 * named ConditionalCheckFailedException, like the real service.
 *
 * Every send() yields to the event loop first, so concurrent requests
 * interleave between reads and writes the way they do against the real
 * service. delayWrites() holds back matching writes to model a request whose
 * write lands late, which is what lets the race tests reproduce
 * read-then-write bugs deterministically.
 */
import { mock } from "node:test";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const KEY_ATTRS = ["orderId", "productId", "pk"];

export function installFakeDynamoDB() {
  const tables = new Map();
  let delays = [];
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const keyOf = (key) => JSON.stringify(KEY_ATTRS.filter((k) => k in key).map((k) => [k, key[k]]));
  const itemKey = (item) => keyOf(Object.fromEntries(KEY_ATTRS.filter((k) => k in item).map((k) => [k, item[k]])));
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  const send = async (command) => {
    await new Promise((r) => setImmediate(r));
    const name = command.constructor.name;
    const input = command.input;
    const delay = delays.find((d) => d.match(name, input));
    if (delay) await new Promise((r) => setTimeout(r, delay.ms));
    const t = table(input.TableName);
    const ctx = { names: input.ExpressionAttributeNames || {}, values: input.ExpressionAttributeValues || {} };

    switch (name) {
      case "GetCommand":
        return { Item: clone(t.get(keyOf(input.Key))) };
      case "PutCommand": {
        const k = itemKey(input.Item);
        checkCondition(input.ConditionExpression, t.get(k), ctx);
        t.set(k, clone(input.Item));
        return {};
      }
      case "DeleteCommand": {
        const k = keyOf(input.Key);
        checkCondition(input.ConditionExpression, t.get(k), ctx);
        t.delete(k);
        return {};
      }
      case "UpdateCommand": {
        const k = keyOf(input.Key);
        const current = t.get(k);
        checkCondition(input.ConditionExpression, current, ctx);
        const next = applyUpdate(input.UpdateExpression, clone(current) || { ...input.Key }, ctx);
        t.set(k, next);
        return input.ReturnValues === "ALL_NEW" ? { Attributes: clone(next) } : {};
      }
      case "ScanCommand": {
        let items = [...t.values()];
        if (input.FilterExpression) items = items.filter((it) => evaluate(input.FilterExpression, it, ctx));
        return { Items: clone(items.slice(0, input.Limit ?? items.length)) };
      }
      case "QueryCommand": {
        const items = [...t.values()].filter((it) => evaluate(input.KeyConditionExpression, it, ctx));
        return { Items: clone(items.slice(0, input.Limit ?? items.length)) };
      }
      default:
        throw new Error(`fake-dynamodb: unsupported command ${name}`);
    }
  };

  mock.method(DynamoDBDocumentClient.prototype, "send", send);

  return {
    put: (tableName, item) => table(tableName).set(itemKey(item), clone(item)),
    get: (tableName, key) => clone(table(tableName).get(keyOf(key))),
    all: (tableName) => clone([...table(tableName).values()]),
    /** Hold back writes for which match(commandName, input) is true by `ms`. */
    delayWrites: (match, ms) => delays.push({ match, ms }),
    reset: () => { tables.clear(); delays = []; },
  };
}

function checkCondition(expr, item, ctx) {
  if (expr && !evaluate(expr, item || {}, ctx)) {
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    throw err;
  }
}

// ── Expression evaluation ────────────────────────────────────────────────

function tokenize(expr) {
  const re = /\s*(<>|<=|>=|=|<|>|\(|\)|,|\+|-|[#:]?[A-Za-z_][A-Za-z0-9_]*)/y;
  const out = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < expr.length && (m = re.exec(expr))) out.push(m[1]);
  if (re.lastIndex < expr.trimEnd().length) throw new Error(`fake-dynamodb: cannot parse "${expr}"`);
  return out;
}

function operand(tok, item, ctx) {
  if (tok.startsWith(":")) return ctx.values[tok];
  const attr = tok.startsWith("#") ? ctx.names[tok] : tok;
  return item?.[attr];
}

function attrName(tok, ctx) {
  return tok.startsWith("#") ? ctx.names[tok] : tok;
}

function evaluate(expr, item, ctx) {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];

  const primary = () => {
    const tok = take();
    if (tok === "(") {
      const v = or();
      take(); // ")"
      return v;
    }
    if (tok === "NOT") return !primary();
    if (tok === "attribute_exists" || tok === "attribute_not_exists") {
      take(); // "("
      const attr = attrName(take(), ctx);
      take(); // ")"
      const exists = item != null && Object.prototype.hasOwnProperty.call(item, attr);
      return tok === "attribute_exists" ? exists : !exists;
    }
    const left = operand(tok, item, ctx);
    const op = take();
    const right = operand(take(), item, ctx);
    switch (op) {
      case "=": return left !== undefined && left === right;
      case "<>": return left !== right;
      case "<": return left < right;
      case "<=": return left <= right;
      case ">": return left > right;
      case ">=": return left >= right;
      default: throw new Error(`fake-dynamodb: unsupported operator ${op}`);
    }
  };
  const and = () => {
    let v = primary();
    while (peek() === "AND") { take(); const r = primary(); v = v && r; }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === "OR") { take(); const r = and(); v = v || r; }
    return v;
  };
  return or();
}

function applyUpdate(expr, item, ctx) {
  const m = /^\s*SET\s+(.*)$/s.exec(expr || "");
  if (!m) throw new Error(`fake-dynamodb: only SET updates are supported ("${expr}")`);
  // Evaluate every right-hand side against the pre-update item, as DynamoDB does.
  const before = structuredClone(item);
  for (const clause of m[1].split(",")) {
    const toks = tokenize(clause);
    const target = attrName(toks[0], ctx);
    let value = operand(toks[2], before, ctx);
    for (let j = 3; j < toks.length; j += 2) {
      const rhs = operand(toks[j + 1], before, ctx);
      value = toks[j] === "+" ? value + rhs : value - rhs;
    }
    item[target] = value;
  }
  return item;
}

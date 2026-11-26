// May borrow / May destroy of a portal contact, read straight from DocuSoft at portal login.
//
// They ARE two of the contact's own DocuSoft fields (Contact UDFs), found by tag + label (never by id — ids differ per
// folder): tag "Permissions", "Loan Documents" (= may borrow / ask for scans) and "Destroy Documents" (= may destroy).
// Staff set them in DocuSoft (the WMS staff screens save there too).
//
// The portal sends the contact's own portal login (the parent portal already has it) with POST /api/portal/auth/login;
// it is used for this ONE call to DocuSoft's portal-user services (GetCRMContactUDFValues2_Json — the call the parent
// portal itself makes for the logged-in contact) and never stored or logged. The answer goes into the portal token.
const { isProduction } = require("../config/env");

const DEFAULT_URL = "https://portal.mydocusoft.com/portaluserservices.asmx";
const PORTAL_USER_URL = (process.env.DOCUSOFT_PORTAL_USER_URL || DEFAULT_URL).replace(/\/+$/, "");

const TAG = "permissions";
const FIELDS = { canLoan: "loan documents", canPurge: "destroy documents" };

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const ON = ["1", "true", "yes", "y", "on"];
const OFF = ["0", "false", "no", "n", "off"];
// The value of a UDF row, whatever DocuSoft calls the column; undefined = not a value we can read (then we don't guess).
const VALUE_KEYS = ["UdfValue", "UDFValue", "Value", "FieldValue", "TextValue", "UdfValues"];
function valueOf(row) {
  for (const key of VALUE_KEYS) {
    if (!(key in row)) continue;
    const v = s(row[key]).toLowerCase();
    if (ON.includes(v)) return true;
    if (OFF.includes(v) || v === "") return v === "" ? undefined : false;
  }
  return undefined;
}

// DocuSoft answers { d: "<json>" }, sometimes double-encoded.
function unwrap(value) {
  let v = value && typeof value === "object" && "d" in value ? value.d : value;
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

// Every { Name, ... } row anywhere in the answer (the field list sits in a Table / Table1 of some shape).
function rowsOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => rowsOf(v, out));
  else if (value && typeof value === "object") {
    if ("Name" in value) out.push(value);
    else Object.values(value).forEach((v) => rowsOf(v, out));
  }
  return out;
}

function pick(rows, label) {
  const named = rows.filter((r) => s(r.Name).toLowerCase() === label);
  // the one under the Permissions tag when the rows say their tag; else the only one with that label
  return named.find((r) => s(r.TagName).toLowerCase() === TAG) || (named.length === 1 && !s(named[0].TagName) ? named[0] : null);
}

/**
 * { canLoan, canPurge } from the contact's DocuSoft UDFs — each only when DocuSoft has that field (missing = not
 * known, the caller falls back). null when DocuSoft couldn't be asked (no password, wrong login, network): login still
 * works, the warehouse's own copy of the switches decides.
 */
async function readContactPermissions({ agrno, clientId, email, password }) {
  if (!password) return null;
  try {
    const response = await fetch(`${PORTAL_USER_URL}/GetCRMContactUDFValues2_Json`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ Accid: agrno, username: email, sPassword: password, ClientId: clientId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const reply = unwrap(await response.json());
    const rows = rowsOf(reply);
    const out = {};
    for (const [flag, label] of Object.entries(FIELDS)) {
      const row = pick(rows, label);
      const value = row ? valueOf(row) : undefined;
      if (value !== undefined) out[flag] = value; // unreadable / empty → left out, our own copy decides
    }
    if (!isProduction) {
      // what DocuSoft answered (shape + the two permission rows only — no login details), to check the mapping
      const shape = reply && typeof reply === "object" ? Object.keys(reply).map((k) => `${k}[${Array.isArray(reply[k]) ? reply[k].length : typeof reply[k]}]`) : typeof reply;
      const found = rows.filter((r) => Object.values(FIELDS).includes(s(r.Name).toLowerCase()));
      console.log("[portal perms]", email, "reply:", JSON.stringify(shape), "rows:", JSON.stringify(found), "=>", JSON.stringify(out));
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null; // never block a portal login on DocuSoft
  }
}

module.exports = { readContactPermissions };

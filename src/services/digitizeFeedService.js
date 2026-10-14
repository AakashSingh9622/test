// "Which digitize orders are scheduled?" -- for the external scan app. The caller proves who it is with the same
// credentials as a staff login (DocuSoft email + base64 password) plus the agreement number (agrno).
//   * agrno must be the agreement this system is for (app_setting "defaultDatabase")
//   * DocuSoft must accept the email + password, and that email must belong to the agreement (agrno)
// Every failure of those checks returns the SAME 401, so an outsider cannot tell which part was wrong.
const prisma = require("../config/prisma");
const { getAgreementList } = require("./docusoftClient");
const { getDefaultDatabase, sameAgreement } = require("./appSettingService");

const MAX_ORDERS = 1000; // a hard ceiling so one call can never return an unbounded list
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// An error the route turns into a JSON response: { status:false, code, message }.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INVALID_CREDENTIALS = () => new ApiError(401, "INVALID_CREDENTIALS", "Invalid email, password or agreement number.");

// Checks the body and returns clean values; throws 400 listing every problem found.
function validate(body) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!input) throw new ApiError(400, "VALIDATION_ERROR", "Request body must be a JSON object with email, password and agrno.");

  const problems = [];
  const read = (field) => (typeof input[field] === "string" ? input[field].trim() : "");

  const email = read("email").toLowerCase();
  if (!email) problems.push("email is required");
  else if (email.length > 254 || !EMAIL.test(email)) problems.push("email is not a valid email address");

  const password = read("password");
  if (!password) problems.push("password is required (base64 encoded)");
  else if (password.length > 1024 || password.length % 4 !== 0 || !BASE64.test(password)) problems.push("password must be a valid base64 string");

  const agrno = read("agrno");
  if (!agrno) problems.push("agrno is required");
  else if (agrno.length > 50) problems.push("agrno is too long");

  if (problems.length) throw new ApiError(400, "VALIDATION_ERROR", problems.join("; ") + ".");
  return { email, password, agrno };
}

// DocuSoft's agreement list for the email, with our own errors for every way the call can go wrong.
async function agreementRows(email, password) {
  let result;
  try {
    result = await getAgreementList({ Email: email, password });
  } catch (err) {
    if (err && err.name === "TimeoutError") throw new ApiError(504, "UPSTREAM_TIMEOUT", "DocuSoft did not answer in time. Please try again.");
    throw new ApiError(502, "UPSTREAM_ERROR", "DocuSoft is not reachable right now. Please try again.");
  }
  // A normal answer is { Table: [...] } (empty when the email/password is wrong). Anything else is not trustworthy.
  if (!result || typeof result !== "object" || !Array.isArray(result.Table)) {
    throw new ApiError(502, "UPSTREAM_ERROR", "DocuSoft returned an unexpected answer. Please try again.");
  }
  return result.Table;
}

// body = { email, password (base64), agrno }  ->  { count, orders: [{ id, name }] }
async function scheduledDigitizeOrders(body) {
  const { email, password, agrno } = validate(body);

  const allowed = await getDefaultDatabase();
  if (!allowed) throw new ApiError(503, "NOT_CONFIGURED", "This system is not configured yet.");
  if (!sameAgreement(agrno, allowed)) throw INVALID_CREDENTIALS();

  const rows = await agreementRows(email, password);
  if (!rows.some((row) => sameAgreement(row.vAgreementNo, agrno))) throw INVALID_CREDENTIALS();

  // Scheduled digitize orders the client has already authorised (nothing is scanned without that sign-off).
  const where = { type: "digitize", status: "scheduled", NOT: { digitization: { equals: null } } };
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: { id: true, orderNumber: true },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: MAX_ORDERS,
    }),
    prisma.order.count({ where }),
  ]);
  return { count: total, orders: items.map((o) => ({ id: o.id, name: o.orderNumber })) };
}

module.exports = { scheduledDigitizeOrders, ApiError };

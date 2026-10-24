// Staff login business logic: DocuSoft se verify karo, wh_user table me cache karo, apna session
// token issue karo. (docusoft-MCP/src/services/auth0DbVerify.js ka wahi pattern, par
// Postgres-upsert + admin-vs-operator role split ke saath, jo auth0DbVerify.js khud nahi karta.)
// NOTE: Json_GetFolders/Json_GetClientsByFolder (clients/folders feature) backend se nahi,
// seedha frontend se DocuSoft ko call hote hain (reference: docusoftpractice project) -- isliye
// yahan password replay/encrypt karne ki zaroorat nahi, sirf is ek login call ke liye chahiye.
const prisma = require("../config/prisma");
const { getAgreementList } = require("./docusoftClient");
const { encodeSession } = require("../auth/sessionToken");
const { getDefaultDatabase, sameAgreement } = require("./appSettingService");
const { localRolesFor, forgetRoles } = require("./roleService");
const { effectiveRoles } = require("../auth/permissions");

// Login fail hone ki har wajah ke liye ek clear HTTP status + code -- controller isi se response banata hai.
class AuthError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(email) {
  return String(email || "").toLowerCase().trim();
}

// DocuSoft ka SOAP API password ko base64 form me expect karta hai -- user normal (plaintext)
// password bhejta hai, backend yahan usi convention ke mutabik base64 encode karta hai.
function toDocusoftBase64(plaintext) {
  return Buffer.from(String(plaintext), "utf8").toString("base64");
}

// Email + plaintext password leke: DocuSoft se verify karta hai, admin-check karta hai,
// WHUser upsert karta hai, aur { user, token } (frontend ke AuthUser shape me) deta hai.
async function loginWithDocusoft({ email, password }) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || !password) {
    throw new AuthError("MISSING_INPUT", 400, "Email and password are required");
  }

  // DocuSoft ko base64 password bhejo, agreement list wapas aati hai.
  const base64Password = toDocusoftBase64(password);
  const result = await getAgreementList({ Email: normEmail, password: base64Password });
  const allRows = result && Array.isArray(result.Table) ? result.Table : [];

  // Khaali Table matlab email/password hi galat tha.
  if (allRows.length === 0) {
    throw new AuthError("INVALID_CREDENTIALS", 401, "Invalid email or password");
  }

  // This system is for ONE DocuSoft agreement (app_setting "defaultDatabase", e.g. "0003"). An email can belong to
  // several agreements; only the rows of THIS agreement count. None of them -> no login.
  const allowedAgrno = await getDefaultDatabase();
  if (!allowedAgrno) {
    throw new AuthError("NOT_CONFIGURED", 503, "This system is not configured yet (defaultDatabase is missing).");
  }
  const rows = allRows.filter((row) => sameAgreement(row.vAgreementNo, allowedAgrno));
  if (rows.length === 0) {
    throw new AuthError("AGREEMENT_NOT_ALLOWED", 403, "Your account does not have access to this system.");
  }

  // Credentials sahi hain (Table non-empty) -- ab roles: DocuSoft se sirf admin flag aata hai (kisi bhi row me
  // strIsAdmin true -> staff_admin); baaki roles humare user_role table se. Dono na hon to staff_operator.
  const adminRow = rows.find((row) => row.strIsAdmin === true || row.strIsAdmin === "true");
  const primaryRow = adminRow || rows[0];
  const roles = effectiveRoles(!!adminRow, await localRolesFor(normEmail));

  // WHUser me is login ka latest snapshot cache karo (DocuSoft ko dobara call karne se bachne ke liye).
  const profile = {
    name: primaryRow.strUserName || normEmail,
    docusoftUserId: Number(primaryRow.intUserId) || 0,
    agreementNo: String(primaryRow.vAgreementNo || "").trim(),
    isAdmin: !!adminRow,
    role: roles[0],
    lastLoginAt: new Date(),
  };
  const whUser = await prisma.wHUser.upsert({
    where: { email: normEmail },
    create: { email: normEmail, ...profile },
    update: profile,
  });
  forgetRoles(normEmail); // admin flag may have changed in DocuSoft

  // Frontend ke AuthUser shape (src/auth/useAuth.tsx) -- side hamesha "staff" (sirf admin login abhi).
  const authUser = {
    id: whUser.id,
    name: whUser.name,
    email: whUser.email,
    side: "staff",
    roles,
  };

  // Session claims frontend ke SessionClaims (session-shared.ts) shape me -- clientId admin ke liye nahi hota.
  const token = encodeSession({
    userId: authUser.id,
    name: authUser.name,
    email: authUser.email,
    side: authUser.side,
    roles: authUser.roles,
  });

  // agrno bhi response me jaata hai (token/session claims ka hissa nahi) -- frontend isi se,
  // khud ke paas maujood plaintext password ke saath, DocuSoft ko seedha call karega
  // (Json_GetFolders/Json_GetClientsByFolder) bina humare backend se guzre.
  return { user: authUser, token, agrno: whUser.agreementNo };
}

// /auth/me ke liye: session claims me se userId leke WHUser se fresh data uthata hai.
// Malformed/forged userId (CastError) bhi "user nahi mila" hi maana jaata hai -- 401, na ki 500.
async function getUserFromClaims(claims) {
  if (!claims || !claims.userId) return null;
  let whUser;
  try {
    whUser = await prisma.wHUser.findUnique({ where: { id: String(claims.userId) } });
  } catch {
    return null;
  }
  if (!whUser) return null;
  // A session of someone whose agreement is not (or no longer) the allowed one is not valid.
  const allowedAgrno = await getDefaultDatabase();
  if (!allowedAgrno || !sameAgreement(whUser.agreementNo, allowedAgrno)) return null;
  return {
    id: whUser.id,
    name: whUser.name,
    email: whUser.email,
    side: "staff",
    roles: effectiveRoles(whUser.isAdmin, await localRolesFor(whUser.email)), // fresh: a role change shows without re-login
  };
}

module.exports = { AuthError, loginWithDocusoft, getUserFromClaims };

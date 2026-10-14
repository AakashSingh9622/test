// HTTP layer for auth -- response shape frontend ke mock handlers (frontend/src/mocks/handlers/
// auth.ts) jaisi hai, bas ek extra `agrno` field ke saath (frontend isse seedha DocuSoft ko
// folders/clients jaisi calls karne ke liye use karta hai -- src/auth/useAuth.tsx dekho).
const { AuthError, loginWithDocusoft, getUserFromClaims } = require("../services/authService");

async function login(req, res) {
  const { email, password } = req.body || {};
  try {
    const { user, token, agrno } = await loginWithDocusoft({ email, password });
    // Token response body me hi jaata hai (cookie backend set nahi karta) -- frontend ka
    // useAuth.tsx khud document.cookie likhta hai, isliye yahan contract wahi rakha gaya hai.
    return res.json({ user, token, agrno });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status).json({ message: err.message });
    }
    throw err; // DocuSoft network/unexpected errors -- errorMiddleware handle karega
  }
}

async function logout(_req, res) {
  // Token stateless hai (server pe kuch store nahi hota), isliye logout sirf ok:true deta hai --
  // asli cleanup (cookie delete) frontend khud karta hai.
  res.json({ ok: true });
}

async function me(req, res) {
  const user = await getUserFromClaims(req.user);
  if (!user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  res.json(user);
}

module.exports = { login, logout, me };

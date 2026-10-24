// Staff signatures (24 Oct): each staff member keeps one signature -- drawn, typed in a handwriting font, or an uploaded
// picture. It is always stored as a PNG / JPEG image (plus how it was made), and copied onto every certificate of
// destruction they sign, at that moment -- a later change never alters a certificate already issued.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { appendAdminEvent } = require("./adminAuditService");

const KINDS = ["drawn", "typed", "uploaded"];
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_IMAGE_CHARS = 400_000; // ~300 KB of image -- far more than a signature needs

function clean(input = {}) {
  const kind = String(input.kind ?? "");
  if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of: ${KINDS.join(", ")}`);
  const image = String(input.image ?? "");
  if (!IMAGE.test(image)) throw httpError(400, "image must be a PNG, JPEG or WebP picture (data URL)");
  if (image.length > MAX_IMAGE_CHARS) throw httpError(413, "The signature picture is too large — use a smaller image");
  const out = { kind, image, updatedAt: new Date().toISOString() };
  if (kind === "typed") {
    const text = String(input.text ?? "").trim().slice(0, 80);
    const font = String(input.font ?? "").trim().slice(0, 60);
    if (!text) throw httpError(400, "Type your name for a typed signature");
    Object.assign(out, { text, font: font || undefined });
  }
  return out;
}

async function getSignature(userId) {
  const user = await prisma.wHUser.findUnique({ where: { id: userId }, select: { signature: true } });
  return user?.signature ?? null;
}

async function setSignature(userId, input, actor) {
  const signature = clean(input);
  const user = await prisma.wHUser.findUnique({ where: { id: userId }, select: { id: true, email: true, signature: true } });
  if (!user) throw httpError(404, "User not found — log in again");
  await prisma.$transaction(async (tx) => {
    await tx.wHUser.update({ where: { id: userId }, data: { signature } });
    await appendAdminEvent(
      "signature_updated",
      actor,
      {
        entityType: "user",
        entityId: user.email,
        summary: `${user.signature ? "Changed" : "Added"} the signature of ${user.email} (${signature.kind})`,
      },
      tx
    );
  });
  return signature;
}

async function removeSignature(userId, actor) {
  const user = await prisma.wHUser.findUnique({ where: { id: userId }, select: { email: true, signature: true } });
  if (!user?.signature) return;
  await prisma.$transaction(async (tx) => {
    await tx.wHUser.update({ where: { id: userId }, data: { signature: null } });
    await appendAdminEvent("signature_updated", actor, { entityType: "user", entityId: user.email, summary: `Removed the signature of ${user.email}` }, tx);
  });
}

// For a certificate: the signer's current signature (image + how it was made), or a 409 asking them to add one.
async function requireSignature(userId) {
  const signature = await getSignature(userId);
  if (!signature?.image) {
    throw httpError(
      409,
      "Add your signature before marking boxes as destroyed — it goes on the certificate of destruction",
      "SIGNATURE_REQUIRED"
    );
  }
  return { image: signature.image, kind: signature.kind };
}

module.exports = { getSignature, setSignature, removeSignature, requireSignature };

// Chhota helper -- business-rule violations (not-found, invalid-state) ko sahi HTTP status ke
// saath throw karne ke liye, taaki errorMiddleware generic 500 ke bajaye sahi status bheje.
// `code` (optional) reaches the client next to the message, for errors a screen reacts to ("SIGNATURE_REQUIRED").
function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.errorCode = code;
  return err;
}

module.exports = httpError;

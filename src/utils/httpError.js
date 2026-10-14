// Chhota helper -- business-rule violations (not-found, invalid-state) ko sahi HTTP status ke
// saath throw karne ke liye, taaki errorMiddleware generic 500 ke bajaye sahi status bheje.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = httpError;

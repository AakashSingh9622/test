// 404 handler -- koi bhi route match na hone par yahan aata hai (app.js ke sabse end me mounted).
function notFound(req, res) {
  res.status(404).json({
    status: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

// Central error handler -- har route ka thrown/rejected error (asyncHandler ke through) yahan aata hai.
function errorHandler(err, _req, res, _next) {
  console.error(err);

  // Prisma known request errors -- code reference: https://www.prisma.io/docs/orm/reference/error-reference
  if (err.code === "P2002") {
    // Unique constraint (jaise do boxes ek hi barcode, ya ek hi email se do WHUser).
    return res.status(409).json({ status: false, message: "Duplicate value already exists" });
  }
  if (err.code === "P2025") {
    // Update/delete ke liye record nahi mila.
    return res.status(404).json({ status: false, message: "Record not found" });
  }
  if (err.name === "PrismaClientValidationError") {
    // Galat type/enum value (jaise status="foo").
    return res.status(400).json({ status: false, message: "Invalid request data" });
  }

  // Body-parser errors: say what is wrong with the request without echoing parser internals.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ status: false, code: "INVALID_JSON", message: "Request body must be valid JSON." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ status: false, code: "BODY_TOO_LARGE", message: "Request body is too large." });
  }

  res.status(err.status || 500).json({
    status: false,
    ...(err.errorCode && { code: err.errorCode }),
    message: err.message || "Internal server error",
  });
}

module.exports = { notFound, errorHandler };

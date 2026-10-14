// Express 4 async route handlers ke thrown errors/rejected promises khud errorMiddleware tak
// nahi pahunchte -- ye wrapper unhe catch karke next(err) bula deta hai, taaki har controller
// me alag try/catch na likhna pade.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;

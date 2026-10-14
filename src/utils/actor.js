// req.user session claims (decodeSession ka output) se, audit/order records me stamp karne
// layak chhota Actor object banata hai.
function actorFromReq(req) {
  return { id: req.user.userId, name: req.user.name, side: req.user.side };
}

module.exports = { actorFromReq };

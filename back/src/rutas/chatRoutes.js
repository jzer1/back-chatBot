const express = require("express");
const router = express.Router();
const controladorChatOpenIA = require('../controladores/controladorOpenIa');

router.post("/chat", controladorChatOpenIA);

module.exports = router;

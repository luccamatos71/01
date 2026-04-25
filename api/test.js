// Handler mínimo para testar
module.exports = (req, res) => {
  res.status(200).json({ ok: true, msg: "Handler funciona!" });
};

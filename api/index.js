require("dotenv").config();

const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  try {
    // GET / — serve index.html
    if (req.method === "GET" && req.url === "/") {
      const indexPath = path.join(__dirname, "..", "index.html");
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, "utf8");
        res.setHeader("Content-Type", "text/html");
        res.status(200).send(html);
        return;
      }
      res.status(404).send("index.html não encontrado");
      return;
    }

    // Importar handler principal (quando pronto)
    if (req.url.startsWith("/api/") || req.url.startsWith("/ads/")) {
      const { handler } = require("./handler.js");
      return handler(req, res);
    }

    // 404
    res.status(404).json({ erro: "Rota não encontrada" });
  } catch (err) {
    console.error("[API] Erro:", err);
    res.status(500).json({ erro: err.message || "Erro interno" });
  }
};

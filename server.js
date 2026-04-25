require("dotenv").config();

const http = require("http");
const { handler } = require("./api/handler.js");

const PORT = process.env.PORT || 3000;

const server = http.createServer(handler);

server.listen(PORT, () => {
  console.log(`\n✔  Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Endpoint: POST /api/analisar`);
  console.log(`   Frontend: GET /\n`);
});

// server.js
import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();
const app = express();
app.use(express.urlencoded({ extended: true }));

// Twilio webhook entry point
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Start>
    <Stream url="wss://${process.env.PUBLIC_HOST}/media"/>
  </Start>
  <Say>Connecting you to the AI receptionist.</Say>
  <Pause length="60"/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// WebSocket server for /media
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (twilioWS) => {
  console.log("Twilio connected to media stream");

  // For now just log frames so we know it works
  twilioWS.on("message", (msg) => {
    try {
      const txt = msg.toString();
      console.log("Frame:", txt.slice(0, 80));
    } catch {}
  });

  twilioWS.on("close", () => console.log("Twilio stream closed"));
});

const server = app.listen(process.env.PORT || 3000, () =>
  console.log("Server listening on port 3000")
);

// Upgrade HTTP → WS for /media
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});
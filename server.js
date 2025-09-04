// server.js — realtime voice receptionist with natural (non-robotic) fillers
import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== Persona / instructions for OpenAI Realtime =====
const INSTRUCTIONS = `
You are the phone receptionist for **Clean Auto Detailing** (mobile service — we come to the caller's driveway).
Style: natural, friendly, professional, concise (1–2 sentences). You may use occasional, subtle fillers (e.g., “hmm,” “just a sec,” “okay…”) only when natural and helpful—no overuse, no drawn-out robotic syllables. Vary phrasing and keep any hesitation brief.

Business facts:
- Hours: Mon–Sat, 9:00 AM–5:00 PM
- Phone: 905-466-8506 (booking by phone)
- Services: interior detail, exterior detail, paint correction, ceramic coating
- Pricing (CAD): Interior+Exterior $240, Interior $190, Exterior $160
- Policy: Please have the car emptied of personal belongings before the appointment.

Behavior:
- Greet and ask how you can help.
- If asked: give hours, mobile nature (we come to them), services, prices.
- For booking: collect name, callback number, service address, vehicle (make/model/year), desired service(s), and preferred date/time; then confirm a human will text/call to finalize.
- If unknown: take a message (name/number/question) and promise same-day callback during business hours.
- Never invent extra fees or unavailable services.
`;

// ===== 1) Twilio entrypoint: start Media Stream to our WS =====
app.all("/voice", (req, res) => {
  const host = process.env.PUBLIC_HOST; // e.g. ai-receptionist-xxxx.onrender.com
  const twiml = `
<Response>
  <Start>
    <Stream url="wss://${host}/media"/>
  </Start>
  <Say voice="Polly.Joanna">Connecting you with the Clean Auto Detailing virtual receptionist.</Say>
  <Pause length="60"/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// ===== 2) WS bridge: Twilio <-> OpenAI Realtime =====
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWS) => {
  // Connect to OpenAI Realtime (WebSocket)
  const oaUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const openaiWS = new (await import("ws")).WebSocket(oaUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  let openaiReady = false;

  openaiWS.on("open", () => {
    openaiReady = true;

    // Session instructions (persona + optional voice)
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: INSTRUCTIONS,
        // Pick a natural voice. If you want to try others, change this string.
        // (If omitted, Realtime uses a good default.)
        voice: process.env.REALTIME_VOICE || "alloy"
      }
    }));

    // Start with a short greeting
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Start the call with a short, friendly greeting." }
    }));
  });

  openaiWS.on("close", () => {
    try { twilioWS.close(); } catch {}
  });

  openaiWS.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // Incoming audio from Twilio -> OpenAI
  twilioWS.on("message", (msg) => {
    try {
      const frame = JSON.parse(msg.toString());
      if (frame.event === "start") {
        console.log("Twilio stream started:", frame?.start?.streamSid);
      }
      if (frame.event === "media" && openaiReady) {
        // Forward caller audio chunk (base64) to OpenAI input buffer
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: frame.media.payload
        }));
      }
      if (frame.event === "stop" && openaiReady) {
        // Ask OpenAI to respond based on buffered input
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  // Outgoing audio from OpenAI -> Twilio
  openaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      // Realtime streams audio as output_audio.delta chunks (base64)
      if (evt.type === "output_audio.delta" && evt.audio) {
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: evt.audio }
        }));
      }
      if (evt.type === "response.completed") {
        // Ready for more caller input; Twilio keeps streaming.
      }
    } catch {
      // ignore non-JSON events
    }
  });

  twilioWS.on("close", () => {
    try { openaiWS.close(); } catch {}
    console.log("Twilio stream closed");
  });
});

// ===== 3) Upgrade HTTP server to accept /media WebSocket connections =====
const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server listening on port", process.env.PORT || 3000);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Simple health check
app.get("/", (_, res) => res.send("OK"));


// server.js — Clean Auto Detailing realtime voice receptionist (silence detection)
// Twilio Media Streams <-> OpenAI Realtime WebSocket

import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ========= Persona / instructions for OpenAI Realtime =========
const INSTRUCTIONS = `
You are the phone receptionist for **Clean Auto Detailing** (mobile service — we come to the caller's driveway).
Style: natural, friendly, professional, concise (1–2 sentences). Occasional subtle fillers are okay only when natural—do not overuse them or sound robotic.

Business facts:
- Hours: Mon–Sat, 9:00 AM–5:00 PM
- Phone: 905-466-8506 (booking by phone)
- Services: interior detail, exterior detail, paint correction, ceramic coating
- Pricing (CAD): Interior+Exterior $240, Interior $190, Exterior $160
- Policy: Please have the car emptied of personal belongings before the appointment.

Behavior:
- Start with a short greeting and a simple question like: "How can I help you today?"
- If asked: share hours, that we're mobile (we come to their driveway), services, and prices.
- For booking: collect name, callback number, service address, vehicle (make/model/year),
  desired service(s), and preferred date/time; then confirm a human will text/call to finalize.
- If unknown: take a message (name/number/question) and promise same-day callback during business hours.
- Never invent extra fees or unavailable services.
`;

// ========= 1) Twilio entrypoint: start media stream + short start prompt =========
app.all("/voice", (req, res) => {
  console.log(`${req.method} /voice hit`);
  const host = process.env.PUBLIC_HOST; // e.g. ai-receptionist-xxxx.onrender.com (NO https://)
  const twiml = `
<Response>
  <Start>
    <Stream url="wss://${host}/media"/>
  </Start>
  <Say voice="Polly.Joanna">
    You’re connected to the Clean Auto Detailing virtual receptionist.
    How can I help you today?
  </Say>
  <!-- Keep the call open while the AI streams audio back -->
  <Pause length="600"/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// ========= 2) WebSocket bridge: Twilio <-> OpenAI Realtime (+silence detector) =========
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWS) => {
  const oaUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const OpenAIWS = (await import("ws")).WebSocket;
  const openaiWS = new OpenAIWS(oaUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  let openaiReady = false;
  let lastMediaAt = 0;
  let hasBuffered = false;

  // Commit after ~900ms of silence
  const SILENCE_MS = 900;

  openaiWS.on("open", () => {
    openaiReady = true;
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: INSTRUCTIONS,
        voice: process.env.REALTIME_VOICE || "alloy"
      }
    }));
    // Proactive greeting (AI voice)
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet briefly and ask: 'How can I help you today?'" }
    }));
  });

  openaiWS.on("close", () => { try { twilioWS.close(); } catch {} });
  openaiWS.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // Silence timer: check every 200ms
  const interval = setInterval(() => {
    if (!openaiReady) return;
    if (!hasBuffered) return;
    const now = Date.now();
    if (now - lastMediaAt > SILENCE_MS) {
      // We consider the user finished speaking → ask OpenAI to respond
      try {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
        hasBuffered = false; // reset until we get new audio
      } catch (e) {
        console.error("Commit/create error:", e?.message || e);
      }
    }
  }, 200);

  // Caller audio from Twilio -> OpenAI input buffer
  twilioWS.on("message", (msg) => {
    try {
      const frame = JSON.parse(msg.toString());

      if (frame.event === "start") {
        console.log("Twilio stream started:", frame?.start?.streamSid);
        lastMediaAt = Date.now();
      }

      if (frame.event === "media" && openaiReady) {
        // Each chunk is base64 audio
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: frame.media.payload
        }));
        hasBuffered = true;
        lastMediaAt = Date.now();
      }

      // We NO LONGER wait for frame.event === "stop" (that's call end)
    } catch {
      // ignore non-JSON frames
    }
  });

  // AI audio from OpenAI -> Twilio
  openaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      if (evt.type === "output_audio.delta" && evt.audio) {
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: evt.audio }
        }));
      }
      // When the AI finishes, we just keep listening; the silence timer will handle next turns.
    } catch {
      // ignore non-JSON
    }
  });

  twilioWS.on("close", () => {
    clearInterval(interval);
    try { openaiWS.close(); } catch {}
    console.log("Twilio stream closed");
  });
});

// ========= 3) Upgrade HTTP server to accept /media WebSocket =========
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

// Health check
app.get("/", (_, res) => res.send("OK"));



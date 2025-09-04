// server.js — Clean Auto Detailing realtime voice receptionist
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
- Start with a short greeting and an explicit question such as:
  "How can I help with your detailing today—interior, exterior, or both?"
- If asked: share hours, that we're mobile (we come to their driveway), services, and prices.
- For booking: collect name, callback number, service address, vehicle (make/model/year),
  desired service(s), and preferred date/time; then confirm a human will text/call to finalize.
- If unknown: take a message (name/number/question) and promise same-day callback during business hours.
- Never invent extra fees or unavailable services.
`;

// ========= 1) Twilio entrypoint: start media stream + clear prompt =========
app.all("/voice", (req, res) => {
  const host = process.env.PUBLIC_HOST; // e.g. ai-receptionist-xxxx.onrender.com (NO https://)
  const twiml = `
<Response>
  <Start>
    <Stream url="wss://${host}/media"/>
  </Start>
  <Say voice="Polly.Joanna">
    You’re connected to the Clean Auto Detailing virtual receptionist.
    After the beep, tell me what you need—interior, exterior, paint correction, or ceramic coating.
  </Say>
  <Play>https://api.twilio.com/cowbell.mp3</Play>
  <Pause length="1"/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// ========= 2) WebSocket bridge: Twilio <-> OpenAI Realtime =========
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWS) => {
  // Connect to OpenAI Realtime WebSocket
  const oaUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const OpenAIWS = (await import("ws")).WebSocket;
  const openaiWS = new OpenAIWS(oaUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  let openaiReady = false;

  openaiWS.on("open", () => {
    openaiReady = true;

    // Set session (persona + optional voice)
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: INSTRUCTIONS,
        // Try another voice by setting env REALTIME_VOICE in Render (e.g., "verse")
        voice: process.env.REALTIME_VOICE || "alloy"
      }
    }));

    // Proactive greeting that invites speech immediately
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions:
          "Greet briefly and ask: 'How can I help with your detailing today—interior, exterior, or both?'"
      }
    }));
  });

  openaiWS.on("close", () => {
    try { twilioWS.close(); } catch {}
  });

  openaiWS.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // Caller audio from Twilio -> OpenAI input buffer
  twilioWS.on("message", (msg) => {
    try {
      const frame = JSON.parse(msg.toString());

      if (frame.event === "start") {
        console.log("Twilio stream started:", frame?.start?.streamSid);
      }

      if (frame.event === "media" && openaiReady) {
        // frame.media.payload is base64-encoded audio from Twilio
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: frame.media.payload
        }));
      }

      if (frame.event === "stop" && openaiReady) {
        // Caller paused; ask OpenAI to respond
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      }
    } catch {
      // Non-JSON frames can be ignored
    }
  });

  // AI audio from OpenAI -> Twilio
  openaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());

      // Realtime streams audio chunks as output_audio.delta (base64)
      if (evt.type === "output_audio.delta" && evt.audio) {
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: evt.audio }
        }));
      }

      if (evt.type === "response.completed") {
        // Ready for more input; Twilio will keep streaming microphone audio.
      }
    } catch {
      // Ignore non-JSON events
    }
  });

  twilioWS.on("close", () => {
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

// Simple health check
app.get("/", (_, res) => res.send("OK"));


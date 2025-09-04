// server.js — Clean Auto Detailing turn-based voice receptionist (works now)
// Twilio <Gather speech> -> OpenAI reply (text) -> Twilio <Say> (Polly voice)

import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===================== Persona (your business) =====================
const SYSTEM_PROMPT = `
You are the phone receptionist for **Clean Auto Detailing** (mobile service — we come to the caller's driveway).
Style: natural, friendly, professional; keep replies concise (1–2 sentences).

Business facts (treat as true):
- Hours: Mon–Sat, 9:00 AM–5:00 PM
- Booking: by phone at 905-466-8506
- Services: interior detail, exterior detail, paint correction, ceramic coating
- Pricing (CAD): Interior+Exterior $240, Interior $190, Exterior $160
- Policy: Please have the car emptied of personal belongings before the appointment.

Behavior:
- Start with a short greeting: "Thanks for calling Clean Auto Detailing. How can I help you today?"
- If asked: share hours, that you're mobile (you come to them), services, and prices.
- For booking: collect name, callback number, service address, vehicle (make/model/year), desired service(s), preferred date/time; confirm a human will text/call to finalize.
- If unknown: take a message (name/number/question) and promise same-day callback during business hours.
- Never invent extra fees or unavailable services.
`;

// ===================== OpenAI helper =====================
async function askOpenAI(message, context = []) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...context,
          { role: "user", content: message || "Caller was silent. Greet and ask how to help." },
        ],
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("OpenAI error:", res.status, text);
      return "Sorry—I'm having trouble right now. Our hours are Monday to Saturday, nine to five. Would you like to book an appointment?";
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim()
      || "How can I help you today?";
  } catch (e) {
    console.error("OpenAI call failed:", e?.message || e);
    return "Sorry—I'm having trouble right now. Our hours are Monday to Saturday, nine to five. Would you like to book an appointment?";
  }
}

// ===================== Routes (Twilio TwiML) =====================

// Small helper so special characters don't break XML
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Entry point: greet + listen
app.all("/voice", (req, res) => {
  console.log(`${req.method} /voice hit`);
  const twiml = `
<Response>
  <Say voice="Polly.Joanna">Thanks for calling Clean Auto Detailing. How can I help you today?</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-CA">
    <Say voice="Polly.Joanna">I'm listening.</Say>
  </Gather>
  <Say voice="Polly.Joanna">I didn’t catch that. Let me try again.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// Handle the caller's speech, reply, and loop
app.post("/gather", async (req, res) => {
  const transcript = (req.body.SpeechResult || "").trim();
  console.log("Caller said:", transcript || "(no speech)");

  const reply = await askOpenAI(transcript);

  const twiml = `
<Response>
  <Say voice="Polly.Joanna">${escapeXml(reply)}</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-CA">
    <Say voice="Polly.Joanna">Anything else I can help you with?</Say>
  </Gather>
  <Say voice="Polly.Joanna">Thanks for calling Clean Auto Detailing. Goodbye!</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// Health/debug
app.get("/", (_, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));



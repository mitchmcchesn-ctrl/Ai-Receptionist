// server.js — turn-based voice receptionist for Clean Aut Detailing
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===================== Persona (your business) =====================
const SYSTEM_PROMPT = `
You are the phone receptionist for **Clean Aut Detailing**.
Tone: warm, clear, professional; keep replies to 1–2 sentences.

Business facts (treat as true):
- Service type: Mobile detailing — we come directly to the customer’s driveway.
- Hours: Mon–Sat, 9:00 AM–5:00 PM
- Booking: over the phone at 905-466-8506
- Services: interior detail, exterior detail, paint correction, ceramic coating
- Pricing: Interior+Exterior $240, Interior $190, Exterior $160
- Policies: Please have the car emptied of personal belongings before your appointment.

Call handling rules:
1) Greet and offer help immediately. Example: “Thanks for calling Clean Aut Detailing—virtual receptionist here. How can I help today?”
2) Answer FAQs using the facts above; never invent details beyond them.
3) For booking: collect caller’s full name, callback number, address (for mobile service), vehicle (make/model/year), desired service(s), and preferred date/time. Offer first available if they’re flexible.
4) Confirm price based on chosen service; mention any add-ons (paint correction, ceramic coating) are quoted after quick inspection.
5) After collecting details, confirm back to the caller and say a human will text/call to finalize the slot.
6) If a question isn’t covered, take a message (name, number, question) and promise a same-day callback during business hours.
7) Always end with a next step: booking, sending confirmation, or taking a message.
`;

// ===================== OpenAI helper =====================
async function askOpenAI(message, context = []) {
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...context,
      { role: "user", content: message }
    ],
    temperature: 0.3
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("OpenAI error:", res.status, text);
    return "Sorry, I’m having trouble right now.";
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "How can I help?";
}

// ===================== TwiML builders =====================
function buildVoiceTwiml() {
  return `
<Response>
  <Say voice="Polly.Joanna">Hello! Thanks for calling Clean Aut Detailing. We’re mobile and come right to your driveway. How can I help you today?</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna">I’m listening.</Say>
  </Gather>
  <Say voice="Polly.Joanna">I didn’t catch that. Let me try again.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ===================== Routes =====================
// Allow both GET (for browser check) and POST (Twilio) on /voice
app.all("/voice", (req, res) => {
  console.log(`${req.method} /voice hit`);
  res.type("text/xml").send(buildVoiceTwiml().trim());
});

// Twilio posts the caller's speech transcript here
app.post("/gather", async (req, res) => {
  const transcript = (req.body.SpeechResult || "").trim();
  console.log("Caller said:", transcript || "(no speech)");

  let reply;
  try {
    reply = await askOpenAI(transcript || "Caller was silent. Greet and ask how to help.");
  } catch (e) {
    console.error("AI call failed:", e);
    reply = "Our hours are Monday to Saturday, nine to five. Would you like to book an appointment?";
  }

  const twiml = `
<Response>
  <Say voice="Polly.Joanna">${escapeXml(reply)}</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna">Anything else I can help you with?</Say>
  </Gather>
  <Say voice="Polly.Joanna">Thanks for calling. Goodbye!</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// Health/debug route (safe)
app.get("/debug", (req, res) => {
  const k = process.env.OPENAI_API_KEY || "";
  res.json({ hasKey: Boolean(k && k.startsWith("sk-")), prefix: k ? k.slice(0, 3) : null, length: k ? k.length : 0 });
});

// ===================== Start server =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));

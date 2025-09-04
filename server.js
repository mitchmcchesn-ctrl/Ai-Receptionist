// server.js  (turn-based voice receptionist)
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== Helper: receptionist system instructions =====
const SYSTEM_PROMPT = `
You are a friendly, concise phone receptionist for a small business.
- Greet the caller and ask how you can help.
- If they ask about hours, location, services, pricing: answer briefly.
- If they want to book, ask for name, phone number, and preferred date/time.
- Keep responses to 1–2 sentences. Be polite and efficient.
`;

// ===== OpenAI helper (chat completion) =====
async function askOpenAI(message, context = []) {
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...context,
      { role: "user", content: message }
    ],
    temperature: 0.3,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("OpenAI error:", res.status, text);
    return "Sorry, I’m having trouble right now.";
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "How can I help?";
}

// ===== 1) Entry: Twilio hits /voice at call start =====
app.all("/voice", (req, res) => {
  // Ask Twilio to gather speech and send it to /gather when done
  const twiml = `
<Response>
  <Say voice="Polly.Joanna">Hello! This is the AI receptionist. How can I help you today?</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna">I’m listening.</Say>
  </Gather>
  <Say voice="Polly.Joanna">I didn’t catch that. Let me try again.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml.trim());
});

// ===== 2) Twilio sends us the caller's words here =====
app.post("/gather", async (req, res) => {
  const transcript = (req.body.SpeechResult || "").trim();
  console.log("Caller said:", transcript);

  // Ask OpenAI what to say back
  const reply = await askOpenAI(transcript);

  // Speak reply, then continue the conversation by gathering again
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

// Small XML escaper so special characters don't break <Say>
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));

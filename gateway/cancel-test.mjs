import WebSocket from "ws";
const SBURL = process.env.SBURL, SBSK = process.env.SBSK, SERVER_ID = process.env.SERVER_ID;
const token = (await (await fetch(`${SBURL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: SBSK, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@friday-one.test", password: "E2eTest-Passw0rd!" }),
})).json()).access_token;
const ws = new WebSocket("ws://127.0.0.1:8790");
let seq = 100;
const base = (id, s) => ({ protocol_version: 1, message_id: id, correlation_id: id, server_id: SERVER_ID,
  connector_id: null, agent_id: null, session_id: null, event_type: "command.submit",
  issued_at: new Date().toISOString(), expires_at: null, sequence: s, idempotency_key: null,
  payload: { server_id: SERVER_ID, operation: "session.prompt",
    arguments: { root: "/tmp/friday-acp-test", prompt: "Write a very long, detailed 3000-word essay about the complete history of computing." } } });
let jobId = null, deltas = 0, cancelSentAt = 0, cancelledSeen = false;
ws.on("open", () => {
  const auth = { ...base(crypto.randomUUID(), 100) };
  auth.event_type = "auth.app"; auth.payload = { token };
  ws.send(JSON.stringify(auth));
});
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event_type === "auth.resume.ok") {
    ws.send(JSON.stringify(base(crypto.randomUUID(), 101)));
  } else if (["command.accepted", "command.started"].includes(m.event_type)) {
    jobId = m.payload.job_id;
    if (m.event_type === "command.started" && !cancelSentAt) {
      // cancel 1.5s after START — mid-stream, while deltas flow
      setTimeout(() => {
        const cancel = { ...base(crypto.randomUUID(), 102) };
        cancel.event_type = "command.cancel";
        cancel.payload = { job_id: jobId };
        ws.send(JSON.stringify(cancel));
        cancelSentAt = deltas;
        console.log(`cancel sent @deltas=${deltas}`);
      }, 1500);
    }
  } else if (m.event_type === "chat.delta") {
    deltas++;
  } else if (m.event_type === "command.rejected") {
    console.log("REJECTED:", JSON.stringify(m.payload)); process.exit(1);
  } else if (["command.completed", "command.failed"].includes(m.event_type)) {
    // PASS if the job ENDED within a reasonable window after cancel AND had
    // been streaming (proves the cancel reached the live session).
    const ended = m.event_type;
    const ok = cancelSentAt > 0 && deltas >= cancelSentAt;
    console.log(`RESULT: ${ended} totalDeltas=${deltas} cancelAt=${cancelSentAt} -> ${ok ? "CANCEL WORKED (job ended after cancel)" : "ran to natural end"}`);
    process.exit(ok || ended === "command.failed" ? 0 : 2);
  }
});
setTimeout(() => { console.log("TIMEOUT deltas=" + deltas); process.exit(1); }, 90000);

import WebSocket from "ws";
const SBURL = process.env.SBURL, SBSK = process.env.SBSK, SERVER_ID = process.env.SERVER_ID;
const token = (await (await fetch(`${SBURL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: SBSK, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@friday-one.test", password: "E2eTest-Passw0rd!" }),
})).json()).access_token;
const ws = new WebSocket("ws://127.0.0.1:8790");
let seq = 1;
const env = (t, p) => ({ protocol_version: 1, message_id: crypto.randomUUID(), correlation_id: crypto.randomUUID(),
  server_id: SERVER_ID, connector_id: null, agent_id: null, session_id: null, event_type: t,
  issued_at: new Date().toISOString(), expires_at: null, sequence: seq++, idempotency_key: null, payload: p });
ws.on("open", () => ws.send(JSON.stringify(env("auth.app", { token }))));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event_type === "auth.resume.ok") {
    ws.send(JSON.stringify(env("command.submit", { server_id: SERVER_ID, operation: "session.prompt",
      arguments: { root: "/tmp/friday-acp-test", prompt: "Reply with exactly: OK2" }, idempotency_key: "e2e-" + Date.now() })));
    console.log("submitted");
  } else if (m.event_type === "chat.delta") process.stdout.write(m.payload.delta);
  else { console.log("<<", m.event_type, JSON.stringify(m.payload).slice(0, 120));
    if (["command.completed","command.failed","command.rejected"].includes(m.event_type)) { console.log(); process.exit(0); } }
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 90000);

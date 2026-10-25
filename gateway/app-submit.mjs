// App-side E2E: authenticate like the Android app will, submit a prompt
// command, and print the full lifecycle back from the connector.
import WebSocket from "ws";

const SBURL = process.env.SBURL;
const SBSK = process.env.SBSK;
const token = await (await fetch(`${SBURL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: SBSK, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@friday-one.test", password: "E2eTest-Passw0rd!" }),
})).json();
console.log("app auth:", token.access_token ? "ok" : JSON.stringify(token).slice(0, 120));

const ws = new WebSocket("ws://127.0.0.1:8790");
const send = (env) => ws.send(JSON.stringify(env));
let seq = 1;
const env = (event_type, payload) => ({
  protocol_version: 1, message_id: crypto.randomUUID(), correlation_id: crypto.randomUUID(),
  server_id: process.env.SERVER_ID, connector_id: null, agent_id: null, session_id: null,
  event_type, issued_at: new Date().toISOString(), expires_at: null, sequence: seq++,
  idempotency_key: null, payload,
});
let msgId = null;
ws.on("open", () => send(env("auth.app", { token: token.access_token })));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event_type === "auth.resume.ok") {
    msgId = crypto.randomUUID();
    send(env2(msgId, "command.submit", {
      server_id: process.env.SERVER_ID,
      operation: "session.prompt",
      arguments: { root: "/tmp/friday-acp-test", prompt: process.env.PROMPT },
      idempotency_key: "e2e-" + Date.now(),
    }));
    console.log("command.submit sent");
    return;
  }
  if (m.event_type === "chat.delta") {
    process.stdout.write(m.payload.delta);
    return;
  }
  console.log("<<", m.event_type, JSON.stringify(m.payload).slice(0, 160));
  if (["command.completed", "command.failed", "command.rejected"].includes(m.event_type)) {
    console.log();
    process.exit(m.event_type === "command.completed" ? 0 : 1);
  }
});
function env2(id, event_type, payload) {
  return { protocol_version: 1, message_id: id, correlation_id: crypto.randomUUID(),
    server_id: process.env.SERVER_ID, connector_id: null, agent_id: null, session_id: null,
    event_type, issued_at: new Date().toISOString(), expires_at: null, sequence: seq++,
    idempotency_key: null, payload };
}
setTimeout(() => { console.log("\nTIMEOUT"); process.exit(1); }, 120000);

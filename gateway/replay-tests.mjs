import WebSocket from "ws";
const SBURL = process.env.SBURL, SBSK = process.env.SBSK, SERVER_ID = process.env.SERVER_ID;
const token = (await (await fetch(`${SBURL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: SBSK, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@friday-one.test", password: "E2eTest-Passw0rd!" }),
})).json()).access_token;
const mode = process.env.MODE;
const ws = new WebSocket("ws://127.0.0.1:8790");
let seq = 100;
const mk = (id, s) => JSON.stringify({ protocol_version: 1, message_id: id, correlation_id: crypto.randomUUID(),
  server_id: SERVER_ID, connector_id: null, agent_id: null, session_id: null, event_type: "command.submit",
  issued_at: new Date().toISOString(), expires_at: null, sequence: s, idempotency_key: "audit-" + id.slice(0,8),
  payload: { server_id: SERVER_ID, operation: "session.prompt", arguments: { root: "/tmp/friday-acp-test", prompt: "Reply with exactly: OK" } } });
let accepted = 0, deltas = 0, completed = 0, failed = 0, rejected = 0;
ws.on("open", () => {
  const auth = JSON.parse(mk(crypto.randomUUID(), 100));
  auth.event_type = "auth.app"; auth.payload = { token };
  ws.send(JSON.stringify(auth));
});
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event_type === "auth.resume.ok") {
    if (mode === "dup") {
      const id = crypto.randomUUID();
      ws.send(mk(id, 101)); ws.send(mk(id, 101)); // identical replay pair
      setTimeout(() => {
        const pass = accepted === 1; // exactly ONE submit accepted; replay dropped
        console.log(`dup: accepted=${accepted} completed=${completed} -> ${pass ? "PASS" : "FAIL"}`);
        process.exit(pass ? 0 : 1);
      }, 15000);
    } else if (mode === "stale") {
      ws.send(mk(crypto.randomUUID(), 90)); // below baseline 100
    } else if (mode === "valid") {
      ws.send(mk(crypto.randomUUID(), 101)); // above baseline
    }
  } else if (m.event_type === "command.accepted") accepted++;
  else if (m.event_type === "chat.delta") deltas++;
  else if (m.event_type === "command.completed") completed++;
  else if (m.event_type === "command.failed") failed++;
  else if (m.event_type === "command.rejected") rejected++;
});
ws.on("close", (c) => {
  if (mode === "stale") { console.log(`stale: closed=${c} -> ${c === 4400 ? "PASS" : "FAIL"}`); process.exit(c === 4400 ? 0 : 1); }
  console.log(`closed early: ${c}`);
});
setTimeout(() => { console.log("TIMEOUT", {accepted, deltas, completed, failed, rejected}); process.exit(1); }, 20000);

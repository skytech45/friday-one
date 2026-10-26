import WebSocket from "ws";
const SBURL = process.env.SBURL, SBSK = process.env.SBSK, SERVER_ID = process.env.SERVER_ID;
const mode = process.env.MODE;

if (mode === "malformed") {
  const ws = new WebSocket("ws://127.0.0.1:8790");
  ws.on("open", () => ws.send("not json {{{"));
  ws.on("close", (c) => { console.log("malformed -> close:", c); process.exit(c === 4400 ? 0 : 1); });
  setTimeout(() => { console.log("NO CLOSE"); process.exit(1); }, 5000);
} else {
  const r = await fetch(`${SBURL}/auth/v1/token?grant_type=password`, { method: "POST",
    headers: { apikey: SBSK, "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@friday-one.test", password: "E2eTest-Passw0rd!" }) });
  const token = (await r.json()).access_token;
  const ws = new WebSocket("ws://127.0.0.1:8790");
  let seq = 1;
  const env = (t, p, idem) => ({ protocol_version: 1, message_id: crypto.randomUUID(), correlation_id: crypto.randomUUID(),
    server_id: SERVER_ID, connector_id: null, agent_id: null, session_id: null, event_type: t,
    issued_at: new Date().toISOString(), expires_at: null, sequence: seq++, idempotency_key: idem, payload: p });
  ws.on("open", () => ws.send(JSON.stringify(env("auth.app", { token }))));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.event_type === "auth.resume.ok") {
      if (mode === "replay") {
        const idem = "audit-replay-key";
        ws.send(JSON.stringify(env("command.submit", { server_id: SERVER_ID, operation: "session.prompt",
          arguments: { root: "/tmp/friday-acp-test", prompt: "x" }, idempotency_key: idem }, idem)));
        setTimeout(() => ws.send(JSON.stringify(env("command.submit", { server_id: SERVER_ID,
          operation: "session.prompt", arguments: { root: "/tmp/friday-acp-test", prompt: "x" },
          idempotency_key: idem }, idem))), 400);
      }
    } else if (["command.rejected","command.failed"].includes(m.event_type)) {
      console.log(mode, "->", m.event_type, JSON.stringify(m.payload).slice(0, 70)); process.exit(0);
    }
  });
  setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 15000);
}

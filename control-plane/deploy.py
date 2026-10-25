#!/usr/bin/env python3
"""Deploy the control plane to Vercel via the REST API.

The vck_ API key works with api.vercel.com but not with the CLI's auth, so
this script does what `vercel --prod` would: create/link the project, sync
env vars, then POST a full-file deployment and wait for READY.

Usage: python3 deploy.py [--token-file ~/.config/friday-cloud/vercel.json]
"""
import json
import pathlib
import sys
import time
import urllib.request

API = "https://api.vercel.com"
ROOT = pathlib.Path(__file__).resolve().parent

FILES = [
    "package.json",
    "vercel.json",
    "api/v1/health.ts",
    "api/v1/servers/index.ts",
    "api/v1/servers/[id]/revoke.ts",
    "api/v1/enrollments/index.ts",
    "api/v1/enrollments/session.ts",
    "api/v1/enrollments/[id]/claim.ts",
    "lib/env.ts",
    "lib/util.ts",
    "lib/auth.ts",
    "lib/supabase.ts",
    "lib/enrollments.ts",
]

ENV_VARS = {
    "SUPABASE_URL": "supabase_url",
    "SUPABASE_SECRET_KEY": "supabase_secret_key",
    "SUPABASE_JWKS_URL": "supabase_jwks_url",
}


def api(method: str, path: str, token: str, body: dict | None = None, team: str | None = None):
    url = f"{API}{path}"
    if team:
        url += ("&" if "?" in url else "?") + f"teamId={team}"
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main() -> None:
    token_file = pathlib.Path.home() / ".config/friday-cloud/vercel.json"
    cfg = json.loads(token_file.read_text())
    token = cfg["token"]
    user = api("GET", "/v2/user", token)[1]["user"]
    team = cfg.get("teamId") if cfg.get("teamId") else None
    name = "friday-one-control-plane"
    print(f"account: {user['username']} (limited={user.get('limited')})")

    # 1. ensure project
    status, proj = api("GET", f"/v9/projects/{name}", token, team=team)
    if status == 404:
        status, proj = api("POST", "/v9/projects", token, {"name": name}, team=team)
        print(f"project created: {proj.get('id')}")
    else:
        print(f"project exists: {proj.get('id')}")

    # 2. sync env vars (upsert; a 409 means it exists — update instead)
    for key, cfg_key in ENV_VARS.items():
        value = cfg[cfg_key]
        s, _ = api("POST", f"/v9/projects/{proj['id']}/env", token,
                   {"key": key, "value": value, "type": "encrypted",
                    "target": ["production"], "gitBranchEnabled": False}, team=team)
        if s in (200, 201):
            print(f"env {key}: created")
        else:
            s2, _ = api("PATCH", f"/v9/projects/{proj['id']}/env/{key}", token,
                        {"value": value, "target": ["production"]}, team=team)
            print(f"env {key}: {'updated' if s2 in (200, 201) else f'error {s2}'}")

    # 3. deployment (inline files)
    files = [{"file": f, "data": (ROOT / f).read_text(), "encoding": "utf-8"} for f in FILES]
    status, dep = api("POST", "/v13/deployments", token,
                      {
                          "name": name,
                          "target": "production",
                          "files": files,
                          "projectSettings": {"framework": None},
                      }, team=team)
    if status not in (200, 202):
        print(f"deployment rejected: {status} {dep}")
        sys.exit(1)
    dep_id = dep["id"]
    print(f"deployment: {dep.get('url')} ({dep_id})")

    # 4. wait for READY (max ~3 min)
    for _ in range(60):
        s, d = api("GET", f"/v13/deployments/{dep_id}", token, team=team)
        state = d.get("readyState")
        print(f"  state: {state}")
        if state == "READY":
            print(f"LIVE: https://{d['url']}/api/v1/health")
            return
        if state in ("ERROR", "CANCELED"):
            print("deployment failed:", json.dumps(d.get("builds") or d)[:1500])
            sys.exit(1)
        time.sleep(3)
    print("timed out waiting for deployment")
    sys.exit(1)


if __name__ == "__main__":
    main()

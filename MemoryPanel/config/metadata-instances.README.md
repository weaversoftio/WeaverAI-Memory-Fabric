# metadata-instances.json fields (new stateless panel)

| Field | Required | Description |
|------|------|------|
| `id` | yes | = `instance_id` = the kernel's `x-wamf-service-id`; locally usually `default`, online `mem-{slug}` |
| `name` | yes | Display name on the login page; exposed **only** through `GET /api/v1/meta/instances` |
| `gateway_endpoint` | yes | Memory Gateway root URL; locally `http://127.0.0.1:8420`. **The Panel backend → Kernel forwarding address — don't use it to point at the proxy** |
| `proxy_endpoint` | no | Client base URL (CodeBuddy / Claude Code CLI, etc.). Used **only** to build the panel's "client connection" card. Falls back to `gateway_endpoint` when missing (old behaviour). In online deployments where the gateway sits behind the proxy the two are the same and this can be omitted; in the local open-source deploy, where core and proxy run separately, set the proxy's external address here (e.g. `http://127.0.0.1:8096`) |
| `api_key` | yes | Gateway Bearer; used **only** for server-side forwarding, **never** returned by the instances API |

## Local file (contains secrets, not committed)

```bash
cp config/metadata-instances.example.json config/metadata-instances.json
# then fill in gateway_endpoint / api_key for your local Gateway
```

`config/metadata-instances.json` is in `.gitignore`; the repository only keeps `metadata-instances.example.json`.

> **Upgrade note**: before your first pull of the commit that removed this file from the repository, back up your local `metadata-instances.json`; if the pull deletes it, restore it from the backup, or copy the example again as above and fill in the key.

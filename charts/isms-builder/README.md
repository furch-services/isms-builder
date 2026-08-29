# isms-builder Helm chart

Deploys [ISMS Builder](https://github.com/coolstartnow/isms-builder) — a
self-hosted ISMS platform (ISO 27001, NIS2, GDPR/DSGVO, BSI IT-Grundschutz) —
onto a Kubernetes cluster, including a bundled PostgreSQL database by default.

## Quick start

```bash
helm repo add groundhog2k https://groundhog2k.github.io/helm-charts/
helm dependency build charts/isms-builder
helm install my-isms charts/isms-builder \
  --namespace isms --create-namespace
```

This installs with the bundled PostgreSQL subchart enabled, a single replica,
and no Ingress (use `kubectl port-forward` to reach it — see the printed
NOTES). Log in with `admin@example.com` / `adminpass` and change the password
immediately (see NOTES.txt output after install).

## Common overrides

Expose via Ingress with TLS terminated there:

```bash
helm install my-isms charts/isms-builder \
  --set ingress.enabled=true \
  --set ingress.host=isms.example.com \
  --set ingress.className=nginx \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=isms-tls \
  --set ingress.annotations."cert-manager\.io/cluster-issuer"=letsencrypt-prod
```

Terminate TLS inside the pod instead (mount your own cert/key Secret):

```bash
helm install my-isms charts/isms-builder \
  --set tls.inPod.enabled=true \
  --set tls.inPod.secretName=my-tls-secret
```

Use an external PostgreSQL/MariaDB instead of the bundled one:

```bash
helm install my-isms charts/isms-builder \
  --set postgresql.enabled=false \
  --set storageBackend=postgres \
  --set database.external.host=my-postgres.example.com \
  --set database.external.existingSecret=my-db-secret   # must contain key DB_PASS
```

Scale beyond one replica (only supported with a SQL backend):

```bash
helm upgrade my-isms charts/isms-builder \
  --set storageBackend=postgres \
  --set replicaCount=3
```

Installing with `replicaCount > 1` against `storageBackend: json` or
`storageBackend: sqlite` is rejected at render time — those backends are
file-based with no cross-pod locking.

## Values

See [`values.yaml`](values.yaml) for the full, commented list. Key sections:

| Key | Purpose |
|---|---|
| `image.repository` / `.tag` | Which container image to run. Defaults to the upstream project's GHCR image — override to your own fork's image (e.g. while testing changes before opening a PR upstream). |
| `storageBackend` | `json` \| `sqlite` \| `mariadb` \| `postgres` — same values as the app's `STORAGE_BACKEND` env var. |
| `postgresql.*` | Bundled PostgreSQL (via the [groundhog2k/postgres](https://github.com/groundhog2k/helm-charts/tree/master/charts/postgres) subchart). Set `postgresql.enabled: false` to use `database.external.*` instead. |
| `persistence.*` | PVC for uploads (and JSON/SQLite app state, if used) — `ReadWriteMany` by default so multiple replicas can share it. |
| `ingress.*` / `tls.inPod.*` | Two mutually exclusive ways to expose HTTPS — Ingress-terminated or in-pod. |
| `auth.jwtSecret.existingSecret` | Bring your own JWT secret; otherwise one is generated on first install and kept stable across upgrades. |
| `smtp.*` / `ollama.*` | Both fully optional — the app degrades gracefully without either. |

## Fork testing (before opening an upstream PR)

Point `image.repository` at your own GHCR namespace and, once the chart is
packaged and pushed there too, install straight from your fork's registry:

```bash
# after building/pushing your own image, see the repo's release workflow
helm package charts/isms-builder -d dist/
helm push dist/isms-builder-*.tgz oci://ghcr.io/<your-github-user>/isms-builder/charts
helm install my-isms oci://ghcr.io/<your-github-user>/isms-builder/charts/isms-builder \
  --set image.repository=ghcr.io/<your-github-user>/isms-builder
```

## Known limitations

- Demo content (as opposed to demo user accounts) is only loaded correctly
  under `storageBackend: json` today — see NOTES.txt after install.
- No `/health` endpoint exists yet; probes reuse `/ui/login.html` (the same
  path the project's own Docker `HEALTHCHECK` already polls).
- A fresh install against a brand-new, empty database has a very small
  theoretical race window if `replicaCount > 1` from the very first boot —
  start with 1 replica and scale up after the first successful startup.

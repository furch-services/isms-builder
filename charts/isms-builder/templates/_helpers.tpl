{{/*
Expand the name of the chart.
*/}}
{{- define "isms-builder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "isms-builder.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "isms-builder.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "isms-builder.labels" -}}
helm.sh/chart: {{ include "isms-builder.chart" . }}
{{ include "isms-builder.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "isms-builder.selectorLabels" -}}
app.kubernetes.io/name: {{ include "isms-builder.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "isms-builder.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "isms-builder.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Normalizes the app-level storageBackend aliases the chart must otherwise
reject or silently mishandle: the app (server/db/knexDatabase.js) and the
project README both treat "pg" as an alias for "postgres" and "mysql" as an
alias for "mariadb". Everywhere the chart compares against the canonical
backend names, it must go through this helper instead of
.Values.storageBackend directly, or an alias would either fail validation
with a confusing message (postgresql.enabled check) or silently skip all
DB_* wiring (the $needsExternalDb / configmap.yaml / deployment.yaml guards).
*/}}
{{- define "isms-builder.storageBackend" -}}
{{- if eq .Values.storageBackend "pg" -}}
postgres
{{- else if eq .Values.storageBackend "mysql" -}}
mariadb
{{- else -}}
{{- .Values.storageBackend -}}
{{- end -}}
{{- end }}

{{/*
── Validation guards ────────────────────────────────────────────────────────
Fail fast with a clear message instead of deploying a configuration that is
silently unsafe or contradictory.
*/}}
{{- define "isms-builder.validate" -}}
{{- $backend := include "isms-builder.storageBackend" . }}
{{- if and (gt (int .Values.replicaCount) 1) (or (eq $backend "json") (eq $backend "sqlite")) }}
{{- fail (printf "replicaCount > 1 requires storageBackend \"postgres\" or \"mariadb\" — %q is file-based with no cross-pod locking (see server/rbacStore.js and server/ai/embeddingStore.js for why this matters)." .Values.storageBackend) }}
{{- end }}
{{- /* A PVC's accessModes are immutable in Kubernetes — this chart cannot
   silently switch an existing ReadWriteOnce PVC to ReadWriteMany on
   `helm upgrade --set replicaCount=N`, so require the operator to opt in
   explicitly up front rather than trying to auto-derive it from
   replicaCount and hitting an API-server rejection on scale-up. */}}
{{- if and (gt (int .Values.replicaCount) 1) (ne .Values.persistence.accessMode "ReadWriteMany") }}
{{- fail "replicaCount > 1 requires persistence.accessMode: ReadWriteMany, set explicitly — a PVC's accessModes are immutable in Kubernetes, so this cannot be changed automatically on `helm upgrade`. If you already installed with ReadWriteOnce, you will need to provision a new ReadWriteMany-capable PVC (e.g. via persistence.existingClaim) rather than resizing the existing one in place." }}
{{- end }}
{{- if and .Values.postgresql.enabled (ne $backend "postgres") }}
{{- fail (printf "postgresql.enabled: true requires storageBackend: postgres (got %q). Either set storageBackend: postgres, or disable the bundled database and point database.external.* at your own." .Values.storageBackend) }}
{{- end }}
{{- $needsExternalDb := or (eq $backend "postgres") (eq $backend "mariadb") }}
{{- if and (not .Values.postgresql.enabled) $needsExternalDb (not .Values.database.external.host) }}
{{- fail "postgresql.enabled: false requires database.external.host to be set (or storageBackend: json/sqlite, which need no external database)." }}
{{- end }}
{{- if and (not .Values.postgresql.enabled) $needsExternalDb (not .Values.database.external.existingSecret) }}
{{- fail "postgresql.enabled: false with storageBackend postgres/mariadb requires database.external.existingSecret to be set (must contain key DB_PASS)." }}
{{- end }}
{{- if and .Values.ingress.tls.enabled .Values.tls.inPod.enabled }}
{{- fail "ingress.tls.enabled and tls.inPod.enabled are mutually exclusive — TLS is terminated either at the Ingress or in the pod, not both." }}
{{- end }}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "ingress.enabled: true requires ingress.host to be set." }}
{{- end }}
{{- if and .Values.tls.inPod.enabled (not .Values.tls.inPod.secretName) }}
{{- fail "tls.inPod.enabled: true requires tls.inPod.secretName to be set (a Kubernetes TLS secret containing tls.crt and tls.key)." }}
{{- end }}
{{- end }}

{{/*
── Database connection helpers ──────────────────────────────────────────────
Resolve host/port/name/user/secret depending on whether the bundled
postgres subchart or an external database is in use.
*/}}
{{- define "isms-builder.dbHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- /* The dependency is aliased "postgresql" in Chart.yaml, which the
   subchart's own fullname template picks up as its .Chart.Name — verified
   by rendering: the Service actually comes out as "<release>-postgresql". */ -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else -}}
{{- .Values.database.external.host -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbPort" -}}
{{- if .Values.postgresql.enabled -}}
5432
{{- else -}}
{{- .Values.database.external.port | default 5432 -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbName" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.name.value -}}
{{- else -}}
{{- .Values.database.external.name -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbUser" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.user.value -}}
{{- else -}}
{{- .Values.database.external.user -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbSecretName" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.existingSecret -}}
{{- else -}}
{{- .Values.database.external.existingSecret -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbSecretPasswordKey" -}}
{{- if .Values.postgresql.enabled -}}
USERDB_PASSWORD
{{- else -}}
DB_PASS
{{- end -}}
{{- end }}

{{- define "isms-builder.jwtSecretName" -}}
{{- if .Values.auth.jwtSecret.existingSecret -}}
{{- .Values.auth.jwtSecret.existingSecret -}}
{{- else -}}
{{- printf "%s-jwt" (include "isms-builder.fullname" .) -}}
{{- end -}}
{{- end }}
